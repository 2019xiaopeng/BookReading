// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Write;

#[cfg(windows)]
fn diag_popup(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_OK};
    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let text = to_wide(message);
    let title = to_wide("BookReading");
    unsafe {
        MessageBoxW(0, text.as_ptr(), title.as_ptr(), MB_OK);
    }
}

fn main() {
    let log_dir = std::env::temp_dir().join("bookreading-logs");
    let _ = fs::create_dir_all(&log_dir);
    let _log_ok = if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("main.log"))
    {
        let _ = writeln!(f, "main: entered");
        true
    } else {
        false
    };

    #[cfg(windows)]
    {
        if std::env::var("BOOKREADING_DIAG").ok().as_deref() == Some("1") {
            diag_popup(if _log_ok { "diag: main entered" } else { "diag: failed to write main.log" });
        }
    }

    bookreading_lib::run()
}
