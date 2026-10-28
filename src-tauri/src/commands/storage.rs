use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::app_paths;
use crate::commands::images::folder_image_files;
use crate::commands::library::{atomic_copy_to, require_library_rel};
use crate::db;

pub(crate) fn dir_size_bytes(path: &Path) -> u64 {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for e in entries.flatten() {
            total += dir_size_bytes(&e.path());
        }
    }
    total
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("failed to create {}: {e}", dst.display()))?;
    let entries = fs::read_dir(src).map_err(|e| format!("failed to read {}: {e}", src.display()))?;
    for e in entries.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| format!("failed to copy {}: {e}", from.display()))?;
        }
    }
    Ok(())
}

fn norm_lower(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

// shortcut: 词法包含判断（未 canonicalize，junction/符号链接会被绕过）；迁移是一次性低频操作，足够
fn path_contains(parent: &Path, child: &Path) -> bool {
    let p = norm_lower(parent);
    let c = norm_lower(child);
    !p.is_empty() && (c == p || c.starts_with(&format!("{p}/")))
}

#[cfg(windows)]
fn available_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    // 目标可能不存在：向上找最近存在的祖先查所在盘剩余
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let wide: Vec<u16> = probe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut())
    };
    (ok != 0).then_some(free)
}

#[cfg(not(windows))]
fn available_bytes(_path: &Path) -> Option<u64> {
    None
}

pub(crate) fn format_bytes(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", units[i])
    }
}

pub(crate) struct MigratePaths {
    pub library: PathBuf,
    pub db: PathBuf,
    pub bootstrap_db: PathBuf,
}

fn write_root_setting(db_file: &Path, root: &Path) -> Result<(), String> {
    if let Some(dir) = db_file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create db dir: {e}"))?;
    }
    let conn = Connection::open(db_file).map_err(|e| format!("failed to open {}: {e}", db_file.display()))?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .map_err(|e| format!("failed to ensure settings table: {e}"))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![app_paths::LIBRARY_ROOT_KEY, root.to_string_lossy().to_string()],
    )
    .map_err(|e| format!("failed to save library_root setting: {e}"))?;
    Ok(())
}

/// 迁移核心（可在测试里对临时目录运行）：复制 library 子目录 + db 到新根，
/// 全部成功后写设置（bootstrap db + 新根 db），任一步失败清掉新根残留、不写设置。
/// 返回复制的数据量（字节）。
pub(crate) fn migrate_library_root_core(cur: &MigratePaths, new_root: &Path) -> Result<u64, String> {
    if !new_root.is_absolute() {
        return Err("新库根目录必须是绝对路径".to_string());
    }
    if norm_lower(new_root) == norm_lower(&cur.library) {
        return Err("新目录与当前库根相同".to_string());
    }
    if path_contains(&cur.library, new_root) {
        return Err("目标目录不能位于当前书库内".to_string());
    }
    if path_contains(new_root, &cur.library) {
        return Err("目标目录不能包含当前书库".to_string());
    }
    if let Ok(meta) = fs::symlink_metadata(new_root) {
        if !meta.is_dir() {
            return Err("目标路径已存在且不是文件夹".to_string());
        }
        // 目标已有同名数据 → 拒绝，防止脏合并
        for name in ["books", "covers", "bg", "trash", "db"] {
            let p = new_root.join(name);
            if p.is_file() {
                return Err(format!("目标目录下已存在同名文件 {name}，请选择一个空目录"));
            }
            if p.is_dir() {
                let non_empty = fs::read_dir(&p).map(|mut it| it.next().is_some()).unwrap_or(false);
                if non_empty {
                    return Err(format!("目标目录下已存在非空的 {name}，请选择一个空目录"));
                }
            }
        }
    }

    // 粗查磁盘剩余：需 ≥ 数据量 × 1.1（查不到剩余时跳过，交给复制阶段兜底）
    let used = dir_size_bytes(&cur.library) + fs::metadata(&cur.db).map(|m| m.len()).unwrap_or(0);
    let needed = used + used / 10;
    if let Some(free) = available_bytes(new_root) {
        if free < needed {
            return Err(format!(
                "目标磁盘剩余空间不足：需约 {}，当前可用 {}",
                format_bytes(needed),
                format_bytes(free)
            ));
        }
    }

    let created_root = !new_root.exists();
    fs::create_dir_all(new_root).map_err(|e| format!("failed to create {}: {e}", new_root.display()))?;
    let mut copied: Vec<PathBuf> = Vec::new();
    let copy_all = (|| -> Result<(), String> {
        for sub in ["books", "covers", "bg", "trash"] {
            let from = cur.library.join(sub);
            if from.is_dir() {
                let to = new_root.join(sub);
                copy_dir(&from, &to)?;
                copied.push(to);
            }
        }
        let to_db_dir = new_root.join("db");
        fs::create_dir_all(&to_db_dir).map_err(|e| format!("failed to create db dir: {e}"))?;
        let to_db = to_db_dir.join("app.sqlite");
        fs::copy(&cur.db, &to_db).map_err(|e| format!("failed to copy database: {e}"))?;
        copied.push(to_db_dir);
        Ok(())
    })();
    if let Err(e) = copy_all {
        cleanup_copied(&copied, new_root, created_root);
        return Err(format!("迁移失败，已清理目标目录残留：{e}"));
    }

    // 全部复制成功 → 写设置：bootstrap（重启定位入口，永不少于这一份）+ 新根 db 副本（迁移后活动库）
    let new_db = new_root.join("db").join("app.sqlite");
    if let Err(e) = write_root_setting(&cur.bootstrap_db, new_root) {
        cleanup_copied(&copied, new_root, created_root);
        return Err(format!("迁移失败，已清理目标目录残留：{e}"));
    }
    if cur.bootstrap_db != new_db {
        if let Err(e) = write_root_setting(&new_db, new_root) {
            cleanup_copied(&copied, new_root, created_root);
            return Err(format!("迁移失败，已清理目标目录残留：{e}"));
        }
    }
    Ok(used)
}

fn cleanup_copied(copied: &[PathBuf], root: &Path, created_root: bool) {
    for p in copied.iter().rev() {
        let _ = fs::remove_dir_all(p);
    }
    if created_root {
        let _ = fs::remove_dir(root);
    }
}

#[tauri::command]
pub fn migrate_library_root(app: tauri::AppHandle, new_root: String) -> Result<String, String> {
    let new_root = PathBuf::from(new_root.trim());
    let roots = app_paths::roots(&app)?;
    let paths = MigratePaths {
        library: roots.library.clone(),
        db: roots.db.clone(),
        bootstrap_db: roots.bootstrap_db.clone(),
    };
    // 命令内不持有任何 sqlite 连接（各命令自开自关、同步串行），db 文件可安全复制
    let used = migrate_library_root_core(&paths, &new_root)?;
    Ok(format!("已复制 {}。重启应用后新库生效。", format_bytes(used)))
}

#[derive(Debug, Serialize)]
pub struct StorageStats {
    pub library_root: String,
    pub db_path: String,
    // library_bytes = 书籍文件（books/，含回收站中已移入 trash/ 的文件则另计 trash_count）
    pub library_bytes: u64,
    pub covers_bytes: u64,
    pub bg_bytes: u64,
    pub db_bytes: u64,
    pub logs_bytes: u64,
    pub trash_count: u64,
}

pub(crate) fn storage_stats_core(library: &Path, db: &Path, logs: &Path) -> StorageStats {
    let trash_count = fs::read_dir(library.join("trash"))
        .map(|it| it.flatten().count() as u64)
        .unwrap_or(0);
    StorageStats {
        library_root: library.to_string_lossy().to_string(),
        db_path: db.to_string_lossy().to_string(),
        library_bytes: dir_size_bytes(&library.join("books")),
        covers_bytes: dir_size_bytes(&library.join("covers")),
        bg_bytes: dir_size_bytes(&library.join("bg")),
        db_bytes: dir_size_bytes(db),
        logs_bytes: dir_size_bytes(logs),
        trash_count,
    }
}

#[tauri::command]
pub fn storage_stats(app: tauri::AppHandle) -> Result<StorageStats, String> {
    let library = app_paths::library_dir(&app)?;
    let db = app_paths::db_path(&app)?;
    let logs = app_paths::logs_dir(&app)?;
    Ok(storage_stats_core(&library, &db, &logs))
}

/// 删除目录下全部条目（目录递归），返回释放字节数
fn remove_dir_contents(dir: &Path) -> Result<u64, String> {
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut freed = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            freed += dir_size_bytes(&p);
            if p.is_dir() {
                let _ = fs::remove_dir_all(&p);
            } else {
                let _ = fs::remove_file(&p);
            }
        }
    }
    Ok(freed)
}

/// 清空 covers：文件夹漫画（源目录还在）重拷首页封面；其余书 cover_path 置空。
/// epub 封面随后由书库页的自动 repair 重提；CBZ/TXT 回退文字卡，可在详情页手动换封面。
fn clear_covers_core(conn: &Connection, covers_dir: &Path) -> Result<u64, String> {
    let freed = remove_dir_contents(covers_dir)?;
    fs::create_dir_all(covers_dir).map_err(|e| format!("failed to create covers dir: {e}"))?;

    let rows: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn
            .prepare("SELECT id, library_path, format FROM books")
            .map_err(|e| format!("failed to prepare books select: {e}"))?;
        let collected = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| format!("failed to query books: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to read books: {e}"))?;
        collected
    };

    for (id, library_path, format) in rows {
        let lp = library_path.replace('\\', "/");
        let is_folder_comic = format.as_deref() == Some("images")
            && !lp.to_lowercase().ends_with(".cbz")
            && Path::new(&lp).is_absolute();
        let rebuilt = if is_folder_comic {
            folder_image_files(Path::new(&lp))
                .ok()
                .and_then(|pages| pages.first().cloned())
                .and_then(|first| {
                    let ext = first
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_lowercase())
                        .unwrap_or_else(|| "png".to_string());
                    let final_cover = covers_dir.join(format!("{id}.{ext}"));
                    let tmp_cover = covers_dir.join(format!("{id}.{ext}.part"));
                    atomic_copy_to(&first.to_string_lossy(), &tmp_cover, &final_cover)
                        .ok()
                        .map(|_| format!("library/covers/{id}.{ext}"))
                })
        } else {
            None
        };
        match rebuilt {
            Some(cover_path) => {
                conn.execute(
                    "UPDATE books SET cover_path = ?2 WHERE id = ?1",
                    params![id, cover_path],
                )
                .map_err(|e| format!("failed to update cover: {e}"))?;
            }
            None => {
                conn.execute(
                    "UPDATE books SET cover_path = NULL WHERE id = ?1 AND cover_path IS NOT NULL",
                    [&id],
                )
                .map_err(|e| format!("failed to clear cover: {e}"))?;
            }
        }
    }
    Ok(freed)
}

#[derive(Debug, Serialize)]
pub struct ClearCacheResult {
    pub freed_bytes: u64,
}

const CLEARABLE_CATEGORIES: [&str; 3] = ["covers", "bg", "logs"];

#[tauri::command]
pub fn clear_cache(app: tauri::AppHandle, categories: Vec<String>) -> Result<ClearCacheResult, String> {
    if categories.is_empty() {
        return Err("请选择要清理的类别".to_string());
    }
    for c in &categories {
        if !CLEARABLE_CATEGORIES.contains(&c.as_str()) {
            return Err(format!("“{c}”不可清理：书库文件与数据库不可清理"));
        }
    }

    let library = app_paths::library_dir(&app)?;
    let mut freed = 0u64;
    for cat in &categories {
        match cat.as_str() {
            "covers" => {
                let conn = db::open_db(&app)?;
                freed += clear_covers_core(&conn, &library.join("covers"))?;
            }
            "bg" => {
                freed += remove_dir_contents(&library.join("bg"))?;
                let conn = db::open_db(&app)?;
                conn.execute("DELETE FROM settings WHERE key = 'reader_bg'", [])
                    .map_err(|e| format!("failed to reset reader_bg: {e}"))?;
            }
            "logs" => {
                freed += remove_dir_contents(&app_paths::logs_dir(&app)?)?;
            }
            _ => unreachable!(),
        }
    }
    Ok(ClearCacheResult { freed_bytes: freed })
}

/// 拖拽/批量导入前的探针：webview 拿不到 is_dir 与文件大小，由主进程补齐
#[derive(Debug, Serialize)]
pub struct PathInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
pub fn probe_paths(paths: Vec<String>) -> Result<Vec<PathInfo>, String> {
    paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            let meta = fs::symlink_metadata(path).map_err(|e| format!("{p}: {e}"))?;
            Ok(PathInfo {
                path: p.clone(),
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone()),
                is_dir: meta.is_dir(),
                size: if meta.is_dir() { dir_size_bytes(path) } else { meta.len() },
            })
        })
        .collect()
}

/// 前端读库内文件（封面/背景/epub）的唯一入口：按当前库根解析 "library/..." 相对路径。
/// 库根可配置后不再能直接用 AppData 作为 baseDir 读这些文件。
#[tauri::command]
pub fn read_library_file(app: tauri::AppHandle, rel: String) -> Result<tauri::ipc::Response, String> {
    let v = rel.replace('\\', "/");
    require_library_rel(&v)?;
    let abs = app_paths::library_abs(&app, &v)?;
    let bytes = fs::read(&abs).map_err(|e| format!("failed to read {v}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bookreading-storage-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_library(appdata: &Path) -> MigratePaths {
        let library = appdata.join("library");
        for sub in ["books", "covers", "bg", "trash"] {
            fs::create_dir_all(library.join(sub)).unwrap();
        }
        fs::write(library.join("books").join("b1.epub"), vec![0u8; 100]).unwrap();
        fs::write(library.join("covers").join("b1.jpg"), vec![0u8; 40]).unwrap();
        fs::write(library.join("bg").join("bg.png"), vec![0u8; 60]).unwrap();
        fs::write(library.join("trash").join("t.bin"), vec![0u8; 10]).unwrap();
        let bootstrap_db = appdata.join("db").join("app.sqlite");
        fs::create_dir_all(bootstrap_db.parent().unwrap()).unwrap();
        let conn = Connection::open(&bootstrap_db).unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        drop(conn);
        MigratePaths {
            library,
            db: bootstrap_db.clone(),
            bootstrap_db,
        }
    }

    #[test]
    fn migrate_copies_data_and_writes_settings() {
        let appdata = tempdir("ok");
        let cur = make_library(&appdata);
        let new_root = tempdir("dest");
        fs::remove_dir_all(&new_root).unwrap(); // 让迁移自己创建根目录

        let used = migrate_library_root_core(&cur, &new_root).unwrap();
        assert_eq!(used, 210 + fs::metadata(&cur.db).unwrap().len()); // 数据子目录 + db 文件
        assert_eq!(fs::read(new_root.join("books").join("b1.epub")).unwrap().len(), 100);
        assert!(new_root.join("covers").join("b1.jpg").exists());
        assert!(new_root.join("bg").join("bg.png").exists());
        assert!(new_root.join("trash").join("t.bin").exists());
        assert!(new_root.join("db").join("app.sqlite").exists());

        // 两份 db 都写入 library_root
        let check = |db_file: &Path| {
            let conn = Connection::open(db_file).unwrap();
            let v: String = conn
                .query_row("SELECT value FROM settings WHERE key = 'library_root'", [], |r| r.get(0))
                .unwrap();
            v
        };
        assert_eq!(check(&cur.bootstrap_db), new_root.to_string_lossy().to_string());
        assert_eq!(check(&new_root.join("db").join("app.sqlite")), new_root.to_string_lossy().to_string());

        // 源不动（复制式迁移，旧根留作回滚兜底）
        assert!(cur.library.join("books").join("b1.epub").exists());
        let _ = fs::remove_dir_all(&appdata);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn migrate_rejects_subdir_and_same_root() {
        let appdata = tempdir("reject");
        let cur = make_library(&appdata);
        assert!(migrate_library_root_core(&cur, &cur.library).unwrap_err().contains("相同"));
        let inside = cur.library.join("inner");
        assert!(migrate_library_root_core(&cur, &inside).unwrap_err().contains("当前书库内"));
        // 包含当前库根的祖先目录也拒绝
        assert!(migrate_library_root_core(&cur, &appdata).unwrap_err().contains("包含当前书库"));
        // 相对路径拒绝
        assert!(migrate_library_root_core(&cur, Path::new("rel")).unwrap_err().contains("绝对路径"));
        let _ = fs::remove_dir_all(&appdata);
    }

    #[test]
    fn migrate_failure_cleans_up_and_writes_nothing() {
        let appdata = tempdir("fail");
        let mut cur = make_library(&appdata);
        // db 源缺失：数据子目录复制成功后，复制 db 时失败 → 触发清理
        cur.db = appdata.join("db").join("missing.sqlite");
        let new_root = tempdir("faildest");

        let err = migrate_library_root_core(&cur, &new_root).unwrap_err();
        assert!(err.contains("迁移失败"), "{err}");
        // 已复制的 books/covers 已被清理，设置未写入
        assert!(!new_root.join("books").exists());
        assert!(!new_root.join("covers").exists());
        assert!(!new_root.join("bg").exists());
        let conn = Connection::open(&cur.bootstrap_db).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key = 'library_root'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let _ = fs::remove_dir_all(&appdata);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn migrate_rejects_nonempty_target_data_dirs() {
        let appdata = tempdir("dirty");
        let cur = make_library(&appdata);
        let new_root = tempdir("dirtydest");
        fs::create_dir_all(new_root.join("books")).unwrap();
        fs::write(new_root.join("books").join("x.epub"), b"x").unwrap();
        assert!(migrate_library_root_core(&cur, &new_root).unwrap_err().contains("非空"));
        let _ = fs::remove_dir_all(&appdata);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn storage_stats_counts_magnitudes() {
        let appdata = tempdir("stats");
        let cur = make_library(&appdata);
        let logs = appdata.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join("startup.log"), vec![0u8; 5]).unwrap();

        let stats = storage_stats_core(&cur.library, &cur.db, &logs);
        assert_eq!(stats.library_bytes, 100);
        assert_eq!(stats.covers_bytes, 40);
        assert_eq!(stats.bg_bytes, 60);
        assert!(stats.db_bytes > 0); // 真实 sqlite 文件
        assert_eq!(stats.logs_bytes, 5);
        assert_eq!(stats.trash_count, 1);
        let _ = fs::remove_dir_all(&appdata);
    }

    #[test]
    fn clear_covers_rebuilds_folder_comic_covers_and_nulls_rest() {
        let appdata = tempdir("clear");
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();

        let covers = appdata.join("covers");
        fs::create_dir_all(&covers).unwrap();
        fs::write(covers.join("f1.jpg"), vec![0u8; 11]).unwrap();
        fs::write(covers.join("e2.png"), vec![0u8; 22]).unwrap();

        // 文件夹漫画：源目录在 → 重拷首页
        let src = appdata.join("comic");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("p1.png"), vec![0u8; 33]).unwrap();
        conn.execute(
            "INSERT INTO books (id, library_path, added_at, format, cover_path) VALUES ('f1', ?1, 1, 'images', 'library/covers/f1.jpg')",
            params![src.to_string_lossy().to_string()],
        )
        .unwrap();
        // epub：置空（repair 会重提）
        conn.execute(
            "INSERT INTO books (id, library_path, added_at, cover_path) VALUES ('e2', 'library/books/e2.epub', 1, 'library/covers/e2.png')",
            [],
        )
        .unwrap();

        let freed = clear_covers_core(&conn, &covers).unwrap();
        assert_eq!(freed, 33); // 旧封面 11+22
        assert_eq!(fs::read(covers.join("f1.png")).unwrap().len(), 33);
        assert!(!covers.join("f1.jpg").exists());
        assert!(!covers.join("e2.png").exists());
        let cover = |id: &str| -> Option<String> {
            conn.query_row("SELECT cover_path FROM books WHERE id = ?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(cover("f1").as_deref(), Some("library/covers/f1.png"));
        assert_eq!(cover("e2"), None);
        let _ = fs::remove_dir_all(&appdata);
    }

    #[test]
    fn format_bytes_units() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2.0 KB");
        assert_eq!(format_bytes(3 * 1024 * 1024), "3.0 MB");
    }
}
