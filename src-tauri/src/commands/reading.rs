use std::collections::HashMap;

use rusqlite::params;

use crate::db;

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let conn = db::open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| format!("failed to prepare get_settings: {e}"))?;

    let mut out = HashMap::new();
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| format!("failed to query settings: {e}"))?;

    for row in rows {
        let (k, v) = row.map_err(|e| format!("failed to read setting row: {e}"))?;
        out.insert(k, v);
    }

    Ok(out)
}

#[tauri::command]
pub fn set_setting(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| format!("failed to upsert setting: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_and_get() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();

        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            params!["theme", "dark"],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params!["theme", "light"],
        )
        .unwrap();

        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1").unwrap();
        let value: String = stmt.query_row(["theme"], |row| row.get(0)).unwrap();
        assert_eq!(value, "light");
    }
}

