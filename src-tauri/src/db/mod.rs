use std::fs;

use rusqlite::Connection;

use crate::app_paths;

pub const SCHEMA_SQL: &str = include_str!("schema.sql");

mod migrations;

pub fn init_db(app: &tauri::AppHandle) -> Result<(), String> {
    let db_path = app_paths::db_path(app)?;

    if let Some(dir) = db_path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create db dir: {e}"))?;
    }

    let conn = Connection::open(db_path).map_err(|e| format!("failed to open sqlite: {e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("failed to set sqlite foreign_keys pragma: {e}"))?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("failed to init sqlite schema: {e}"))?;

    ensure_books_is_favorite_column(&conn)?;
    migrations::migrate_book_paths_to_appdata_relative(&conn, app)?;

    Ok(())
}

pub fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = app_paths::db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| format!("failed to open sqlite: {e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("failed to set sqlite foreign_keys pragma: {e}"))?;
    Ok(conn)
}

fn ensure_books_is_favorite_column(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(books)")
        .map_err(|e| format!("failed to prepare pragma table_info(books): {e}"))?;

    let cols = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("failed to query pragma table_info(books): {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to read pragma table_info(books) rows: {e}"))?;

    if cols.iter().any(|c| c == "is_favorite") {
        return Ok(());
    }

    conn.execute(
        "ALTER TABLE books ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
        [],
    )
    .map_err(|e| format!("failed to migrate books.is_favorite column: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn creates_required_tables() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(super::SCHEMA_SQL).unwrap();

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert!(names.contains(&"books".to_string()));
        assert!(names.contains(&"reading_state".to_string()));
        assert!(names.contains(&"bookmarks".to_string()));
        assert!(names.contains(&"highlights".to_string()));
        assert!(names.contains(&"settings".to_string()));
        assert!(names.contains(&"favorite_quotes".to_string()));
    }
}
