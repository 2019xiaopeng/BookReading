// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
fn diag_popup(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_OK, MB_SYSTEMMODAL, MB_TOPMOST};
    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let text = to_wide(message);
    let title = to_wide("BookReading");
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_TOPMOST | MB_SYSTEMMODAL);
    }
}

fn main() {
    let log_dir = std::env::temp_dir().join("bookreading-logs");
    let _ = fs::create_dir_all(&log_dir);
    let diag_enabled = std::env::var("BOOKREADING_DIAG").ok().as_deref() == Some("1");
    let exe_path = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "<unknown>".to_string());
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let log_path = log_dir.join("main.log");
    let _log_ok = if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let _ = writeln!(f, "main: entered ts={ts} diag={diag_enabled} exe={exe_path}");
        true
    } else {
        false
    };

    #[cfg(windows)]
    {
        if diag_enabled {
            diag_popup(&format!(
                "diag: main entered\nlog_ok={}\nlog_path={}\nexe={}",
                _log_ok,
                log_path.to_string_lossy(),
                exe_path
            ));
            std::thread::sleep(std::time::Duration::from_secs(10));
        }
    }

    bookreading_lib::run()
}
