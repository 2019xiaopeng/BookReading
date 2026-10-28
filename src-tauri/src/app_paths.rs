use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rusqlite::Connection;
use tauri::Manager;

// settings 键：库根目录（绝对路径）。缺省 = AppData/library
pub const LIBRARY_ROOT_KEY: &str = "library_root";

pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to get app data dir: {e}"))
}

/// 解析后的存储位置。library_root 生效时 library 与 db 都落到新根（db 保持 db/app.sqlite 子结构）。
/// bootstrap_db 永远是 AppData 下那份：重启时先读它定位库根（否则"db 在哪"本身就是鸡生蛋问题）。
pub struct StorageRoots {
    pub library: PathBuf,
    pub db: PathBuf,
    pub bootstrap_db: PathBuf,
}

static ROOTS: OnceLock<StorageRoots> = OnceLock::new();

pub(crate) fn resolve_roots(appdata: &Path) -> StorageRoots {
    let bootstrap_db = appdata.join("db").join("app.sqlite");
    let defaults = StorageRoots {
        library: appdata.join("library"),
        db: bootstrap_db.clone(),
        bootstrap_db: bootstrap_db.clone(),
    };
    // 启动规则：设置有值且新根目录与其 db 都存在才启用；否则静默回退默认根（设置保留，重新挂载即恢复）
    match configured_library_root(&bootstrap_db)
        .filter(|r| r.is_dir() && r.join("db").join("app.sqlite").is_file())
    {
        Some(root) => StorageRoots {
            db: root.join("db").join("app.sqlite"),
            library: root,
            bootstrap_db,
        },
        None => defaults,
    }
}

// 纯读取：bootstrap db 里的 library_root 设置（文件缺失/表缺失/非绝对路径 → None）
pub(crate) fn configured_library_root(bootstrap_db: &Path) -> Option<PathBuf> {
    if !bootstrap_db.is_file() {
        return None;
    }
    let conn = Connection::open(bootstrap_db).ok()?;
    let value = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [LIBRARY_ROOT_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok();
    let path = PathBuf::from(value?.trim());
    path.is_absolute().then_some(path)
}

pub fn roots(app: &tauri::AppHandle) -> Result<&'static StorageRoots, String> {
    if let Some(r) = ROOTS.get() {
        return Ok(r);
    }
    let resolved = resolve_roots(&app_data_dir(app)?);
    Ok(ROOTS.get_or_init(move || resolved))
}

pub fn library_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(roots(app)?.library.clone())
}

pub fn books_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(library_dir(app)?.join("books"))
}

pub fn covers_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(library_dir(app)?.join("covers"))
}

pub fn trash_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(library_dir(app)?.join("trash"))
}

pub fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(roots(app)?.db.clone())
}

pub fn logs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("logs"))
}

/// DB 内 "library/..." 相对路径 → 当前库根下的绝对路径（库根可配置后所有取路径入口统一走这里）
pub fn library_abs(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    let v = rel.replace('\\', "/");
    let rest = v
        .strip_prefix("library/")
        .ok_or_else(|| format!("invalid library path: {rel}"))?;
    if Path::new(rest).components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir | std::path::Component::Prefix(_) | std::path::Component::RootDir
        )
    }) {
        return Err(format!("unsafe relative path: {rel}"));
    }
    Ok(library_dir(app)?.join(rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bookreading-paths-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn configured_library_root_reads_setting_from_bootstrap_db() {
        let dir = tempdir("read");
        let db = dir.join("db").join("app.sqlite");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![LIBRARY_ROOT_KEY, r"D:\mylib"],
        )
        .unwrap();
        drop(conn);

        assert_eq!(
            configured_library_root(&db),
            Some(PathBuf::from(r"D:\mylib"))
        );

        // 相对路径 / 空 / 无设置 → None
        let db2 = dir.join("db2.sqlite");
        let conn = Connection::open(&db2).unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![LIBRARY_ROOT_KEY, "relative/path"],
        )
        .unwrap();
        drop(conn);
        assert_eq!(configured_library_root(&db2), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_roots_uses_root_only_when_root_and_db_exist() {
        let appdata = tempdir("resolve");
        // 无设置 → 默认
        let r = resolve_roots(&appdata);
        assert_eq!(r.library, appdata.join("library"));
        assert_eq!(r.db, appdata.join("db").join("app.sqlite"));
        assert_eq!(r.bootstrap_db, appdata.join("db").join("app.sqlite"));

        // 写入设置但新根不存在 → 仍默认
        let bootstrap = appdata.join("db").join("app.sqlite");
        std::fs::create_dir_all(bootstrap.parent().unwrap()).unwrap();
        let conn = Connection::open(&bootstrap).unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![LIBRARY_ROOT_KEY, appdata.join("newroot").to_string_lossy().to_string()],
        )
        .unwrap();
        drop(conn);
        let r = resolve_roots(&appdata);
        assert_eq!(r.library, appdata.join("library"));

        // 新根与其 db 都在 → 启用
        std::fs::create_dir_all(appdata.join("newroot").join("db")).unwrap();
        std::fs::write(appdata.join("newroot").join("db").join("app.sqlite"), b"db").unwrap();
        let r = resolve_roots(&appdata);
        assert_eq!(r.library, appdata.join("newroot"));
        assert_eq!(r.db, appdata.join("newroot").join("db").join("app.sqlite"));
        assert_eq!(r.bootstrap_db, bootstrap);
        let _ = std::fs::remove_dir_all(&appdata);
    }
}
