use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, params_from_iter, Connection};

use crate::app_paths;
use crate::commands::library::fetch_book_by_id;
use crate::commands::shelves::in_clause;
use crate::db;
use crate::models::{Book, Tag};

// color 只接受 #RRGGBB 类十六进制（防任意字符串直落 CSS inline style），None=默认色
fn valid_color(c: &str) -> bool {
    let hex = c.strip_prefix('#').unwrap_or("");
    (4..=9).contains(&c.len()) && !hex.is_empty() && hex.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn check_color(color: &Option<String>) -> Result<(), String> {
    match color.as_deref() {
        None => Ok(()),
        Some(c) if valid_color(c) => Ok(()),
        Some(_) => Err("颜色格式无效（应为 #RRGGBB）".to_string()),
    }
}

fn name_taken(conn: &Connection, name: &str, exclude_id: Option<i64>) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM tags WHERE name = ?1 AND id IS NOT ?2 LIMIT 1",
        params![name, exclude_id],
        |_| Ok(()),
    )
    .map(|_| true)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(false),
        other => Err(format!("failed to check tag name: {other}")),
    })
}

fn tag_exists(conn: &Connection, id: i64) -> Result<bool, String> {
    conn.query_row("SELECT 1 FROM tags WHERE id = ?1", [id], |_| Ok(()))
        .map(|_| true)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(format!("failed to check tag: {other}")),
        })
}

fn ensure_tags_exist(conn: &Connection, ids: &[i64]) -> Result<(), String> {
    let n: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM tags WHERE id IN {}", in_clause(ids.len())),
            params_from_iter(ids.iter()),
            |r| r.get(0),
        )
        .map_err(|e| format!("failed to check tags: {e}"))?;
    if n != ids.len() as i64 {
        return Err("包含不存在的标签".to_string());
    }
    Ok(())
}

fn ensure_books_exist(conn: &Connection, ids: &[String]) -> Result<(), String> {
    let n: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM books WHERE id IN {}", in_clause(ids.len())),
            params_from_iter(ids.iter()),
            |r| r.get(0),
        )
        .map_err(|e| format!("failed to check books: {e}"))?;
    if n != ids.len() as i64 {
        return Err("包含不存在的书籍".to_string());
    }
    Ok(())
}

pub(crate) fn list_tags_db(conn: &Connection) -> Result<Vec<Tag>, rusqlite::Error> {
    // book_count 只数未软删的书（与书库所见一致）
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, t.sort_order, COUNT(b.id)
         FROM tags t
         LEFT JOIN book_tags bt ON bt.tag_id = t.id
         LEFT JOIN books b ON b.id = bt.book_id AND b.deleted_at IS NULL
         GROUP BY t.id
         ORDER BY t.sort_order, t.name",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Tag {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            sort_order: row.get(3)?,
            book_count: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn create_tag_db(conn: &Connection, name: &str, color: Option<&str>) -> Result<Tag, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("标签名称不能为空".to_string());
    }
    check_color(&color.map(|c| c.to_string()))?;
    if name_taken(conn, name, None)? {
        return Err(format!("标签“{name}”已存在"));
    }
    let next_order: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tags", [], |r| r.get(0))
        .map_err(|e| format!("failed to compute tag order: {e}"))?;
    conn.execute(
        "INSERT INTO tags (name, color, sort_order) VALUES (?1, ?2, ?3)",
        params![name, color, next_order],
    )
    .map_err(|e| format!("failed to create tag: {e}"))?;
    let id = conn.last_insert_rowid();
    Ok(Tag {
        id,
        name: name.to_string(),
        color: color.map(|c| c.to_string()),
        sort_order: next_order,
        book_count: 0,
    })
}

fn rename_tag_db(conn: &Connection, id: i64, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("标签名称不能为空".to_string());
    }
    if name_taken(conn, name, Some(id))? {
        return Err(format!("标签“{name}”已存在"));
    }
    let n = conn
        .execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![id, name])
        .map_err(|e| format!("failed to rename tag: {e}"))?;
    if n == 0 {
        return Err(format!("标签 {id} 不存在"));
    }
    Ok(())
}

fn recolor_tag_db(conn: &Connection, id: i64, color: Option<String>) -> Result<(), String> {
    check_color(&color)?;
    let n = conn
        .execute("UPDATE tags SET color = ?2 WHERE id = ?1", params![id, color])
        .map_err(|e| format!("failed to recolor tag: {e}"))?;
    if n == 0 {
        return Err(format!("标签 {id} 不存在"));
    }
    Ok(())
}

// from 并入 to：book_tags 先 INSERT OR IGNORE 去重迁移再删 from 关联，最后删 from 本体
fn merge_tags_db(conn: &Connection, from_id: i64, to_id: i64) -> Result<(), String> {
    if from_id == to_id {
        return Err("不能合并到自身".to_string());
    }
    if !tag_exists(conn, from_id)? {
        return Err(format!("标签 {from_id} 不存在"));
    }
    if !tag_exists(conn, to_id)? {
        return Err(format!("标签 {to_id} 不存在"));
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("failed to begin tag merge: {e}"))?;
    tx.execute(
        "INSERT OR IGNORE INTO book_tags (book_id, tag_id)
         SELECT book_id, ?2 FROM book_tags WHERE tag_id = ?1",
        params![from_id, to_id],
    )
    .map_err(|e| format!("failed to migrate tag links: {e}"))?;
    tx.execute("DELETE FROM book_tags WHERE tag_id = ?1", [from_id])
        .map_err(|e| format!("failed to drop old tag links: {e}"))?;
    tx.execute("DELETE FROM tags WHERE id = ?1", [from_id])
        .map_err(|e| format!("failed to delete tag: {e}"))?;
    tx.commit().map_err(|e| format!("failed to commit tag merge: {e}"))
}

fn delete_tag_db(conn: &Connection, id: i64) -> Result<(), String> {
    if !tag_exists(conn, id)? {
        return Err(format!("标签 {id} 不存在"));
    }
    // ON DELETE CASCADE 解除全部书-标签关联，不删书
    conn.execute("DELETE FROM tags WHERE id = ?1", [id])
        .map_err(|e| format!("failed to delete tag: {e}"))?;
    Ok(())
}

// 全量替换语义：tag_ids 即该书最终标签集
fn set_book_tags_db(conn: &Connection, book_id: &str, tag_ids: &[i64]) -> Result<(), String> {
    fetch_book_by_id(conn, book_id).map_err(|_| format!("书 {book_id} 不存在"))?;
    let mut ids = tag_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    if !ids.is_empty() {
        ensure_tags_exist(conn, &ids)?;
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("failed to begin set tags: {e}"))?;
    tx.execute("DELETE FROM book_tags WHERE book_id = ?1", [book_id])
        .map_err(|e| format!("failed to clear book tags: {e}"))?;
    for tid in &ids {
        tx.execute(
            "INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?1, ?2)",
            params![book_id, tid],
        )
        .map_err(|e| format!("failed to link tag: {e}"))?;
    }
    tx.commit().map_err(|e| format!("failed to commit set tags: {e}"))
}

// 批量追加：只增不减，幂等
fn add_tags_to_books_db(conn: &Connection, book_ids: &[String], tag_ids: &[i64]) -> Result<(), String> {
    if book_ids.is_empty() || tag_ids.is_empty() {
        return Ok(());
    }
    let mut bids = book_ids.to_vec();
    bids.sort_unstable();
    bids.dedup();
    let mut tids = tag_ids.to_vec();
    tids.sort_unstable();
    tids.dedup();
    ensure_books_exist(conn, &bids)?;
    ensure_tags_exist(conn, &tids)?;

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("failed to begin add tags: {e}"))?;
    for bid in &bids {
        for tid in &tids {
            tx.execute(
                "INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?1, ?2)",
                params![bid, tid],
            )
            .map_err(|e| format!("failed to link tag: {e}"))?;
        }
    }
    tx.commit().map_err(|e| format!("failed to commit add tags: {e}"))
}

// 文件大小：文件直接 metadata；文件夹漫画求和直接子文件
fn path_size_bytes(p: &Path) -> Option<u64> {
    let md = fs::metadata(p).ok()?;
    if md.is_file() {
        return Some(md.len());
    }
    let mut total = 0u64;
    for entry in fs::read_dir(p).ok()? {
        let Ok(entry) = entry else { continue };
        if let Ok(m) = entry.metadata() {
            if m.is_file() {
                total += m.len();
            }
        }
    }
    Some(total)
}

// v1 只算 file_size（库内文件或文件夹源）；content_chars 列已建但不填，详情页显示 —
fn compute_book_size(conn: &Connection, data_dir: &Path, book: &Book) -> Result<(), String> {
    let rel = book.library_path.replace('\\', "/");
    let abs: PathBuf = if rel.starts_with("library/") {
        data_dir.join(&rel)
    } else if Path::new(&rel).is_absolute() {
        PathBuf::from(&rel)
    } else {
        return Ok(());
    };
    if let Some(size) = path_size_bytes(&abs) {
        conn.execute(
            "UPDATE books SET file_size = ?2 WHERE id = ?1",
            params![book.id, size as i64],
        )
        .map_err(|e| format!("failed to save file size: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_tags(app: tauri::AppHandle) -> Result<Vec<Tag>, String> {
    let conn = db::open_db(&app)?;
    list_tags_db(&conn).map_err(|e| format!("failed to list tags: {e}"))
}

#[tauri::command]
pub fn create_tag(app: tauri::AppHandle, name: String, color: Option<String>) -> Result<Tag, String> {
    let conn = db::open_db(&app)?;
    create_tag_db(&conn, &name, color.as_deref())
}

#[tauri::command]
pub fn rename_tag(app: tauri::AppHandle, id: i64, name: String) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    rename_tag_db(&conn, id, &name)
}

#[tauri::command]
pub fn recolor_tag(app: tauri::AppHandle, id: i64, color: Option<String>) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    recolor_tag_db(&conn, id, color)
}

#[tauri::command]
pub fn merge_tags(app: tauri::AppHandle, from_id: i64, to_id: i64) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    merge_tags_db(&conn, from_id, to_id)
}

#[tauri::command]
pub fn delete_tag(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    delete_tag_db(&conn, id)
}

#[tauri::command]
pub fn set_book_tags(app: tauri::AppHandle, book_id: String, tag_ids: Vec<i64>) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    set_book_tags_db(&conn, &book_id, &tag_ids)
}

#[tauri::command]
pub fn add_tags_to_books(app: tauri::AppHandle, book_ids: Vec<String>, tag_ids: Vec<i64>) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    add_tags_to_books_db(&conn, &book_ids, &tag_ids)
}

#[tauri::command]
pub fn compute_book_stats(app: tauri::AppHandle, book_id: String) -> Result<Book, String> {
    let conn = db::open_db(&app)?;
    let book = fetch_book_by_id(&conn, &book_id).map_err(|e| format!("failed to fetch book: {e}"))?;
    compute_book_size(&conn, &app_paths::app_data_dir(&app)?, &book)?;
    fetch_book_by_id(&conn, &book_id).map_err(|e| format!("failed to fetch book: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::library::fetch_books;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        conn
    }

    fn add_book(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO books (id, title, library_path, added_at) VALUES (?1, ?2, ?3, 1)",
            params![id, format!("t{id}"), format!("library/books/{id}.epub")],
        )
        .unwrap();
    }

    fn link(conn: &Connection, book: &str, tag: i64) {
        conn.execute(
            "INSERT INTO book_tags (book_id, tag_id) VALUES (?1, ?2)",
            params![book, tag],
        )
        .unwrap();
    }

    fn tag_ids_of(conn: &Connection, book: &str) -> Vec<i64> {
        conn.prepare("SELECT tag_id FROM book_tags WHERE book_id = ?1 ORDER BY tag_id")
            .unwrap()
            .query_map([book], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn tag_crud_and_counts() {
        let conn = setup();
        let t1 = create_tag_db(&conn, "科幻", Some("#1971c2")).unwrap();
        let t2 = create_tag_db(&conn, "  小说  ", None).unwrap();
        assert_eq!(t2.name, "小说"); // 建名去空白
        assert_eq!(create_tag_db(&conn, "科幻", None).unwrap_err(), "标签“科幻”已存在");
        assert_eq!(create_tag_db(&conn, "  ", None).unwrap_err(), "标签名称不能为空");
        assert_eq!(
            create_tag_db(&conn, "坏色", Some("red")).unwrap_err(),
            "颜色格式无效（应为 #RRGGBB）"
        );

        add_book(&conn, "b1");
        add_book(&conn, "b2");
        link(&conn, "b1", t1.id);
        link(&conn, "b2", t1.id);

        // 软删的书不计入 book_count
        conn.execute("UPDATE books SET deleted_at = 9 WHERE id = 'b2'", []).unwrap();
        let tags = list_tags_db(&conn).unwrap();
        assert_eq!(tags.len(), 2);
        let sci = tags.iter().find(|t| t.id == t1.id).unwrap();
        assert_eq!(sci.book_count, 1);
        assert_eq!(sci.color.as_deref(), Some("#1971c2"));

        rename_tag_db(&conn, t1.id, "科幻小说").unwrap();
        assert_eq!(
            rename_tag_db(&conn, t2.id, "科幻小说").unwrap_err(),
            "标签“科幻小说”已存在"
        );
        assert_eq!(rename_tag_db(&conn, 999, "x").unwrap_err(), "标签 999 不存在");

        recolor_tag_db(&conn, t1.id, None).unwrap();
        recolor_tag_db(&conn, t1.id, Some("#e8590c".to_string())).unwrap();
        assert_eq!(recolor_tag_db(&conn, 999, None).unwrap_err(), "标签 999 不存在");
        assert_eq!(
            recolor_tag_db(&conn, t1.id, Some("javascript:alert(1)".to_string())).unwrap_err(),
            "颜色格式无效（应为 #RRGGBB）"
        );

        delete_tag_db(&conn, t1.id).unwrap();
        assert!(tag_ids_of(&conn, "b1").is_empty()); // 级联解除关联
        assert_eq!(delete_tag_db(&conn, t1.id).unwrap_err(), "标签 1 不存在");
        // 书还在
        let books = fetch_books(&conn).unwrap();
        assert_eq!(books.len(), 1); // b2 已软删不计
    }

    #[test]
    fn merge_moves_links_and_dedupes() {
        let conn = setup();
        let from = create_tag_db(&conn, "A", None).unwrap();
        let to = create_tag_db(&conn, "B", None).unwrap();
        add_book(&conn, "b1");
        add_book(&conn, "b2");
        link(&conn, "b1", from.id);
        link(&conn, "b1", to.id); // b1 同时有两个标签 → 合并后只剩 to 一条
        link(&conn, "b2", from.id);

        merge_tags_db(&conn, from.id, to.id).unwrap();

        assert_eq!(tag_ids_of(&conn, "b1"), vec![to.id]);
        assert_eq!(tag_ids_of(&conn, "b2"), vec![to.id]);
        assert!(!tag_exists(&conn, from.id).unwrap());
        let tags = list_tags_db(&conn).unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].book_count, 2);
        assert_eq!(merge_tags_db(&conn, to.id, to.id).unwrap_err(), "不能合并到自身");
    }

    #[test]
    fn set_book_tags_replaces_and_validates() {
        let conn = setup();
        add_book(&conn, "b1");
        let t1 = create_tag_db(&conn, "T1", None).unwrap();
        let t2 = create_tag_db(&conn, "T2", None).unwrap();

        set_book_tags_db(&conn, "b1", &[t1.id, t2.id]).unwrap();
        assert_eq!(tag_ids_of(&conn, "b1"), vec![t1.id, t2.id]);

        set_book_tags_db(&conn, "b1", &[t2.id]).unwrap(); // 全量替换：t1 移除
        assert_eq!(tag_ids_of(&conn, "b1"), vec![t2.id]);

        set_book_tags_db(&conn, "b1", &[]).unwrap(); // 空集=清空
        assert!(tag_ids_of(&conn, "b1").is_empty());

        assert_eq!(set_book_tags_db(&conn, "b1", &[999]).unwrap_err(), "包含不存在的标签");
        assert_eq!(set_book_tags_db(&conn, "nope", &[t1.id]).unwrap_err(), "书 nope 不存在");
    }

    #[test]
    fn add_tags_to_books_is_idempotent_append() {
        let conn = setup();
        add_book(&conn, "b1");
        add_book(&conn, "b2");
        let t1 = create_tag_db(&conn, "T1", None).unwrap();

        add_tags_to_books_db(&conn, &["b1".to_string(), "b2".to_string()], &[t1.id]).unwrap();
        add_tags_to_books_db(&conn, &["b1".to_string(), "b2".to_string()], &[t1.id]).unwrap(); // 重放幂等

        let books = fetch_books(&conn).unwrap();
        for b in &books {
            assert_eq!(b.tags.len(), 1);
            assert_eq!(b.tags[0].name, "T1");
        }
        assert_eq!(
            add_tags_to_books_db(&conn, &["b1".to_string()], &[999]).unwrap_err(),
            "包含不存在的标签"
        );
        add_tags_to_books_db(&conn, &[], &[t1.id]).unwrap(); // 空批次直通
    }

    #[test]
    fn fetch_books_carries_tags_and_new_columns() {
        let conn = setup();
        add_book(&conn, "b1");
        conn.execute(
            "UPDATE books SET description = '简介', file_size = 123, content_chars = 45 WHERE id = 'b1'",
            [],
        )
        .unwrap();
        let t1 = create_tag_db(&conn, "科幻", Some("#1971c2")).unwrap();
        create_tag_db(&conn, "小说", None).unwrap();
        link(&conn, "b1", t1.id);
        link(&conn, "b1", t1.id + 1);

        let books = fetch_books(&conn).unwrap();
        assert_eq!(books.len(), 1);
        let b = &books[0];
        assert_eq!(b.description.as_deref(), Some("简介"));
        assert_eq!(b.file_size, Some(123));
        assert_eq!(b.content_chars, Some(45));
        let names: Vec<&str> = b.tags.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["科幻", "小说"]);
        assert_eq!(b.tags[0].color.as_deref(), Some("#1971c2"));
        assert_eq!(b.tags[1].color, None);
    }

    #[test]
    fn compute_book_size_file_and_folder() {
        let conn = setup();
        let dir = std::env::temp_dir().join(format!("bookreading-tags-{}", uuid::Uuid::new_v4()));
        let books_dir = dir.join("library/books");
        fs::create_dir_all(&books_dir).unwrap();
        fs::write(books_dir.join("b1.epub"), vec![0u8; 100]).unwrap();
        // 文件夹漫画：源目录求和
        let src = dir.join("comic");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("p1.png"), vec![0u8; 30]).unwrap();
        fs::write(src.join("p2.png"), vec![0u8; 20]).unwrap();

        conn.execute(
            "INSERT INTO books (id, library_path, added_at) VALUES ('b1', 'library/books/b1.epub', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO books (id, library_path, added_at) VALUES ('b2', ?1, 1)",
            params![src.to_string_lossy().to_string()],
        )
        .unwrap();
        // 相对而非 library/ 前缀的脏路径：跳过不报错
        conn.execute(
            "INSERT INTO books (id, library_path, added_at) VALUES ('b3', 'weird/path', 1)",
            [],
        )
        .unwrap();

        for id in ["b1", "b2", "b3"] {
            let book = fetch_book_by_id(&conn, id).unwrap();
            compute_book_size(&conn, &dir, &book).unwrap();
        }

        let size = |id: &str| -> Option<i64> {
            conn.query_row("SELECT file_size FROM books WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(size("b1"), Some(100));
        assert_eq!(size("b2"), Some(50)); // 文件夹=页文件求和
        assert_eq!(size("b3"), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
