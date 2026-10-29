use std::collections::HashMap;

use rusqlite::params;
use time::OffsetDateTime;

use crate::db;
use crate::models::ReadingState;

fn now_ts() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

#[tauri::command(async)]
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

#[tauri::command(async)]
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

/// 批量写设置（一次事务）：字号/行距滑杆 onCommit 一次落库，替代 N 次串行 setSetting IPC
#[tauri::command(async)]
pub fn set_settings(app: tauri::AppHandle, values: HashMap<String, String>) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("failed to begin set_settings: {e}"))?;
    for (key, value) in &values {
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|e| format!("failed to upsert setting {key}: {e}"))?;
    }
    tx.commit().map_err(|e| format!("failed to commit set_settings: {e}"))
}

// ---- A8 EPUB locations 持久化缓存（换字体字号档才重算）----

#[tauri::command(async)]
pub fn save_book_locations(
    app: tauri::AppHandle,
    book_id: String,
    cache_key: String,
    payload: String,
) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    conn.execute(
        "INSERT INTO book_locations (book_id, cache_key, payload, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id, cache_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
        params![book_id, cache_key, payload, now_ts()],
    )
    .map_err(|e| format!("failed to save book locations: {e}"))?;
    Ok(())
}

#[tauri::command(async)]
pub fn load_book_locations(
    app: tauri::AppHandle,
    book_id: String,
    cache_key: String,
) -> Result<Option<String>, String> {
    let conn = db::open_db(&app)?;
    match conn.query_row(
        "SELECT payload FROM book_locations WHERE book_id = ?1 AND cache_key = ?2",
        params![book_id, cache_key],
        |row| row.get::<_, String>(0),
    ) {
        Ok(p) => Ok(Some(p)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("failed to load book locations: {e}")),
    }
}

// ---- A9 阅读时长统计 ----

// 本地日期 YYYY-MM-DD（now_local 在多线程下个别平台可能失败，回退 UTC 日期只差时区边界一天）
fn local_date_string() -> String {
    let now = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
    format!("{:04}-{:02}-{:02}", now.year(), u8::from(now.month()), now.day())
}

#[tauri::command(async)]
pub fn add_reading_time(app: tauri::AppHandle, book_id: String, seconds: i64) -> Result<(), String> {
    if seconds <= 0 {
        return Ok(());
    }
    let conn = db::open_db(&app)?;
    conn.execute(
        "INSERT INTO reading_sessions (book_id, date, seconds) VALUES (?1, ?2, ?3)
         ON CONFLICT(book_id, date) DO UPDATE SET seconds = seconds + excluded.seconds",
        params![book_id, local_date_string(), seconds],
    )
    .map_err(|e| format!("failed to add reading time: {e}"))?;
    Ok(())
}

/// 每书累计阅读秒数（只统计未删除书）
#[tauri::command(async)]
pub fn list_reading_times(app: tauri::AppHandle) -> Result<HashMap<String, i64>, String> {
    let conn = db::open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT rs.book_id, SUM(rs.seconds) FROM reading_sessions rs
             JOIN books b ON b.id = rs.book_id
             WHERE b.deleted_at IS NULL
             GROUP BY rs.book_id",
        )
        .map_err(|e| format!("failed to prepare list_reading_times: {e}"))?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| format!("failed to query reading times: {e}"))?;
    let mut out = HashMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| format!("failed to read reading time row: {e}"))?;
        out.insert(k, v);
    }
    Ok(out)
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn upsert_reading_state(
    app: tauri::AppHandle,
    book_id: String,
    cfi: String,
    percent: Option<f64>,
) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    let ts = now_ts();
    conn.execute(
        "INSERT INTO reading_state (book_id, cfi, percent, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id) DO UPDATE SET cfi = excluded.cfi, percent = COALESCE(excluded.percent, percent), updated_at = excluded.updated_at",
        params![book_id, cfi, percent, ts],
    )
    .map_err(|e| format!("failed to upsert reading_state: {e}"))?;
    conn.execute(
        "UPDATE books SET last_opened_at = ?2 WHERE id = ?1",
        params![book_id, ts],
    )
    .map_err(|e| format!("failed to update last_opened_at: {e}"))?;

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
    fn reading_sessions_upsert_accumulates_per_date() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, cover_path, library_path, added_at, last_opened_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params!["b1", "t", "a", Option::<String>::None, "/tmp/b1.epub", 1i64, Option::<i64>::None],
        )
        .unwrap();

        // 同日两次累加（add_reading_time 命令体同款 SQL，本地日期由命令层生成）
        for seconds in [60i64, 30] {
            conn.execute(
                "INSERT INTO reading_sessions (book_id, date, seconds) VALUES (?1, ?2, ?3)
                 ON CONFLICT(book_id, date) DO UPDATE SET seconds = seconds + excluded.seconds",
                params!["b1", "2026-10-30", seconds],
            )
            .unwrap();
        }
        // 跨日独立成行
        conn.execute(
            "INSERT INTO reading_sessions (book_id, date, seconds) VALUES (?1, ?2, ?3)
             ON CONFLICT(book_id, date) DO UPDATE SET seconds = seconds + excluded.seconds",
            params!["b1", "2026-10-31", 45],
        )
        .unwrap();

        let total: i64 = conn
            .query_row("SELECT SUM(seconds) FROM reading_sessions WHERE book_id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 135);
        let days: i64 = conn
            .query_row("SELECT COUNT(*) FROM reading_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(days, 2);
    }

    #[test]
    fn local_date_string_is_iso_like() {
        let d = local_date_string();
        assert_eq!(d.len(), 10);
        assert_eq!(&d[4..5], "-");
        assert_eq!(&d[7..8], "-");
        assert!(d[..4].chars().all(|c| c.is_ascii_digit()));
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
             ON CONFLICT(book_id) DO UPDATE SET cfi = excluded.cfi, percent = COALESCE(excluded.percent, percent), updated_at = excluded.updated_at",
            params!["b1", "cfi2", 0.2f64, 2i64],
        )
        .unwrap();

        // shortcut: mirror only — the UPDATE lives in the command body (needs AppHandle); extract a db helper when this test must cover it
        conn.execute(
            "UPDATE books SET last_opened_at = ?2 WHERE id = ?1",
            params!["b1", 2i64],
        )
        .unwrap();

        let mut stmt = conn
            .prepare("SELECT cfi, percent FROM reading_state WHERE book_id = ?1")
            .unwrap();
        let (cfi, percent): (String, f64) = stmt.query_row(["b1"], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(cfi, "cfi2");
        assert_eq!(percent, 0.2);
        let last: Option<i64> = conn.query_row("SELECT last_opened_at FROM books WHERE id = ?1", ["b1"], |r| r.get(0)).unwrap();
        assert!(last.is_some());
    }
}
