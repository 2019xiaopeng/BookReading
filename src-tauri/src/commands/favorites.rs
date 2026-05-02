use rusqlite::{params, Connection};
use rusqlite::types::ToSql;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::db;
use crate::models::{Book, FavoriteQuote};

fn now_ts() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn set_book_favorite_db(conn: &Connection, book_id: &str, is_favorite: bool) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE books SET is_favorite = ?1 WHERE id = ?2",
        params![is_favorite, book_id],
    )?;
    Ok(())
}

fn list_favorite_books_db(conn: &Connection) -> Result<Vec<Book>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, cover_path, library_path, added_at, last_opened_at, is_favorite
         FROM books
         WHERE is_favorite = 1
         ORDER BY COALESCE(last_opened_at, added_at) DESC",
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
        })
    })?;

    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn insert_favorite_quote_db(conn: &Connection, q: &FavoriteQuote) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO favorite_quotes (id, book_id, cfi_range, text, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![q.id, q.book_id, q.cfi_range, q.text, q.note, q.created_at],
    )?;
    Ok(())
}

fn delete_favorite_quote_db(conn: &Connection, quote_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM favorite_quotes WHERE id = ?1", [quote_id])?;
    Ok(())
}

fn list_favorite_quotes_db(
    conn: &Connection,
    book_id: Option<&str>,
    query: Option<&str>,
) -> Result<Vec<FavoriteQuote>, rusqlite::Error> {
    fn row_to_quote(row: &rusqlite::Row<'_>) -> Result<FavoriteQuote, rusqlite::Error> {
        Ok(FavoriteQuote {
            id: row.get(0)?,
            book_id: row.get(1)?,
            cfi_range: row.get(2)?,
            text: row.get(3)?,
            note: row.get(4)?,
            created_at: row.get(5)?,
        })
    }

    let mut sql =
        "SELECT id, book_id, cfi_range, text, note, created_at FROM favorite_quotes".to_string();
    let mut where_parts: Vec<String> = Vec::new();
    let mut values: Vec<Box<dyn ToSql>> = Vec::new();

    if book_id.is_some() {
        where_parts.push("book_id = ?".to_string());
        values.push(Box::new(book_id.unwrap().to_string()));
    }

    if query.is_some() {
        where_parts.push("text LIKE '%' || ? || '%'".to_string());
        values.push(Box::new(query.unwrap().to_string()));
    }

    if !where_parts.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_parts.join(" AND "));
    }

    sql.push_str(" ORDER BY created_at DESC");

    let mut stmt = conn.prepare(&sql)?;
    let params = rusqlite::params_from_iter(values.iter().map(|v| &**v));
    let rows = stmt.query_map(params, row_to_quote)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn set_book_favorite(app: tauri::AppHandle, book_id: String, is_favorite: bool) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    set_book_favorite_db(&conn, &book_id, is_favorite)
        .map_err(|e| format!("failed to set book favorite: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_favorite_books(app: tauri::AppHandle) -> Result<Vec<Book>, String> {
    let conn = db::open_db(&app)?;
    list_favorite_books_db(&conn).map_err(|e| format!("failed to list favorite books: {e}"))
}

#[tauri::command]
pub fn add_favorite_quote(
    app: tauri::AppHandle,
    book_id: String,
    cfi_range: String,
    text: String,
    note: Option<String>,
) -> Result<FavoriteQuote, String> {
    let conn = db::open_db(&app)?;
    let q = FavoriteQuote {
        id: Uuid::new_v4().to_string(),
        book_id,
        cfi_range,
        text,
        note,
        created_at: now_ts(),
    };
    insert_favorite_quote_db(&conn, &q).map_err(|e| format!("failed to add favorite quote: {e}"))?;
    Ok(q)
}

#[tauri::command]
pub fn delete_favorite_quote(app: tauri::AppHandle, quote_id: String) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    delete_favorite_quote_db(&conn, &quote_id)
        .map_err(|e| format!("failed to delete favorite quote: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_favorite_quotes(
    app: tauri::AppHandle,
    book_id: Option<String>,
    query: Option<String>,
) -> Result<Vec<FavoriteQuote>, String> {
    let conn = db::open_db(&app)?;
    list_favorite_quotes_db(&conn, book_id.as_deref(), query.as_deref())
        .map_err(|e| format!("failed to list favorite quotes: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, cover_path, library_path, added_at, last_opened_at, is_favorite)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                "b1",
                "t",
                "a",
                Option::<String>::None,
                "/tmp/b1.epub",
                1i64,
                Option::<i64>::None,
                false
            ],
        )
        .unwrap();
        conn
    }

    #[test]
    fn book_favorites_flow() {
        let conn = setup_db();
        set_book_favorite_db(&conn, "b1", true).unwrap();
        let list = list_favorite_books_db(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "b1");
    }

    #[test]
    fn favorite_quotes_crud() {
        let conn = setup_db();
        let q = FavoriteQuote {
            id: "q1".to_string(),
            book_id: "b1".to_string(),
            cfi_range: "cfi".to_string(),
            text: "hello".to_string(),
            note: None,
            created_at: 1,
        };
        insert_favorite_quote_db(&conn, &q).unwrap();

        let list = list_favorite_quotes_db(&conn, Some("b1"), None).unwrap();
        assert_eq!(list.len(), 1);

        let list2 = list_favorite_quotes_db(&conn, None, Some("hell")).unwrap();
        assert_eq!(list2.len(), 1);

        delete_favorite_quote_db(&conn, "q1").unwrap();
        let list3 = list_favorite_quotes_db(&conn, Some("b1"), None).unwrap();
        assert!(list3.is_empty());
    }
}
