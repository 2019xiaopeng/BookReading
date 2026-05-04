mod app_paths;
mod commands;
mod db;
mod models;
mod epub;

use std::fs;
use std::io::Write;

use commands::library::{delete_book, import_book, list_books, repair_book_metadata, update_book_metadata};
use commands::annotations::{
    add_bookmark, add_highlight, delete_bookmark, delete_highlight, list_bookmarks, list_highlights,
};
use commands::reading::{get_settings, set_setting};
use commands::reading::{get_reading_state, upsert_reading_state};
use commands::logging::append_frontend_log;
use commands::favorites::{
    add_favorite_quote, delete_favorite_quote, list_favorite_books, list_favorite_quotes, set_book_favorite,
};

fn append_startup_log(app: &tauri::AppHandle, line: &str) {
    let dir = match app_paths::app_data_dir(app) {
        Ok(p) => p.join("logs"),
        Err(_) => std::env::temp_dir().join("bookreading-logs"),
    };
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("startup.log");
    let mut f = match fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(v) => v,
        Err(_) => return,
    };
    let _ = writeln!(f, "{line}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle();
            append_startup_log(&handle, "startup: begin");

            let hook_handle = handle.clone();
            std::panic::set_hook(Box::new(move |info| {
                append_startup_log(&hook_handle, &format!("panic: {info}"));
            }));

            if let Err(e) = db::init_db(&handle) {
                append_startup_log(&handle, &format!("startup: init_db failed: {e}"));
                return Err(e.into());
            }

            append_startup_log(&handle, "startup: ready");
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_books,
            import_book,
            repair_book_metadata,
            update_book_metadata,
            delete_book,
            list_bookmarks,
            add_bookmark,
            delete_bookmark,
            list_highlights,
            add_highlight,
            delete_highlight,
            set_book_favorite,
            list_favorite_books,
            add_favorite_quote,
            delete_favorite_quote,
            list_favorite_quotes,
            get_settings,
            set_setting,
            get_reading_state,
            upsert_reading_state,
            append_frontend_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
