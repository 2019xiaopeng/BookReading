use std::collections::HashMap;

use rusqlite::params;
use time::OffsetDateTime;

use crate::db;
use crate::models::ReadingState;

fn now_ts() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

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

#[tauri::command]
pub fn get_reading_state(app: tauri::AppHandle, book_id: String) -> Result<Option<ReadingState>, String> {
    let conn = db::open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT book_id, cfi, percent, updated_at FROM reading_state WHERE book_id = ?1")
        .map_err(|e| format!("failed to prepare get_reading_state: {e}"))?;

    let mut rows = stmt
        .query([book_id])
        .map_err(|e| format!("failed to query get_reading_state: {e}"))?;

    if let Some(row) = rows
        .next()
        .map_err(|e| format!("failed to read get_reading_state row: {e}"))?
    {
        return Ok(Some(ReadingState {
            book_id: row.get(0).map_err(|e| format!("failed to read book_id: {e}"))?,
            cfi: row.get(1).map_err(|e| format!("failed to read cfi: {e}"))?,
            percent: row.get(2).map_err(|e| format!("failed to read percent: {e}"))?,
            updated_at: row.get(3).map_err(|e| format!("failed to read updated_at: {e}"))?,
        }));
    }

    Ok(None)
}

#[tauri::command]
pub fn upsert_reading_state(
    app: tauri::AppHandle,
    book_id: String,
    cfi: String,
    percent: Option<f64>,
) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    conn.execute(
        "INSERT INTO reading_state (book_id, cfi, percent, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id) DO UPDATE SET cfi = excluded.cfi, percent = excluded.percent, updated_at = excluded.updated_at",
        params![book_id, cfi, percent, now_ts()],
    )
    .map_err(|e| format!("failed to upsert reading_state: {e}"))?;

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

    #[test]
    fn upsert_reading_state_overwrites() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, cover_path, library_path, added_at, last_opened_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params!["b1", "t", "a", Option::<String>::None, "/tmp/b1.epub", 1i64, Option::<i64>::None],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO reading_state (book_id, cfi, percent, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params!["b1", "cfi1", 0.1f64, 1i64],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO reading_state (book_id, cfi, percent, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(book_id) DO UPDATE SET cfi = excluded.cfi, percent = excluded.percent, updated_at = excluded.updated_at",
            params!["b1", "cfi2", 0.2f64, 2i64],
        )
        .unwrap();

        let mut stmt = conn
            .prepare("SELECT cfi, percent FROM reading_state WHERE book_id = ?1")
            .unwrap();
        let (cfi, percent): (String, f64) = stmt.query_row(["b1"], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(cfi, "cfi2");
        assert_eq!(percent, 0.2);
    }
}
