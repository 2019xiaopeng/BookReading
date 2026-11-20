// v3.0 wenku8 云书架（路线 B：App 中继）。协议与签名算法见 docs/开发计划-v3.0.md 第二节。
// 本文件先冻结命令契约（stub），实现由 v3.0 批次3 填充。

use serde::{Deserialize, Serialize};

/// 登录结果。ok=true 时 session cookie 已存入 settings（key: wenku8.cookie）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Wenku8LoginResult {
    pub ok: bool,
    pub errcode: i32,
    pub message: String,
}

/// 账号状态：是否存过账密（不代表会话仍有效；会话失效时命令内部自动重登）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Wenku8Status {
    pub has_saved: bool,
    pub username: Option<String>,
}

/// 云书架条目。name 为 None 时由前端调 wenku8_book_info 懒取（会话内缓存）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Wenku8ShelfBook {
    pub aid: i64,
    pub name: Option<String>,
    pub date: Option<String>,
}

/// 书籍元信息（action=book&do=bookinfo）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Wenku8BookInfo {
    pub aid: i64,
    pub title: String,
    pub author: String,
    pub status: String,
    pub last_update: String,
    pub latest_cid: i64,
    pub intro: Option<String>,
}

/// 拉取结果：已走现有导入管线入库。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Wenku8DownloadResult {
    pub book_id: String,
    pub title: String,
    pub chapters: i32,
}

#[tauri::command(async)]
pub fn wenku8_login(
    _app: tauri::AppHandle,
    _username: String,
    _password: String,
) -> Result<Wenku8LoginResult, String> {
    Err("wenku8: not implemented".into())
}

#[tauri::command(async)]
pub fn wenku8_status(_app: tauri::AppHandle) -> Result<Wenku8Status, String> {
    Err("wenku8: not implemented".into())
}

#[tauri::command(async)]
pub fn wenku8_bookshelf(_app: tauri::AppHandle) -> Result<Vec<Wenku8ShelfBook>, String> {
    Err("wenku8: not implemented".into())
}

#[tauri::command(async)]
pub fn wenku8_book_info(_app: tauri::AppHandle, _aid: i64) -> Result<Wenku8BookInfo, String> {
    Err("wenku8: not implemented".into())
}

#[tauri::command(async)]
pub fn wenku8_download(
    _app: tauri::AppHandle,
    _aid: i64,
) -> Result<Wenku8DownloadResult, String> {
    Err("wenku8: not implemented".into())
}
