use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::types::ToSql;
use rusqlite::{params, params_from_iter, Connection};

use crate::app_paths;
use crate::commands::library::now_ts;
use crate::db;
use crate::models::{Book, Shelf};

pub(crate) const TRASH_RETENTION_KEY: &str = "trash_retention_days";
pub(crate) const TRASH_RETENTION_DEFAULT_DAYS: i64 = 30;

fn fetch_shelf(conn: &Connection, id: i64) -> Result<Shelf, String> {
    conn.query_row(
        "SELECT id, name, parent_id, sort_order, created_at FROM shelves WHERE id = ?1",
        [id],
        |row| {
            Ok(Shelf {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                sort_order: row.get(3)?,
                created_at: row.get(4)?,
            })
        },
    )
    .map_err(|_| format!("书架 {id} 不存在"))
}

fn parent_of(conn: &Connection, id: i64) -> Result<Option<i64>, String> {
    conn.query_row("SELECT parent_id FROM shelves WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|_| format!("书架 {id} 不存在"))
}

fn list_shelves_db(conn: &Connection) -> Result<Vec<Shelf>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT id, name, parent_id, sort_order, created_at FROM shelves ORDER BY sort_order, id")?;
    let rows = stmt.query_map([], |row| {
        Ok(Shelf {
            id: row.get(0)?,
            name: row.get(1)?,
            parent_id: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// 环检测：从 new_parent 沿 parent 链向上走，途经被移动书架本身即拒绝（含 new_parent == id）
fn ensure_not_own_descendant(conn: &Connection, id: i64, new_parent_id: i64) -> Result<(), String> {
    let mut cur = new_parent_id;
    for _ in 0..1000 {
        if cur == id {
            return Err("不能把书架移动到它自己或它的子书架下".to_string());
        }
        match parent_of(conn, cur)? {
            Some(p) => cur = p,
            None => return Ok(()),
        }
    }
    Err("书架层级过深或数据成环".to_string())
}

fn delete_shelf_db(conn: &Connection, id: i64) -> Result<(), String> {
    let shelf = fetch_shelf(conn, id)?;
    // 子树内所有书的 shelf_id 统一改挂到被删书架的父级（根书架则回根），随后整棵子树级联删除
    conn.execute(
        "WITH RECURSIVE sub(id) AS (SELECT ?1 UNION ALL SELECT s.id FROM shelves s JOIN sub ON s.parent_id = sub.id)
         UPDATE books SET shelf_id = ?2 WHERE shelf_id IN (SELECT id FROM sub)",
        params![id, shelf.parent_id],
    )
    .map_err(|e| format!("failed to reparent books: {e}"))?;
    conn.execute("DELETE FROM shelves WHERE id = ?1", [id])
        .map_err(|e| format!("failed to delete shelf: {e}"))?;
    Ok(())
}

fn shelf_exists(conn: &Connection, id: i64) -> Result<bool, String> {
    conn.query_row("SELECT 1 FROM shelves WHERE id = ?1", [id], |_| Ok(()))
        .map(|_| true)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(format!("failed to check shelf: {other}")),
        })
}

// IN (?,?,...) 占位符；ids 为空时调用方应直接短路
pub(crate) fn in_clause(n: usize) -> String {
    format!("({})", vec!["?"; n].join(","))
}

// 前置一个非字符串参数再拼 IN 列表（软删的 now / 移动的 shelf_id）
fn head_then_ids<T: ToSql + Clone + 'static>(head: T, ids: &[String]) -> Vec<Box<dyn ToSql>> {
    let mut values: Vec<Box<dyn ToSql>> = vec![Box::new(head)];
    for id in ids {
        values.push(Box::new(id.clone()));
    }
    values
}

fn soft_delete_books_db(conn: &Connection, ids: &[String], now: i64) -> Result<usize, rusqlite::Error> {
    let values = head_then_ids(now, ids);
    conn.execute(
        &format!(
            "UPDATE books SET deleted_at = ?1 WHERE deleted_at IS NULL AND id IN {}",
            in_clause(ids.len())
        ),
        params_from_iter(values.iter().map(|v| &**v)),
    )
}

fn restore_books_db(conn: &Connection, ids: &[String]) -> Result<usize, rusqlite::Error> {
    conn.execute(
        &format!("UPDATE books SET deleted_at = NULL WHERE id IN {}", in_clause(ids.len())),
        params_from_iter(ids.iter()),
    )
}

fn list_trash_db(conn: &Connection) -> Result<Vec<Book>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, cover_path, library_path, added_at, last_opened_at,
                is_favorite, note, pinned_at, format, page_count, shelf_id, sort_order, deleted_at
         FROM books WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            cover_path: row.get(3)?,
            library_path: row.get(4)?,
            added_at: row.get(5)?,
            last_opened_at: row.get(6)?,
            is_favorite: row.get(7)?,
            note: row.get(8)?,
            pinned_at: row.get(9)?,
            format: row.get(10)?,
            page_count: row.get(11)?,
            shelf_id: row.get(12)?,
            sort_order: row.get(13)?,
            deleted_at: row.get(14)?,
            reading_percent: None,
            description: None,
            content_chars: None,
            file_size: None,
            tags: Vec::new(),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// 硬删单本：删复制入库的文件（library/ 相对路径）与封面；文件夹引用书不动源目录。文件失败不阻断 DB 清理。
fn purge_book(conn: &Connection, library_root: &Path, book_id: &str) -> Result<(), String> {
    let row: (String, Option<String>) = conn
        .query_row("SELECT library_path, cover_path FROM books WHERE id = ?1", [book_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|_| format!("书 {book_id} 不存在"))?;

    let to_abs = |rel: &str| -> Option<PathBuf> {
        let v = rel.replace('\\', "/");
        // 仅删库内文件：绝对路径是原地引用的漫画文件夹，不碰源
        v.strip_prefix("library/").map(|rest| library_root.join(rest))
    };
    if let Some(abs) = to_abs(&row.0) {
        let _ = fs::remove_file(&abs);
    }
    if let Some(abs) = row.1.as_deref().and_then(to_abs) {
        let _ = fs::remove_file(&abs);
    }

    conn.execute("DELETE FROM books WHERE id = ?1", [book_id])
        .map_err(|e| format!("failed to delete book: {e}"))?;
    Ok(())
}

// init 自动清理：保留期内到期的回收站书执行 purge；0=永不
pub(crate) fn purge_expired_trash(conn: &Connection, data_dir: &Path, now: i64) -> Result<(), String> {
    let retention: i64 = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [TRASH_RETENTION_KEY], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(TRASH_RETENTION_DEFAULT_DAYS);
    if retention <= 0 {
        return Ok(());
    }
    let cutoff = now - retention * 86400;
    let expired: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM books WHERE deleted_at IS NOT NULL AND deleted_at < ?1")
            .map_err(|e| format!("failed to prepare trash purge: {e}"))?;
        let rows = stmt
            .query_map([cutoff], |r| r.get::<_, String>(0))
            .map_err(|e| format!("failed to query trash purge: {e}"))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for id in expired {
        purge_book(conn, data_dir, &id)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_shelves(app: tauri::AppHandle) -> Result<Vec<Shelf>, String> {
    let conn = db::open_db(&app)?;
    list_shelves_db(&conn).map_err(|e| format!("failed to list shelves: {e}"))
}

#[tauri::command]
pub fn create_shelf(app: tauri::AppHandle, name: String, parent_id: Option<i64>) -> Result<Shelf, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("书架名称不能为空".to_string());
    }
    let conn = db::open_db(&app)?;
    if let Some(pid) = parent_id {
        if !shelf_exists(&conn, pid)? {
            return Err(format!("书架 {pid} 不存在"));
        }
    }
    let next_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM shelves WHERE parent_id IS ?1",
            params![parent_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("failed to compute shelf order: {e}"))?;
    conn.execute(
        "INSERT INTO shelves (name, parent_id, sort_order, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![name, parent_id, next_order, now_ts()],
    )
    .map_err(|e| format!("failed to create shelf: {e}"))?;
    let id = conn.last_insert_rowid();
    fetch_shelf(&conn, id)
}

#[tauri::command]
pub fn rename_shelf(app: tauri::AppHandle, id: i64, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("书架名称不能为空".to_string());
    }
    let conn = db::open_db(&app)?;
    let n = conn
        .execute("UPDATE shelves SET name = ?2 WHERE id = ?1", params![id, name])
        .map_err(|e| format!("failed to rename shelf: {e}"))?;
    if n == 0 {
        return Err(format!("书架 {id} 不存在"));
    }
    Ok(())
}

#[tauri::command]
pub fn move_shelf(app: tauri::AppHandle, id: i64, new_parent_id: Option<i64>) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    fetch_shelf(&conn, id)?;
    if let Some(pid) = new_parent_id {
        ensure_not_own_descendant(&conn, id, pid)?;
    }
    conn.execute("UPDATE shelves SET parent_id = ?2 WHERE id = ?1", params![id, new_parent_id])
        .map_err(|e| format!("failed to move shelf: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_shelf(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    delete_shelf_db(&conn, id)
}

#[tauri::command]
pub fn set_shelf_order(app: tauri::AppHandle, ids: Vec<i64>) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    for (idx, id) in ids.iter().enumerate() {
        conn.execute("UPDATE shelves SET sort_order = ?2 WHERE id = ?1", params![id, idx as i64])
            .map_err(|e| format!("failed to set shelf order: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn move_books_to_shelf(app: tauri::AppHandle, book_ids: Vec<String>, shelf_id: Option<i64>) -> Result<(), String> {
    if book_ids.is_empty() {
        return Ok(());
    }
    let conn = db::open_db(&app)?;
    if let Some(sid) = shelf_id {
        if !shelf_exists(&conn, sid)? {
            return Err(format!("书架 {sid} 不存在"));
        }
    }
    let values = head_then_ids(shelf_id, &book_ids);
    conn.execute(
        &format!(
            "UPDATE books SET shelf_id = ?1, sort_order = NULL WHERE id IN {}",
            in_clause(book_ids.len())
        ),
        params_from_iter(values.iter().map(|v| &**v)),
    )
    .map_err(|e| format!("failed to move books: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn set_books_order(app: tauri::AppHandle, book_ids: Vec<String>) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    for (idx, id) in book_ids.iter().enumerate() {
        conn.execute("UPDATE books SET sort_order = ?2 WHERE id = ?1", params![id, idx as i64])
            .map_err(|e| format!("failed to set book order: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_books(app: tauri::AppHandle, book_ids: Vec<String>) -> Result<(), String> {
    if book_ids.is_empty() {
        return Ok(());
    }
    let conn = db::open_db(&app)?;
    soft_delete_books_db(&conn, &book_ids, now_ts())
        .map_err(|e| format!("failed to delete books: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn restore_books(app: tauri::AppHandle, book_ids: Vec<String>) -> Result<(), String> {
    if book_ids.is_empty() {
        return Ok(());
    }
    let conn = db::open_db(&app)?;
    restore_books_db(&conn, &book_ids).map_err(|e| format!("failed to restore books: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn purge_books(app: tauri::AppHandle, book_ids: Vec<String>) -> Result<(), String> {
    if book_ids.is_empty() {
        return Ok(());
    }
    let conn = db::open_db(&app)?;
    let library_root = app_paths::library_dir(&app)?;
    for id in book_ids {
        purge_book(&conn, &library_root, &id)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_trash(app: tauri::AppHandle) -> Result<Vec<Book>, String> {
    let conn = db::open_db(&app)?;
    list_trash_db(&conn).map_err(|e| format!("failed to list trash: {e}"))
}

#[tauri::command]
pub fn set_trash_retention_days(app: tauri::AppHandle, days: i64) -> Result<(), String> {
    if days < 0 {
        return Err("保留期不能为负数".to_string());
    }
    let conn = db::open_db(&app)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![TRASH_RETENTION_KEY, days.to_string()],
    )
    .map_err(|e| format!("failed to set trash retention: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        conn
    }

    fn add_book(conn: &Connection, id: &str, shelf: Option<i64>) {
        conn.execute(
            "INSERT INTO books (id, title, library_path, added_at, shelf_id) VALUES (?1, ?2, ?3, 1, ?4)",
            params![id, format!("t{id}"), format!("library/books/{id}.epub"), shelf],
        )
        .unwrap();
    }

    fn add_shelf(conn: &Connection, name: &str, parent: Option<i64>) -> i64 {
        conn.execute(
            "INSERT INTO shelves (name, parent_id, sort_order, created_at) VALUES (?1, ?2, 0, 1)",
            params![name, parent],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn move_shelf_rejects_own_descendant() {
        let conn = setup();
        let a = add_shelf(&conn, "A", None);
        let b = add_shelf(&conn, "B", Some(a));

        assert_eq!(
            ensure_not_own_descendant(&conn, a, a).unwrap_err(),
            "不能把书架移动到它自己或它的子书架下"
        );
        assert_eq!(
            ensure_not_own_descendant(&conn, a, b).unwrap_err(),
            "不能把书架移动到它自己或它的子书架下"
        );
        // 挂到根、挂到无关书架都放行
        let c = add_shelf(&conn, "C", None);
        assert!(ensure_not_own_descendant(&conn, a, c).is_ok());
    }

    #[test]
    fn delete_shelf_reparents_books_and_cascades_children() {
        let conn = setup();
        let a = add_shelf(&conn, "A", None);
        let b = add_shelf(&conn, "B", Some(a));
        add_book(&conn, "b1", Some(a));
        add_book(&conn, "b2", Some(b));

        delete_shelf_db(&conn, a).unwrap();

        let shelves = list_shelves_db(&conn).unwrap();
        assert!(shelves.is_empty()); // 子书架级联删
        let shelves_of: Vec<Option<i64>> = ["b1", "b2"]
            .iter()
            .map(|id| {
                conn.query_row("SELECT shelf_id FROM books WHERE id = ?1", [*id], |r| r.get(0))
                    .unwrap()
            })
            .collect();
        assert_eq!(shelves_of, vec![None, None]); // 都回到根，书保留
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn delete_shelf_moves_books_to_its_parent() {
        let conn = setup();
        let root = add_shelf(&conn, "根", None);
        let a = add_shelf(&conn, "A", Some(root));
        add_book(&conn, "b1", Some(a));

        delete_shelf_db(&conn, a).unwrap();

        let shelf: Option<i64> =
            conn.query_row("SELECT shelf_id FROM books WHERE id = 'b1'", [], |r| r.get(0)).unwrap();
        assert_eq!(shelf, Some(root)); // 升一级到被删书架的父级，而非直接回根
    }

    #[test]
    fn soft_delete_restore_and_trash_listing() {
        let conn = setup();
        add_book(&conn, "b1", None);
        add_book(&conn, "b2", None);
        conn.execute("UPDATE books SET deleted_at = 5 WHERE id = 'b1'", []).unwrap();

        let trash = list_trash_db(&conn).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, "b1");

        assert_eq!(restore_books_db(&conn, &["b1".to_string()]).unwrap(), 1);
        assert!(list_trash_db(&conn).unwrap().is_empty());

        assert_eq!(soft_delete_books_db(&conn, &["b1".to_string(), "b2".to_string()], 9).unwrap(), 2);
        // 重复软删是幂等的（已删的不再刷新时间）
        assert_eq!(soft_delete_books_db(&conn, &["b1".to_string()], 10).unwrap(), 0);
        let trash = list_trash_db(&conn).unwrap();
        assert_eq!(trash.len(), 2);
    }

    #[test]
    fn purge_removes_copied_files_and_rows_but_not_folder_refs() {
        let conn = setup();
        let dir = std::env::temp_dir().join(format!("bookreading-purge-{}", Uuid::new_v4()));
        let books_dir = dir.join("library/books");
        let covers_dir = dir.join("library/covers");
        fs::create_dir_all(&books_dir).unwrap();
        fs::create_dir_all(&covers_dir).unwrap();

        // 复制入库的 epub + 封面
        fs::write(books_dir.join("b1.epub"), b"epub").unwrap();
        fs::write(covers_dir.join("b1.jpg"), b"jpg").unwrap();
        conn.execute(
            "INSERT INTO books (id, library_path, added_at, cover_path) VALUES ('b1', 'library/books/b1.epub', 1, 'library/covers/b1.jpg')",
            [],
        )
        .unwrap();
        // 文件夹引用的漫画书（绝对路径，源不动）
        let src = dir.join("comic-src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("p1.png"), b"png").unwrap();
        conn.execute(
            "INSERT INTO books (id, library_path, added_at) VALUES ('b2', ?1, 1)",
            params![src.to_string_lossy().to_string()],
        )
        .unwrap();

        purge_book(&conn, &dir.join("library"), "b1").unwrap();
        purge_book(&conn, &dir.join("library"), "b2").unwrap();

        assert!(!books_dir.join("b1.epub").exists());
        assert!(!covers_dir.join("b1.jpg").exists());
        assert!(src.join("p1.png").exists()); // 源目录保留
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn purge_expired_respects_retention_setting() {
        let conn = setup();
        let dir = std::env::temp_dir().join(format!("bookreading-expire-{}", Uuid::new_v4()));
        fs::create_dir_all(dir.join("library/books")).unwrap();
        fs::write(dir.join("library/books").join("b1.epub"), b"epub").unwrap();
        add_book(&conn, "b1", None);

        let now = 1_000_000i64;
        conn.execute("UPDATE books SET deleted_at = ?1 WHERE id = 'b1'", params![now - 31 * 86400]).unwrap();

        // 默认 30 天：31 天前删除 → 清掉
        purge_expired_trash(&conn, &dir.join("library"), now).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        assert!(!dir.join("library/books").join("b1.epub").exists());

        // 永不（0）：再放一本 10 天前删除的，不清
        conn.execute(
            "INSERT INTO books (id, library_path, added_at, deleted_at) VALUES ('b2', 'x', 1, ?1)",
            params![now - 10 * 86400],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, '0')",
            params![TRASH_RETENTION_KEY],
        )
        .unwrap();
        purge_expired_trash(&conn, &dir.join("library"), now).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);

        // 7 天：10 天前删除 → 清掉
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, '7')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![TRASH_RETENTION_KEY],
        )
        .unwrap();
        purge_expired_trash(&conn, &dir.join("library"), now).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
