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

pub fn migrate_book_paths_to_appdata_relative(conn: &Connection, app: &tauri::AppHandle) -> Result<(), String> {
    let base = app_paths::app_data_dir(app)?;
    let base_str = base.to_string_lossy().to_string();

    let mut stmt = conn
        .prepare("SELECT id, library_path, cover_path FROM books")
        .map_err(|e| format!("failed to prepare migrate select: {e}"))?;

    let mut rows = stmt
        .query([])
        .map_err(|e| format!("failed to query migrate select: {e}"))?;

    let mut updates: Vec<(String, Option<String>, Option<String>)> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("failed to read migrate row: {e}"))? {
        let id: String = row.get(0).map_err(|e| format!("failed to read id: {e}"))?;
        let lib: String = row.get(1).map_err(|e| format!("failed to read library_path: {e}"))?;
        let cover: Option<String> = row.get(2).map_err(|e| format!("failed to read cover_path: {e}"))?;

        let new_lib = normalize_appdata_relative(&lib, &base_str).unwrap_or(lib);
        let new_cover = cover
            .as_deref()
            .and_then(|c| normalize_appdata_relative(c, &base_str))
            .or(cover);

        updates.push((id, Some(new_lib), new_cover));
    }

    for (id, lib, cover) in updates {
        conn.execute(
            "UPDATE books SET library_path = ?2, cover_path = ?3 WHERE id = ?1",
            rusqlite::params![id, lib, cover],
        )
        .map_err(|e| format!("failed to update migrated paths: {e}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
