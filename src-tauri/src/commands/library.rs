use std::fs;
use std::path::Path;
use std::path::PathBuf;

use base64::Engine;
use rusqlite::{params, Connection};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::app_paths;
use crate::db;
use crate::models::{Book, ImportBookRequest, UpdateBookMetadataRequest};

fn now_ts() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn is_safe_rel_path(p: &str) -> bool {
    let path = Path::new(p);
    if !path.is_relative() {
        return false;
    }
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => return false,
            std::path::Component::Prefix(_) => return false,
            std::path::Component::RootDir => return false,
            _ => {}
        }
    }
    true
}

fn require_library_rel(p: &str) -> Result<&str, String> {
    let v = p.replace('\\', "/");
    if !v.starts_with("library/") {
        return Err(format!("invalid library path: {p}"));
    }
    if !is_safe_rel_path(&v) {
        return Err(format!("unsafe relative path: {p}"));
    }
    Ok(p)
}

fn abs_from_appdata_rel(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    require_library_rel(&rel)?;
    Ok(app_paths::app_data_dir(app)?.join(rel))
}

fn atomic_copy_to(src: &str, tmp: &Path, final_path: &Path) -> Result<(), String> {
    fs::copy(src, tmp).map_err(|e| format!("failed to copy file: {e}"))?;
    if let Err(e) = fs::rename(tmp, final_path) {
        let _ = fs::remove_file(tmp);
        return Err(format!("failed to rename into place: {e}"));
    }
    Ok(())
}

fn atomic_write_to(tmp: &Path, final_path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::write(tmp, bytes).map_err(|e| format!("failed to write file: {e}"))?;
    if let Err(e) = fs::rename(tmp, final_path) {
        let _ = fs::remove_file(tmp);
        return Err(format!("failed to rename into place: {e}"));
    }
    Ok(())
}

fn insert_book(conn: &Connection, book: &Book) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO books (id, title, author, cover_path, library_path, added_at, last_opened_at, is_favorite)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            book.id,
            book.title,
            book.author,
            book.cover_path,
            book.library_path,
            book.added_at,
            book.last_opened_at,
            book.is_favorite
        ],
    )?;
    Ok(())
}

fn fetch_books(conn: &Connection) -> Result<Vec<Book>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, cover_path, library_path, added_at, last_opened_at, is_favorite
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
                is_favorite: row.get(7)?,
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

    Ok((library_path, cover_path))
}

fn fetch_book_by_id(conn: &Connection, book_id: &str) -> Result<Book, rusqlite::Error> {
    conn.query_row(
        "SELECT id, title, author, cover_path, library_path, added_at, last_opened_at, is_favorite
         FROM books
         WHERE id = ?1",
        [book_id],
        |row| {
            Ok(Book {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                cover_path: row.get(3)?,
                library_path: row.get(4)?,
                added_at: row.get(5)?,
                last_opened_at: row.get(6)?,
                is_favorite: row.get(7)?,
            })
        },
    )
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

    let final_book_abs: PathBuf = books_dir.join(format!("{book_id}.epub"));
    let tmp_book_abs: PathBuf = books_dir.join(format!("{book_id}.epub.part"));
    atomic_copy_to(&req.source_path, &tmp_book_abs, &final_book_abs)
        .map_err(|e| format!("failed to copy epub into library: {e}"))?;

    let cover_abs: Option<PathBuf> =
        match (req.cover_bytes_base64.as_deref(), req.cover_ext.as_deref()) {
            (Some(b64), Some(ext)) if !b64.is_empty() && !ext.is_empty() => {
                let ext = ext
                    .trim()
                    .trim_start_matches('.')
                    .to_lowercase();
                let allowed = ["png", "jpg", "jpeg", "webp"];
                if !allowed.contains(&ext.as_str()) {
                    None
                } else {
                    let b64 = b64.split(',').last().unwrap_or(b64);
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .map_err(|e| format!("failed to decode cover base64: {e}"))?;
                    let final_cover_abs = covers_dir.join(format!("{book_id}.{ext}"));
                    let tmp_cover_abs = covers_dir.join(format!("{book_id}.{ext}.part"));
                    atomic_write_to(&tmp_cover_abs, &final_cover_abs, &bytes)
                        .map_err(|e| format!("failed to write cover: {e}"))?;
                    Some(final_cover_abs)
                }
            }
            _ => None,
        };

    let library_path = format!("library/books/{book_id}.epub");
    let cover_path = cover_abs
        .as_ref()
        .and_then(|p| p.extension().and_then(|e| e.to_str()))
        .map(|ext| format!("library/covers/{book_id}.{ext}"));

    let book = Book {
        id: book_id,
        title: req.title,
        author: req.author,
        cover_path,
        library_path,
        added_at: now_ts(),
        last_opened_at: None,
        is_favorite: false,
    };

    let conn = db::open_db(&app)?;
    if let Err(e) = insert_book(&conn, &book) {
        let _ = fs::remove_file(&final_book_abs);
        if let Some(p) = cover_abs.as_ref() {
            let _ = fs::remove_file(p);
        }
        return Err(format!("failed to insert book: {e}"));
    }

    Ok(book)
}

#[tauri::command]
pub fn update_book_metadata(app: tauri::AppHandle, req: UpdateBookMetadataRequest) -> Result<Book, String> {
    let conn = db::open_db(&app)?;

    let existing =
        fetch_book_by_id(&conn, &req.book_id).map_err(|e| format!("failed to fetch book: {e}"))?;

    let cover_path: Option<String> =
        match (req.cover_bytes_base64.as_deref(), req.cover_ext.as_deref()) {
            (Some(b64), Some(ext)) if !b64.is_empty() && !ext.is_empty() => {
                let ext = ext
                    .trim()
                    .trim_start_matches('.')
                    .to_lowercase();
                let allowed = ["png", "jpg", "jpeg", "webp"];
                if !allowed.contains(&ext.as_str()) {
                    existing.cover_path.clone()
                } else {
                    let covers_dir = app_paths::covers_dir(&app)?;
                    fs::create_dir_all(&covers_dir)
                        .map_err(|e| format!("failed to create covers dir: {e}"))?;

                    let b64 = b64.split(',').last().unwrap_or(b64);
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .map_err(|e| format!("failed to decode cover base64: {e}"))?;
                    let final_cover_abs = covers_dir.join(format!("{}.{}", req.book_id, ext));
                    let tmp_cover_abs = covers_dir.join(format!("{}.{}.part", req.book_id, ext));
                    atomic_write_to(&tmp_cover_abs, &final_cover_abs, &bytes)
                        .map_err(|e| format!("failed to write cover: {e}"))?;

                    if let Some(old) = existing.cover_path.as_ref() {
                        if old.replace('\\', "/").starts_with("library/covers/") && old != &format!("library/covers/{}.{}", req.book_id, ext) {
                            if let Ok(old_abs) = abs_from_appdata_rel(&app, old) {
                                let _ = fs::remove_file(old_abs);
                            }
                        }
                    }

                    Some(format!("library/covers/{}.{}", req.book_id, ext))
                }
            }
            _ => existing.cover_path.clone(),
        };

    conn.execute(
        "UPDATE books SET title = ?2, author = ?3, cover_path = ?4 WHERE id = ?1",
        params![req.book_id, req.title, req.author, cover_path],
    )
    .map_err(|e| format!("failed to update book: {e}"))?;

    fetch_book_by_id(&conn, &req.book_id).map_err(|e| format!("failed to fetch book: {e}"))
}

#[tauri::command]
pub fn delete_book(app: tauri::AppHandle, book_id: String) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    let (library_path, cover_path) =
        delete_book_by_id(&conn, &book_id).map_err(|e| format!("failed to load book paths: {e}"))?;

    let trash_dir = app_paths::trash_dir(&app)?;
    fs::create_dir_all(&trash_dir).map_err(|e| format!("failed to create trash dir: {e}"))?;

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();

    if let Some(rel) = library_path.as_deref() {
        if let Ok(abs) = abs_from_appdata_rel(&app, rel) {
            if abs.exists() {
                let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("epub");
                let trash = trash_dir.join(format!("{}-{}.{}", book_id, Uuid::new_v4(), ext));
                if let Err(e) = fs::rename(&abs, &trash) {
                    for (t, o) in moved.iter() {
                        let _ = fs::rename(t, o);
                    }
                    return Err(format!("failed to move book to trash: {e}"));
                }
                moved.push((trash, abs));
            }
        }
    }

    if let Some(rel) = cover_path.as_deref() {
        if let Ok(abs) = abs_from_appdata_rel(&app, rel) {
            if abs.exists() {
                let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("img");
                let trash = trash_dir.join(format!("{}-{}.{}", book_id, Uuid::new_v4(), ext));
                if let Err(e) = fs::rename(&abs, &trash) {
                    for (t, o) in moved.iter() {
                        let _ = fs::rename(t, o);
                    }
                    return Err(format!("failed to move cover to trash: {e}"));
                }
                moved.push((trash, abs));
            }
        }
    }

    if let Err(e) = conn.execute("DELETE FROM books WHERE id = ?1", [&book_id]) {
        for (trash, original) in moved.iter() {
            let _ = fs::rename(trash, original);
        }
        return Err(format!("failed to delete book: {e}"));
    }

    for (trash, _) in moved {
        let _ = fs::remove_file(trash);
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
            library_path: "library/books/b1.epub".to_string(),
            added_at: 1,
            last_opened_at: None,
            is_favorite: false,
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
            cover_path: Some("library/covers/b2.png".to_string()),
            library_path: "library/books/b2.epub".to_string(),
            added_at: 1,
            last_opened_at: None,
            is_favorite: false,
        };

        insert_book(&conn, &book).unwrap();
        conn.execute("DELETE FROM books WHERE id = ?1", ["b2"]).unwrap();
        let books = fetch_books(&conn).unwrap();
        assert!(books.is_empty());
    }
}
