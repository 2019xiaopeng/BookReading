// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Write;

fn main() {
    let log_dir = std::env::temp_dir().join("bookreading-logs");
    let _ = fs::create_dir_all(&log_dir);
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("main.log"))
    {
        let _ = writeln!(f, "main: entered");
    }

    bookreading_lib::run()
}
