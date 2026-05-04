use std::fs;
use std::io::Write;

use time::OffsetDateTime;

use crate::app_paths;

fn now_line(line: &str) -> String {
    let ts = OffsetDateTime::now_utc().unix_timestamp();
    format!("{ts} {line}")
}

#[tauri::command]
pub fn append_frontend_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    let dir = app_paths::app_data_dir(&app)?.join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create logs dir: {e}"))?;

    let path = dir.join("frontend.log");
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("failed to open frontend log: {e}"))?;

    writeln!(f, "{}", now_line(&line)).map_err(|e| format!("failed to write frontend log: {e}"))?;
    Ok(())
}

