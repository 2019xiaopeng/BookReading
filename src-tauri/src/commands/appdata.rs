use std::fs;
use std::path::Path;

use base64::Engine;

use crate::app_paths;

fn normalize_seps(s: &str) -> String {
    s.replace('\\', "/")
}

fn extract_library_rel(input: &str) -> Result<String, String> {
    let v = normalize_seps(input.trim());
    if v.to_lowercase().starts_with("library/") {
        return Ok(v);
    }
    if let Some(idx) = v.to_lowercase().find("/library/") {
        return Ok(v[idx + 1..].to_string());
    }
    Err(format!("invalid library path: {input}"))
}

fn is_safe_rel_path(rel: &str) -> bool {
    let p = Path::new(rel);
    if !p.is_relative() {
        return false;
    }
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => return false,
            std::path::Component::Prefix(_) => return false,
            std::path::Component::RootDir => return false,
            _ => {}
        }
    }
    true
}

#[tauri::command]
pub fn read_library_file(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    let rel = extract_library_rel(&path)?;
    if !is_safe_rel_path(&rel) {
        return Err(format!("unsafe library path: {path}"));
    }
    let abs = app_paths::app_data_dir(&app)?.join(rel);
    fs::read(abs).map_err(|e| format!("failed to read file: {e}"))
}

#[tauri::command]
pub fn read_library_file_base64(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let rel = extract_library_rel(&path)?;
    if !is_safe_rel_path(&rel) {
        return Err(format!("unsafe library path: {path}"));
    }
    let abs = app_paths::app_data_dir(&app)?.join(rel);
    let bytes = fs::read(abs).map_err(|e| format!("failed to read file: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
