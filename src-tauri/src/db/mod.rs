use std::fs;

use rusqlite::Connection;

use crate::app_paths;

pub fn init_db(app: &tauri::AppHandle) -> Result<(), String> {
    let db_path = app_paths::db_path(app)?;

    if let Some(dir) = db_path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create db dir: {e}"))?;
    }

    let conn = Connection::open(db_path).map_err(|e| format!("failed to open sqlite: {e}"))?;
    conn.execute_batch(include_str!("schema.sql"))
        .map_err(|e| format!("failed to init sqlite schema: {e}"))?;

    Ok(())
}

pub fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = app_paths::db_path(app)?;
    Connection::open(db_path).map_err(|e| format!("failed to open sqlite: {e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn creates_required_tables() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("schema.sql")).unwrap();

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

