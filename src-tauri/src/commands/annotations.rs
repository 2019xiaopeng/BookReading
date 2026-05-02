use rusqlite::{params, Connection};
use time::OffsetDateTime;
use uuid::Uuid;

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
        "INSERT INTO highlights (id, book_id, cfi_range, color, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![h.id, h.book_id, h.cfi_range, h.color, h.note, h.created_at],
    )?;
    Ok(())
}

fn fetch_highlights(conn: &Connection, book_id: &str) -> Result<Vec<Highlight>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, cfi_range, color, note, created_at FROM highlights WHERE book_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([book_id], |row| {
        Ok(Highlight {
            id: row.get(0)?,
            book_id: row.get(1)?,
            cfi_range: row.get(2)?,
            color: row.get(3)?,
            note: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn delete_highlight_by_id(conn: &Connection, highlight_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM highlights WHERE id = ?1", [highlight_id])?;
    Ok(())
}

#[tauri::command]
pub fn list_bookmarks(app: tauri::AppHandle, book_id: String) -> Result<Vec<Bookmark>, String> {
    let conn = db::open_db(&app)?;
    fetch_bookmarks(&conn, &book_id).map_err(|e| format!("failed to list bookmarks: {e}"))
}

#[tauri::command]
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

#[tauri::command]
pub fn delete_bookmark(app: tauri::AppHandle, bookmark_id: String) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    delete_bookmark_by_id(&conn, &bookmark_id).map_err(|e| format!("failed to delete bookmark: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_highlights(app: tauri::AppHandle, book_id: String) -> Result<Vec<Highlight>, String> {
    let conn = db::open_db(&app)?;
    fetch_highlights(&conn, &book_id).map_err(|e| format!("failed to list highlights: {e}"))
}

#[tauri::command]
pub fn add_highlight(
    app: tauri::AppHandle,
    book_id: String,
    cfi_range: String,
    color: String,
    note: Option<String>,
) -> Result<Highlight, String> {
    let conn = db::open_db(&app)?;
    let highlight = Highlight {
        id: Uuid::new_v4().to_string(),
        book_id,
        cfi_range,
        color,
        note,
        created_at: now_ts(),
    };
    insert_highlight(&conn, &highlight).map_err(|e| format!("failed to add highlight: {e}"))?;
    Ok(highlight)
}

#[tauri::command]
pub fn delete_highlight(app: tauri::AppHandle, highlight_id: String) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    delete_highlight_by_id(&conn, &highlight_id).map_err(|e| format!("failed to delete highlight: {e}"))?;
    Ok(())
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
            created_at: 1,
        };
        insert_highlight(&conn, &h).unwrap();
        let list = fetch_highlights(&conn, "b1").unwrap();
        assert_eq!(list.len(), 1);
        delete_highlight_by_id(&conn, "hl1").unwrap();
        let list2 = fetch_highlights(&conn, "b1").unwrap();
        assert!(list2.is_empty());
    }
}

