use rusqlite::Connection;

use crate::app_paths;

fn is_likely_absolute(p: &str) -> bool {
    let p = p.trim();
    if p.starts_with("\\\\") || p.starts_with('/') {
        return true;
    }
    p.chars().nth(1) == Some(':')
}

fn normalize_seps(s: &str) -> String {
    s.replace('\\', "/")
}

fn normalize_rel(s: &str) -> String {
    let mut v = normalize_seps(s);
    while v.starts_with('/') {
        v.remove(0);
    }
    v
}

fn strip_base_prefix(path: &str, base: &str) -> Option<String> {
    let p = normalize_seps(path);
    let mut b = normalize_seps(base);
    while b.ends_with('/') {
        b.pop();
    }
    if cfg!(windows) {
        if !p.to_lowercase().starts_with(&b.to_lowercase()) {
            return None;
        }
        let rest = p[b.len()..].to_string();
        Some(normalize_rel(&rest))
    } else {
        if !p.starts_with(&b) {
            return None;
        }
        let rest = p[b.len()..].to_string();
        Some(normalize_rel(&rest))
    }
}

fn normalize_appdata_relative(value: &str, app_data_dir: &str) -> Option<String> {
    if value.trim().is_empty() {
        return None;
    }

    if !is_likely_absolute(value) {
        return Some(normalize_rel(value));
    }

    if let Some(rel) = strip_base_prefix(value, app_data_dir) {
        if rel.starts_with("library/") {
            return Some(rel);
        }
    }

    let v = normalize_seps(value);
    if let Some(idx) = v.to_lowercase().find("/library/") {
        return Some(normalize_rel(&v[idx + 1..]));
    }

    None
}

pub fn ensure_book_columns(conn: &Connection) -> Result<(), String> {
    for ddl in [
        "ALTER TABLE books ADD COLUMN note TEXT",
        "ALTER TABLE books ADD COLUMN group_name TEXT",
        "ALTER TABLE books ADD COLUMN pinned_at INTEGER",
        "ALTER TABLE books ADD COLUMN format TEXT",
        "ALTER TABLE books ADD COLUMN page_count INTEGER",
    ] {
        if let Err(e) = conn.execute(ddl, []) {
            if !e.to_string().contains("duplicate column name") {
                return Err(format!("failed to migrate book column: {e}"));
            }
        }
    }
    Ok(())
}

pub fn migrate_book_paths_to_appdata_relative(conn: &Connection, app: &tauri::AppHandle) -> Result<(), String> {
    let base = app_paths::app_data_dir(app)?;
    let base_str = base.to_string_lossy().to_string();

    let mut stmt = conn
        .prepare("SELECT id, library_path, cover_path, format FROM books")
        .map_err(|e| format!("failed to prepare migrate select: {e}"))?;

    let mut rows = stmt
        .query([])
        .map_err(|e| format!("failed to query migrate select: {e}"))?;

    let mut updates: Vec<(String, Option<String>, Option<String>)> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("failed to read migrate row: {e}"))? {
        let id: String = row.get(0).map_err(|e| format!("failed to read id: {e}"))?;
        let lib: String = row.get(1).map_err(|e| format!("failed to read library_path: {e}"))?;
        let cover: Option<String> = row.get(2).map_err(|e| format!("failed to read cover_path: {e}"))?;
        let format: Option<String> = row.get(3).map_err(|e| format!("failed to read format: {e}"))?;

        // 图片书可能是原地引用的绝对路径（即使含 library/ 也不是 appdata 相对路径），跳过不改写
        if format.as_deref() == Some("images") {
            continue;
        }

        let new_lib_opt = normalize_appdata_relative(&lib, &base_str);
        let new_cover_opt = cover
            .as_deref()
            .and_then(|c| normalize_appdata_relative(c, &base_str));

        let lib_changed = new_lib_opt.as_deref().map_or(false, |v| v != lib);
        let cover_changed = new_cover_opt.as_deref().map_or(false, |v| Some(v) != cover.as_deref());

        if lib_changed || cover_changed {
            updates.push((id, Some(new_lib_opt.unwrap_or(lib)), new_cover_opt.or(cover)));
        }
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("failed to begin migrate transaction: {e}"))?;
    for (id, lib, cover) in updates {
        tx.execute(
            "UPDATE books SET library_path = ?2, cover_path = ?3 WHERE id = ?1",
            rusqlite::params![id, lib, cover],
        )
        .map_err(|e| format!("failed to update migrated paths: {e}"))?;
    }
    tx.commit()
        .map_err(|e| format!("failed to commit migrate transaction: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_book_columns_adds_missing_columns_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books (
                id TEXT PRIMARY KEY,
                title TEXT,
                author TEXT,
                cover_path TEXT,
                library_path TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                last_opened_at INTEGER,
                is_favorite INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();

        ensure_book_columns(&conn).unwrap();

        let mut stmt = conn.prepare("PRAGMA table_info(books)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(cols.contains(&"note".to_string()));
        assert!(cols.contains(&"group_name".to_string()));
        assert!(cols.contains(&"pinned_at".to_string()));
        assert!(cols.contains(&"format".to_string()));
        assert!(cols.contains(&"page_count".to_string()));

        ensure_book_columns(&conn).unwrap();
    }

    #[test]
    fn normalize_absolute_to_appdata_relative() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA_SQL).unwrap();

        let app_data = r"C:\Users\me\AppData\Roaming\com.root.bookreading";
        let lib = r"C:\Users\me\AppData\Roaming\com.root.bookreading\library\books\b1.epub";
        let cover = r"C:\Users\me\AppData\Roaming\com.root.bookreading\library\covers\b1.jpg";

        let new_lib = normalize_appdata_relative(lib, app_data).unwrap();
        let new_cover = normalize_appdata_relative(cover, app_data).unwrap();

        assert_eq!(new_lib, "library/books/b1.epub");
        assert_eq!(new_cover, "library/covers/b1.jpg");
    }
}
