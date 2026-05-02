mod app_paths;
mod commands;
mod db;
mod models;

use commands::library::{delete_book, import_book, list_books};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            db::init_db(&app.handle())?;
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![list_books, import_book, delete_book])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
