use std::path::PathBuf;

use tauri::Manager;

pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to get app data dir: {e}"))
}

pub fn library_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("library"))
}

pub fn books_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(library_dir(app)?.join("books"))
}

pub fn covers_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(library_dir(app)?.join("covers"))
}

pub fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("db").join("app.sqlite"))
}
