use std::fs;
use std::path::PathBuf;

use rusqlite::{params, Connection};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::commands::favorites::list_favorite_quotes_db;
use crate::db;
use crate::models::{Bookmark, Highlight};

fn now_ts() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn insert_bookmark(conn: &Connection, b: &Bookmark) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO bookmarks (id, book_id, cfi, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![b.id, b.book_id, b.cfi, b.label, b.created_at],
    )?;
    Ok(())
}

fn fetch_bookmarks(conn: &Connection, book_id: &str) -> Result<Vec<Bookmark>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, cfi, label, created_at FROM bookmarks WHERE book_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([book_id], |row| {
        Ok(Bookmark {
            id: row.get(0)?,
            book_id: row.get(1)?,
            cfi: row.get(2)?,
            label: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn delete_bookmark_by_id(conn: &Connection, bookmark_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", [bookmark_id])?;
    Ok(())
}

fn insert_highlight(conn: &Connection, h: &Highlight) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO highlights (id, book_id, cfi_range, color, note, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![h.id, h.book_id, h.cfi_range, h.color, h.note, h.text, h.created_at],
    )?;
    Ok(())
}

fn fetch_highlights(conn: &Connection, book_id: &str) -> Result<Vec<Highlight>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, cfi_range, color, note, text, created_at FROM highlights WHERE book_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([book_id], |row| {
        Ok(Highlight {
            id: row.get(0)?,
            book_id: row.get(1)?,
            cfi_range: row.get(2)?,
            color: row.get(3)?,
            note: row.get(4)?,
            text: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn delete_highlight_by_id(conn: &Connection, highlight_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM highlights WHERE id = ?1", [highlight_id])?;
    Ok(())
}

#[tauri::command(async)]
pub fn list_bookmarks(app: tauri::AppHandle, book_id: String) -> Result<Vec<Bookmark>, String> {
    let conn = db::open_db(&app)?;
    fetch_bookmarks(&conn, &book_id).map_err(|e| format!("failed to list bookmarks: {e}"))
}

#[tauri::command(async)]
pub fn add_bookmark(
    app: tauri::AppHandle,
    book_id: String,
    cfi: String,
    label: Option<String>,
) -> Result<Bookmark, String> {
    let conn = db::open_db(&app)?;
    let bookmark = Bookmark {
        id: Uuid::new_v4().to_string(),
        book_id,
        cfi,
        label,
        created_at: now_ts(),
    };
    insert_bookmark(&conn, &bookmark).map_err(|e| format!("failed to add bookmark: {e}"))?;
    Ok(bookmark)
}

#[tauri::command(async)]
pub fn delete_bookmark(app: tauri::AppHandle, bookmark_id: String) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    delete_bookmark_by_id(&conn, &bookmark_id).map_err(|e| format!("failed to delete bookmark: {e}"))?;
    Ok(())
}

#[tauri::command(async)]
pub fn list_highlights(app: tauri::AppHandle, book_id: String) -> Result<Vec<Highlight>, String> {
    let conn = db::open_db(&app)?;
    fetch_highlights(&conn, &book_id).map_err(|e| format!("failed to list highlights: {e}"))
}

#[tauri::command(async)]
pub fn add_highlight(
    app: tauri::AppHandle,
    book_id: String,
    cfi_range: String,
    color: String,
    note: Option<String>,
    // A10：选中文本入 text 列，note 回归纯笔记语义（旧前端不传 = 与迁移前行为一致）
    text: Option<String>,
) -> Result<Highlight, String> {
    let conn = db::open_db(&app)?;
    let highlight = Highlight {
        id: Uuid::new_v4().to_string(),
        book_id,
        cfi_range,
        color,
        note,
        text,
        created_at: now_ts(),
    };
    insert_highlight(&conn, &highlight).map_err(|e| format!("failed to add highlight: {e}"))?;
    Ok(highlight)
}

#[tauri::command(async)]
pub fn delete_highlight(app: tauri::AppHandle, highlight_id: String) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    delete_highlight_by_id(&conn, &highlight_id).map_err(|e| format!("failed to delete highlight: {e}"))?;
    Ok(())
}

// ---- A11 标注导出 Markdown ----

fn push_quote_block(out: &mut String, text: &str) {
    // 空行也要保留引用结构，防止段落合并
    for line in text.lines() {
        out.push_str(&format!("> {line}\n"));
    }
    out.push('\n');
}

/// 导出组装（core 分离以便测试）：书名/原文/笔记/颜色 + 收藏摘录，DB 无章节列、
/// 高亮附 cfi 作定位参考。时间顺序（旧→新）。
fn build_export_markdown(conn: &Connection, book_id: Option<&str>) -> Result<String, String> {
    let books: Vec<(String, String)> = conn
        .prepare(
            "SELECT id, COALESCE(NULLIF(title, ''), id) FROM books
             WHERE deleted_at IS NULL AND (?1 IS NULL OR id = ?1)
             ORDER BY COALESCE(NULLIF(title, ''), id)",
        )
        .map_err(|e| format!("failed to list books: {e}"))?
        .query_map([book_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| format!("failed to query books: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to read books: {e}"))?;

    let mut out = String::from("# BookReading 标注导出\n\n");
    for (bid, title) in books {
        let mut highlights = fetch_highlights(conn, &bid)
            .map_err(|e| format!("failed to list highlights: {e}"))?;
        highlights.reverse();
        let mut quotes = list_favorite_quotes_db(conn, Some(&bid), None)
            .map_err(|e| format!("failed to list quotes: {e}"))?;
        quotes.reverse();

        if highlights.is_empty() && quotes.is_empty() {
            if book_id.is_some() {
                out.push_str(&format!("## 《{title}》\n\n（暂无标注）\n\n"));
            }
            continue;
        }

        out.push_str(&format!("## 《{title}》\n\n"));
        if !highlights.is_empty() {
            out.push_str("### 高亮\n\n");
            for h in &highlights {
                match h.text.as_deref().filter(|s| !s.trim().is_empty()) {
                    Some(src) => push_quote_block(&mut out, src),
                    None => out.push_str("> （原文缺失，见迁移前 quick-highlight 记录）\n\n"),
                }
                if let Some(note) = h.note.as_deref().filter(|s| !s.trim().is_empty()) {
                    out.push_str(&format!("- 笔记：{note}\n"));
                }
                out.push_str(&format!("- 颜色：{}\n", h.color));
                out.push_str(&format!("- 定位：{}\n", h.cfi_range));
                out.push('\n');
            }
        }
        if !quotes.is_empty() {
            out.push_str("### 收藏摘录\n\n");
            for q in &quotes {
                push_quote_block(&mut out, &q.text);
                if let Some(note) = q.note.as_deref().filter(|s| !s.trim().is_empty()) {
                    out.push_str(&format!("- 笔记：{note}\n"));
                }
                out.push('\n');
            }
        }
    }
    Ok(out)
}

/// 导出标注为 Markdown（UTF-8 无 BOM）：bookId=None 导出全部书；destPath 由前端 save 对话框选定，
/// 缺 .md 扩展名时补上；返回实际写出路径。
#[tauri::command(async)]
pub fn export_annotations(
    app: tauri::AppHandle,
    book_id: Option<String>,
    dest_path: String,
) -> Result<String, String> {
    let conn = db::open_db(&app)?;
    let markdown = build_export_markdown(&conn, book_id.as_deref())?;
    let mut path = PathBuf::from(dest_path);
    if !path.to_string_lossy().to_lowercase().ends_with(".md") {
        path = PathBuf::from(format!("{}.md", path.to_string_lossy()));
    }
    fs::write(&path, markdown.as_bytes()).map_err(|e| format!("failed to write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, cover_path, library_path, added_at, last_opened_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params!["b1", "t", "a", Option::<String>::None, "/tmp/b1.epub", 1i64, Option::<i64>::None],
        )
        .unwrap();
        conn
    }

    #[test]
    fn bookmarks_crud() {
        let conn = setup_db();
        let b = Bookmark {
            id: "bm1".to_string(),
            book_id: "b1".to_string(),
            cfi: "cfi".to_string(),
            label: Some("l".to_string()),
            created_at: 1,
        };
        insert_bookmark(&conn, &b).unwrap();
        let list = fetch_bookmarks(&conn, "b1").unwrap();
        assert_eq!(list.len(), 1);
        delete_bookmark_by_id(&conn, "bm1").unwrap();
        let list2 = fetch_bookmarks(&conn, "b1").unwrap();
        assert!(list2.is_empty());
    }

    #[test]
    fn highlights_crud() {
        let conn = setup_db();
        let h = Highlight {
            id: "hl1".to_string(),
            book_id: "b1".to_string(),
            cfi_range: "range".to_string(),
            color: "#ff0".to_string(),
            note: None,
            text: None,
            created_at: 1,
        };
        insert_highlight(&conn, &h).unwrap();
        let list = fetch_highlights(&conn, "b1").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].text, None);
        delete_highlight_by_id(&conn, "hl1").unwrap();
        let list2 = fetch_highlights(&conn, "b1").unwrap();
        assert!(list2.is_empty());
    }

    #[test]
    fn export_markdown_contains_books_highlights_and_quotes() {
        let conn = setup_db();
        conn.execute(
            "INSERT INTO books (id, title, library_path, added_at) VALUES ('b2', '第二本', 'x', 1)",
            [],
        )
        .unwrap();
        // b1：一条带笔记+原文的高亮、一条收藏摘录
        insert_highlight(
            &conn,
            &Highlight {
                id: "h1".into(),
                book_id: "b1".into(),
                cfi_range: "cfi(/6/2)".into(),
                color: "#ffe600".into(),
                note: Some("写得好".into()),
                text: Some("重要的原文句子".into()),
                created_at: 1,
            },
        )
        .unwrap();
        conn.execute(
            "INSERT INTO favorite_quotes (id, book_id, cfi_range, text, note, created_at) VALUES ('q1', 'b1', 'cfi', '摘录原文', '收藏理由', 2)",
            [],
        )
        .unwrap();

        let md = build_export_markdown(&conn, None).unwrap();
        assert!(md.contains("《t》"), "{md}");           // 标题缺省回退 id
        assert!(!md.contains("第二本"));                  // 全量导出跳过无标注书
        assert!(md.contains("> 重要的原文句子"));
        assert!(md.contains("- 笔记：写得好"));
        assert!(md.contains("- 颜色：#ffe600"));
        assert!(md.contains("- 定位：cfi(/6/2)"));
        assert!(md.contains("> 摘录原文"));
        assert!(md.contains("- 笔记：收藏理由"));

        // 单书导出：只有 b1，空的 b2 不出现
        let one = build_export_markdown(&conn, Some("b1")).unwrap();
        assert!(one.contains("重要的原文句子"));
        assert!(!one.contains("第二本"));

        // 无标注书的单书导出留档说明
        let empty = build_export_markdown(&conn, Some("b2")).unwrap();
        assert!(empty.contains("（暂无标注）"));
    }
}

