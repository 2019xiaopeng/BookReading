mod app_paths;
mod commands;
mod db;
mod models;
mod epub;
mod txt;

use std::fs;
use std::io::Write;

use commands::library::{
    delete_book, delete_reader_font, import_book, list_books, reextract_all_covers,
    repair_book_metadata, save_reader_background, save_reader_font, set_book_cover,
    update_book_metadata,
};
use commands::images::{
    import_image_folder, list_image_pages, list_image_subdirs, read_image_page, relink_image_book,
};
use commands::annotations::{
    add_bookmark, add_highlight, delete_bookmark, delete_highlight, list_bookmarks, list_highlights,
};
use commands::reading::{get_settings, set_setting};
use commands::reading::{get_reading_state, upsert_reading_state};
use commands::logging::append_frontend_log;
use commands::storage::{clear_cache, migrate_library_root, probe_paths, read_library_file, remove_old_library, storage_stats};
use commands::favorites::{
    add_favorite_quote, delete_favorite_quote, list_favorite_books, list_favorite_quotes, set_book_favorite,
};
use commands::shelves::{
    create_shelf, delete_books, delete_shelf, list_shelves, list_trash, move_books_to_shelf, move_shelf,
    purge_books, rename_shelf, restore_books, set_books_order, set_shelf_order, set_trash_retention_days,
};
use commands::tags::{
    add_tags_to_books, compute_book_stats, create_tag, delete_tag, list_tags, merge_tags, recolor_tag,
    rename_tag, set_book_tags,
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
            import_image_folder,
            list_image_pages,
            list_image_subdirs,
            read_image_page,
            relink_image_book,
            repair_book_metadata,
            set_book_cover,
            reextract_all_covers,
            update_book_metadata,
            delete_book,
            list_shelves,
            create_shelf,
            rename_shelf,
            move_shelf,
            delete_shelf,
            set_shelf_order,
            move_books_to_shelf,
            set_books_order,
            delete_books,
            restore_books,
            purge_books,
            list_trash,
            set_trash_retention_days,
            list_tags,
            create_tag,
            rename_tag,
            recolor_tag,
            merge_tags,
            delete_tag,
            set_book_tags,
            add_tags_to_books,
            compute_book_stats,
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
            save_reader_background,
            save_reader_font,
            delete_reader_font,
            get_reading_state,
            upsert_reading_state,
            append_frontend_log,
            storage_stats,
            migrate_library_root,
            remove_old_library,
            clear_cache,
            probe_paths,
            read_library_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
