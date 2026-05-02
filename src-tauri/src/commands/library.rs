use std::fs;
use std::path::PathBuf;

use base64::Engine;
use rusqlite::{params, Connection};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::app_paths;
use crate::db;
use crate::models::{Book, ImportBookRequest};

fn now_ts() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn insert_book(conn: &Connection, book: &Book) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO books (id, title, author, cover_path, library_path, added_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            book.id,
            book.title,
            book.author,
            book.cover_path,
            book.library_path,
            book.added_at,
            book.last_opened_at
        ],
    )?;
    Ok(())
}

fn fetch_books(conn: &Connection) -> Result<Vec<Book>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, cover_path, library_path, added_at, last_opened_at
         FROM books
         ORDER BY COALESCE(last_opened_at, added_at) DESC",
    )?;

    let books = stmt
        .query_map([], |row| {
            Ok(Book {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                cover_path: row.get(3)?,
                library_path: row.get(4)?,
                added_at: row.get(5)?,
                last_opened_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(books)
}

fn delete_book_by_id(conn: &Connection, book_id: &str) -> Result<(Option<String>, Option<String>), rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT library_path, cover_path FROM books WHERE id = ?1")?;
    let mut rows = stmt.query([book_id])?;

    let (library_path, cover_path): (Option<String>, Option<String>) = if let Some(row) = rows.next()? {
        (Some(row.get(0)?), row.get(1)?)
    } else {
        (None, None)
    };

    conn.execute("DELETE FROM books WHERE id = ?1", [book_id])?;
    Ok((library_path, cover_path))
}

#[tauri::command]
pub fn list_books(app: tauri::AppHandle) -> Result<Vec<Book>, String> {
    let conn = db::open_db(&app)?;
    fetch_books(&conn).map_err(|e| format!("failed to list books: {e}"))
}

#[tauri::command]
pub fn import_book(app: tauri::AppHandle, req: ImportBookRequest) -> Result<Book, String> {
    let book_id = Uuid::new_v4().to_string();

    let books_dir = app_paths::books_dir(&app)?;
    let covers_dir = app_paths::covers_dir(&app)?;

    fs::create_dir_all(&books_dir).map_err(|e| format!("failed to create books dir: {e}"))?;
    fs::create_dir_all(&covers_dir).map_err(|e| format!("failed to create covers dir: {e}"))?;

    let library_path: PathBuf = books_dir.join(format!("{book_id}.epub"));
    fs::copy(&req.source_path, &library_path)
        .map_err(|e| format!("failed to copy epub into library: {e}"))?;

    let cover_path: Option<PathBuf> = match (req.cover_bytes_base64.as_deref(), req.cover_ext.as_deref()) {
        (Some(b64), Some(ext)) if !b64.is_empty() && !ext.is_empty() => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("failed to decode cover base64: {e}"))?;
            let path = covers_dir.join(format!("{book_id}.{ext}"));
            fs::write(&path, bytes).map_err(|e| format!("failed to write cover: {e}"))?;
            Some(path)
        }
        _ => None,
    };

    let book = Book {
        id: book_id,
        title: req.title,
        author: req.author,
        cover_path: cover_path.map(|p| p.to_string_lossy().to_string()),
        library_path: library_path.to_string_lossy().to_string(),
        added_at: now_ts(),
        last_opened_at: None,
    };

    let conn = db::open_db(&app)?;
    insert_book(&conn, &book).map_err(|e| format!("failed to insert book: {e}"))?;

    Ok(book)
}

#[tauri::command]
pub fn delete_book(app: tauri::AppHandle, book_id: String) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    let (library_path, cover_path) =
        delete_book_by_id(&conn, &book_id).map_err(|e| format!("failed to delete book: {e}"))?;

    if let Some(path) = library_path {
        let _ = fs::remove_file(path);
    }
    if let Some(path) = cover_path {
        let _ = fs::remove_file(path);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_fetch_books() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();

        let book = Book {
            id: "b1".to_string(),
            title: Some("t".to_string()),
            author: Some("a".to_string()),
            cover_path: None,
            library_path: "/tmp/b1.epub".to_string(),
            added_at: 1,
            last_opened_at: None,
        };

        insert_book(&conn, &book).unwrap();
        let books = fetch_books(&conn).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].id, "b1");
    }

    #[test]
    fn delete_book_removes_row() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();

        let book = Book {
            id: "b2".to_string(),
            title: None,
            author: None,
            cover_path: Some("/tmp/c.png".to_string()),
            library_path: "/tmp/b2.epub".to_string(),
            added_at: 1,
            last_opened_at: None,
        };

        insert_book(&conn, &book).unwrap();
        let _ = delete_book_by_id(&conn, "b2").unwrap();
        let books = fetch_books(&conn).unwrap();
        assert!(books.is_empty());
    }
}

