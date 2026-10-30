mod app_paths;
mod commands;
mod db;
mod models;
mod epub;
mod txt;

use std::fs;
use std::io::Write;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};

use commands::library::{
    delete_book, delete_reader_font, generate_cover_thumbs, get_book, import_book, list_books,
    reextract_all_covers, repair_book_metadata, save_reader_background, save_reader_font,
    set_book_cover, update_book_metadata,
};
use commands::images::{
    import_image_folder, list_image_page_meta, list_image_pages, list_image_subdirs,
    read_image_page, relink_image_book, AppState as ImageState,
};
use commands::annotations::{
    add_bookmark, add_highlight, delete_bookmark, delete_highlight, export_annotations,
    list_bookmarks, list_highlights,
};
use commands::reading::{get_settings, set_setting, set_settings};
use commands::reading::{
    add_reading_time, get_reading_state, list_reading_times, load_book_locations,
    save_book_locations, upsert_reading_state,
};
use commands::logging::append_frontend_log;
use commands::storage::{clear_cache, migrate_library_root, probe_paths, read_library_file, remove_old_library, storage_stats};
use commands::favorites::{
    add_favorite_quote, delete_favorite_quote, list_favorite_books, list_favorite_quotes, set_book_favorite,
};
use commands::shelves::{
    create_shelf, delete_books, delete_books_from_disk, delete_shelf, list_shelves, list_trash,
    move_books_to_shelf, move_shelf, purge_books, rename_shelf, restore_books, set_books_order,
    set_shelf_order, set_trash_retention_days,
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

/// 批次19：退出应用（绕过 CloseRequested 拦截；AppHandle::exit 走 ExitRequested 不触发窗口关闭事件）
#[tauri::command(async)]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A12 窗口状态记忆（大小/位置/最大化），须在窗口创建（setup 内）前注册
        .plugin(tauri_plugin_window_state::Builder::new().build())
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

            // A2 图片书页缓存与 CBZ 句柄缓存（async 并发下 Mutex 保护）
            app.manage(ImageState::default());
            // A5 存量封面缩略档补生成（幂等；后台线程 + cover-thumbs-progress 事件报进度）
            let _ = generate_cover_thumbs(handle.clone());

            // 批次19：系统托盘——✕ 最小化到托盘后的常驻入口；左键单击恢复主窗口，右键菜单 显示/退出。
            // 常驻：窗口 hide 后任务栏图标消失（Windows 默认），托盘不随窗口隐藏消失。
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("BookReading")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().0.as_str() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            append_startup_log(&handle, "startup: ready");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 批次19：✕ 不直接关窗，交给前端三选（托盘/退出/取消）。
                // shortcut: 系统关机/NSIS 升级不走此路径（tao 不处理 WM_QUERYENDSESSION，安装器 taskkill），
                // prevent_close 只拦常规关闭，若未来支持 Linux 关机协议需加守卫。
                api.prevent_close();
                let _ = window.app_handle().emit("wr:close-requested", ());
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_books,
            get_book,
            import_book,
            import_image_folder,
            list_image_pages,
            list_image_page_meta,
            list_image_subdirs,
            read_image_page,
            relink_image_book,
            repair_book_metadata,
            set_book_cover,
            reextract_all_covers,
            generate_cover_thumbs,
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
            delete_books_from_disk,
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
            export_annotations,
            set_book_favorite,
            list_favorite_books,
            add_favorite_quote,
            delete_favorite_quote,
            list_favorite_quotes,
            get_settings,
            set_setting,
            set_settings,
            save_book_locations,
            load_book_locations,
            add_reading_time,
            list_reading_times,
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
            read_library_file,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
