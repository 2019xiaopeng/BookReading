mod app_paths;
mod commands;
mod db;
mod models;

use commands::library::{delete_book, import_book, list_books};
use commands::reading::{get_settings, set_setting};
use commands::reading::{get_reading_state, upsert_reading_state};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            db::init_db(&app.handle())?;
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_books,
            import_book,
            delete_book,
            get_settings,
            set_setting,
            get_reading_state,
            upsert_reading_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
