mod app_paths;
mod commands;
mod db;
mod models;

use commands::library::{delete_book, import_book, list_books};
use commands::annotations::{
    add_bookmark, add_highlight, delete_bookmark, delete_highlight, list_bookmarks, list_highlights,
};
use commands::reading::{get_settings, set_setting};
use commands::reading::{get_reading_state, upsert_reading_state};
use commands::favorites::{
    add_favorite_quote, delete_favorite_quote, list_favorite_books, list_favorite_quotes, set_book_favorite,
};

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
            upsert_reading_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
