use std::fs;
use std::ops::Deref;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use tauri::Manager;
use time::OffsetDateTime;

use crate::app_paths;
use crate::commands;

pub const SCHEMA_SQL: &str = include_str!("schema.sql");

mod migrations;

/// 全局唯一托管连接（lib.rs setup 时 init_db 建库并 manage）。
/// 旧版每命令各开各的连接，async 化后并发命令各自开连接会放大锁开销，改为单连接串行复用。
pub struct Db(pub Mutex<Connection>);

/// open_db 返回的守卫：持有期间独占托管连接，Deref 到 &Connection，调用方代码与旧版零改动。
pub struct DbGuard<'a> {
    conn: MutexGuard<'a, Connection>,
    // State 保活：MutexGuard 的生命周期锚在托管状态上，丢掉 State 会悬垂
    _keep: tauri::State<'a, Db>,
}

impl Deref for DbGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.conn
    }
}

pub fn init_db(app: &tauri::AppHandle) -> Result<(), String> {
    let db_path = app_paths::db_path(app)?;

    if let Some(dir) = db_path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create db dir: {e}"))?;
    }

    let conn = Connection::open(db_path).map_err(|e| format!("failed to open sqlite: {e}"))?;
    // WAL：迁移复制 db 文件前会先 checkpoint，主文件始终自洽；busy_timeout 容忍后台线程的短暂并发
    conn.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
    )
    .map_err(|e| format!("failed to set sqlite pragmas: {e}"))?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("failed to init sqlite schema: {e}"))?;

    ensure_books_is_favorite_column(&conn)?;
    migrations::ensure_book_columns(&conn)?;
    migrations::ensure_highlight_text(&conn)?;
    migrations::migrate_book_paths_to_appdata_relative(&conn, app)?;
    migrations::migrate_groups_to_shelves(&conn)?;
    // 回收站到期自动清理（保留期 0 = 永不）；启动失败不阻断应用
    if let Ok(library_dir) = app_paths::library_dir(app) {
        let _ = commands::shelves::purge_expired_trash(
            &conn,
            &library_dir,
            OffsetDateTime::now_utc().unix_timestamp(),
        );
    }

    // 建库用的这条连接直接交给托管状态（含全部 pragma），后续命令共用
    app.manage(Db(Mutex::new(conn)));

    Ok(())
}

/// 命令统一入口：取托管连接并加锁（锁随 DbGuard 释放）。
pub fn open_db(app: &tauri::AppHandle) -> Result<DbGuard<'_>, String> {
    let state = app.state::<Db>();
    let conn = state
        .inner()
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    Ok(DbGuard { conn, _keep: state })
}

/// 后台线程专用：独立开连接（WAL 支持多连接并发），不与命令争托管锁
pub fn open_db_bg(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = app_paths::db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| format!("failed to open sqlite: {e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
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
        assert!(names.contains(&"tags".to_string()));
        assert!(names.contains(&"book_tags".to_string()));
        assert!(names.contains(&"reading_state".to_string()));
        assert!(names.contains(&"bookmarks".to_string()));
        assert!(names.contains(&"highlights".to_string()));
        assert!(names.contains(&"settings".to_string()));
        assert!(names.contains(&"favorite_quotes".to_string()));
        assert!(names.contains(&"book_locations".to_string()));
        assert!(names.contains(&"reading_sessions".to_string()));
    }

    #[test]
    fn creates_secondary_indexes() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(super::SCHEMA_SQL).unwrap();
        conn.execute_batch(super::SCHEMA_SQL).unwrap(); // 幂等

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for name in [
            "idx_books_shelf_id",
            "idx_book_tags_book_id",
            "idx_highlights_book_id",
            "idx_reading_state_book_id",
        ] {
            assert!(names.contains(&name.to_string()), "missing index {name}");
        }
    }
}
