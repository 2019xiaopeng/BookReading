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

    let conn = Connection::open(&db_path).map_err(|e| format!("failed to open sqlite: {e}"))?;
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
    // H-7 启动滚动备份（db 有变更才复制，保留最近 3 份）；失败静默不阻断启动
    if let Err(e) = rolling_backup(&conn, &db_path) {
        eprintln!("[backup] {e}");
    }
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

/// H-7 启动滚动备份：db 文件 mtime 与 backup/last-backup-marker 不一致（即上次备份后有写入）时
/// 复制一份 app-YYYYMMDD.sqlite 并更新 marker；同日重复启动覆盖当日那份；保留最近 3 份。
/// 先 wal_checkpoint 让主文件自洽再复制。core takes db_path so tests can run against a tempdir.
pub(crate) fn rolling_backup(conn: &Connection, db_path: &std::path::Path) -> Result<(), String> {
    let backup_dir = db_path
        .parent()
        .ok_or_else(|| "db path has no parent dir".to_string())?
        .join("backup");
    fs::create_dir_all(&backup_dir).map_err(|e| format!("failed to create backup dir: {e}"))?;
    // checkpoint 在读 mtime 前：有 WAL 帧落盘才算真变更，否则 mtime 不动、不重复备份
    let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    let mtime = fs::metadata(db_path)
        .and_then(|m| m.modified())
        .map_err(|e| format!("failed to read db mtime: {e}"))?;
    let mtime_s = mtime
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("bad mtime: {e}"))?
        .as_secs()
        .to_string();
    let marker = backup_dir.join("last-backup-marker");
    if fs::read_to_string(&marker).ok().as_deref() == Some(mtime_s.as_str()) {
        return Ok(()); // 自上次备份后无变更
    }

    let now = OffsetDateTime::now_utc();
    let dest = backup_dir.join(format!(
        "app-{:04}{:02}{:02}.sqlite",
        now.year(),
        u8::from(now.month()),
        now.day()
    ));
    fs::copy(db_path, &dest).map_err(|e| format!("failed to copy db: {e}"))?;
    fs::write(&marker, &mtime_s).map_err(|e| format!("failed to write marker: {e}"))?;

    // 保留最近 3 份（app-YYYYMMDD 字典序 = 时间序）
    let mut backups: Vec<std::path::PathBuf> = fs::read_dir(&backup_dir)
        .map_err(|e| format!("failed to list backups: {e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension().and_then(|e| e.to_str()) == Some("sqlite")
                && p.file_stem()
                    .and_then(|s| s.to_str())
                    .map_or(false, |s| s.starts_with("app-"))
        })
        .collect();
    backups.sort();
    while backups.len() > 3 {
        let oldest = backups.remove(0);
        let _ = fs::remove_file(&oldest);
    }
    Ok(())
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
    use super::*;

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

    // ---- H-7 启动滚动备份 ----

    fn temp_db_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bookreading-bk-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("db")).unwrap();
        dir.join("db")
    }

    #[test]
    fn rolling_backup_copies_once_and_skips_unchanged() {
        let db_dir = temp_db_dir();
        let db_path = db_dir.join("app.sqlite");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(SCHEMA_SQL).unwrap();
        } // 落盘后 mtime 固定

        {
            let conn = Connection::open(&db_path).unwrap();
            rolling_backup(&conn, &db_path).unwrap();
        }
        let backup_dir = db_dir.join("backup");
        let count = |dir: &std::path::Path| -> usize {
            fs::read_dir(dir)
                .unwrap()
                .flatten()
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("sqlite"))
                .count()
        };
        assert_eq!(count(&backup_dir), 1);
        assert!(backup_dir.join("last-backup-marker").is_file());
        // 无变更再跑：不新增备份
        {
            let conn = Connection::open(&db_path).unwrap();
            rolling_backup(&conn, &db_path).unwrap();
        }
        assert_eq!(count(&backup_dir), 1);
        let _ = fs::remove_dir_all(db_dir.parent().unwrap());
    }

    #[test]
    fn rolling_backup_keeps_only_three_newest() {
        let db_dir = temp_db_dir();
        let db_path = db_dir.join("app.sqlite");
        fs::write(&db_path, b"db").unwrap();
        let backup_dir = db_dir.join("backup");
        fs::create_dir_all(&backup_dir).unwrap();
        for d in ["20260101", "20260202", "20260303", "20260404", "20260505"] {
            fs::write(backup_dir.join(format!("app-{d}.sqlite")), d.as_bytes()).unwrap();
        }
        fs::write(backup_dir.join("last-backup-marker"), "0").unwrap(); // 强制视为有变更

        let conn = Connection::open(&db_path).unwrap();
        rolling_backup(&conn, &db_path).unwrap();

        let mut left: Vec<String> = fs::read_dir(&backup_dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.path().file_stem().and_then(|s| s.to_str()).map(String::from))
            .filter(|s| s.starts_with("app-"))
            .collect();
        left.sort();
        // 今日新备份 + 最新的两份历史（20260404/20260505），旧三份删除
        assert_eq!(left.len(), 3);
        assert!(left.contains(&"app-20260404".to_string()));
        assert!(left.contains(&"app-20260505".to_string()));
        let _ = fs::remove_dir_all(db_dir.parent().unwrap());
    }
}
