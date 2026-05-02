use std::fs;

use rusqlite::Connection;

use crate::app_paths;

pub const SCHEMA_SQL: &str = include_str!("schema.sql");

pub fn init_db(app: &tauri::AppHandle) -> Result<(), String> {
    let db_path = app_paths::db_path(app)?;

    if let Some(dir) = db_path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create db dir: {e}"))?;
    }

    let conn = Connection::open(db_path).map_err(|e| format!("failed to open sqlite: {e}"))?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("failed to init sqlite schema: {e}"))?;

    Ok(())
}

pub fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = app_paths::db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| format!("failed to open sqlite: {e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("failed to set sqlite foreign_keys pragma: {e}"))?;
    Ok(conn)
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
    }
}
