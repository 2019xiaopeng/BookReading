// v3.0 wenku8 云书架（路线 B：App 中继）。协议与签名算法见 docs/开发计划-v3.0.md 第二节。
// 契约（命令签名/结构体字段）已冻结，本文件为其完整实现。
// 全部 HTTP 走专用 std::thread（reqwest blocking 在 Tauri async 线程内 build 会死锁，先例见 update.rs）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use hmac::{Hmac, Mac};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::Emitter;
use time::OffsetDateTime;

use crate::app_paths;
use crate::commands::library::import_book;
use crate::db;
use crate::models::ImportBookRequest;

const RELAY_URL: &str = "https://wenku8-relay.mewx.org/";
const UA: &str = "Dalvik/2.1.0 (Linux; U; Android 7.1.2; unknown Build/NZH54D)";
// settings 表键
const KEY_COOKIE: &str = "wenku8.cookie";
const KEY_USER: &str = "wenku8.user";
const KEY_PASS: &str = "wenku8.pass";

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

/// 下载进度事件（前端 listen "wr:wenku8-progress"）。契约外辅助类型，字段与 TS 侧一致。
#[derive(Serialize, Clone)]
pub struct Wenku8ProgressEvent {
    pub aid: i64,
    pub done: i32,
    pub total: i32,
}

// ---- 基础编解码（无 base64/percent-encoding 依赖，按需 20 行）----

/// 标准 base64（带填充）
fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [*chunk.first().unwrap(), *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// UTF-8 percent-encode（登录 action 里的用户名/密码用）
fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Windows 文件名清洗：非法字符→下划线，去尾部点/空格，限长
fn sanitize_filename(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    let out: String = trimmed.chars().take(60).collect();
    if out.is_empty() { "book".into() } else { out }
}

// ---- appver 签名（60 秒窗口，按分钟缓存）----

fn appver_for(minute: i64) -> String {
    let payload = format!("1.29|digital-bento|{minute}");
    let mut mac = Hmac::<Sha256>::new_from_slice(b"digital-bento").expect("hmac key len");
    mac.update(payload.as_bytes());
    let digest = mac.finalize().into_bytes();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("1.29-digital-bento-{}", &hex[12..20])
}

static APPVER: Mutex<Option<(i64, String)>> = Mutex::new(None);

fn now_ms() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

fn current_appver() -> String {
    let minute = now_ms() / 60_000;
    let mut g = APPVER.lock().unwrap();
    if let Some((m, v)) = g.as_ref() {
        if *m == minute {
            return v.clone();
        }
    }
    let v = appver_for(minute);
    *g = Some((minute, v.clone()));
    v
}

// ---- HTTP ----

fn client() -> &'static reqwest::blocking::Client {
    static C: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            // blocking 构建器无独立 read_timeout，30s 总超时近似读超时
            .timeout(Duration::from_secs(30))
            // 系统代理探测在 Tauri 进程内可能挂起（update.rs 先例）；中继直连可达
            .no_proxy()
            .build()
            .expect("wenku8 relay client build")
    })
}

/// 发一个 action（明文 → base64 → 中继根路径 POST）。cookie 可选。
fn send_action(action: &str, cookie: Option<&str>) -> Result<reqwest::blocking::Response, String> {
    let body = format!(
        "&appver={}&request={}&timetoken={}",
        current_appver(),
        b64_encode(action.as_bytes()),
        now_ms()
    );
    let mut req = client()
        .post(RELAY_URL)
        .header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
        .header("User-Agent", UA)
        .body(body); // request 值为原始 base64，不做 urlencode（协议实测要求）
    if let Some(c) = cookie {
        req = req.header("Cookie", c);
    }
    let resp = req.send().map_err(|e| format!("网络请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("wenku8 服务返回 HTTP {}", resp.status()));
    }
    Ok(resp)
}

/// settings 表读写（与 reading.rs 同款 SQL）
fn setting_get(app: &tauri::AppHandle, key: &str) -> Result<Option<String>, String> {
    let conn = db::open_db(app)?;
    match conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    }) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("读取设置失败：{e}")),
    }
}

fn setting_set(app: &tauri::AppHandle, key: &str, value: &str) -> Result<(), String> {
    let conn = db::open_db(app)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| format!("写入设置失败：{e}"))?;
    Ok(())
}

/// 登录核心：发 login action，成功则收下全部 Set-Cookie 存表，同时记住账密供自动重登。
fn do_login(app: &tauri::AppHandle, username: &str, password: &str) -> Result<Wenku8LoginResult, String> {
    let action = format!("action=login&username={}&password={}", pct_encode(username), pct_encode(password));
    let resp = send_action(&action, None)?;
    // text() 会消费 Response，先取 Set-Cookie
    let cookies: Vec<String> = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| v.split(';').next().map(str::trim))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let body = resp.text().map_err(|e| format!("读取响应失败：{e}"))?;
    let code = body.trim();
    match code {
        "1" => {
            if cookies.is_empty() {
                return Ok(Wenku8LoginResult { ok: false, errcode: 1, message: "登录成功但未收到会话，请重试".into() });
            }
            setting_set(app, KEY_COOKIE, &cookies.join("; "))?;
            setting_set(app, KEY_USER, username)?;
            setting_set(app, KEY_PASS, password)?;
            Ok(Wenku8LoginResult { ok: true, errcode: 1, message: "登录成功".into() })
        }
        "2" => Ok(Wenku8LoginResult { ok: false, errcode: 2, message: "用户名错误".into() }),
        "3" => Ok(Wenku8LoginResult { ok: false, errcode: 3, message: "密码错误".into() }),
        "0" => Ok(Wenku8LoginResult { ok: false, errcode: 0, message: "请求发生错误，请稍后重试".into() }),
        other => Ok(Wenku8LoginResult {
            ok: false,
            errcode: other.parse().unwrap_or(-1),
            message: format!("登录失败（返回 {other}）"),
        }),
    }
}

/// 带 cookie 发请求；返回 "4"（未登录）时用存着的账密自动重登一次并原样重试。
fn wenku8_action(app: &tauri::AppHandle, action: &str) -> Result<String, String> {
    let cookie = setting_get(app, KEY_COOKIE)?;
    let body = send_action(action, cookie.as_deref())?
        .text()
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if body.trim() != "4" {
        return Ok(body);
    }
    let (user, pass) = match (setting_get(app, KEY_USER)?, setting_get(app, KEY_PASS)?) {
        (Some(u), Some(p)) => (u, p),
        _ => return Err("wenku8 会话已失效，请重新登录".into()),
    };
    let re = do_login(app, &user, &pass)?;
    if !re.ok {
        return Err(format!("wenku8 自动重登失败：{}", re.message));
    }
    let body2 = send_action(action, setting_get(app, KEY_COOKIE)?.as_deref())?
        .text()
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if body2.trim() == "4" {
        return Err("wenku8 会话已失效，请重新登录".into());
    }
    Ok(body2)
}

// ---- 解析 ----

/// 书架：每行一个 <book aid="N" />，非数字跳过
fn parse_bookcase(body: &str) -> Vec<i64> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r#"aid="(\d+)""#).unwrap());
    re.captures_iter(body)
        .filter_map(|c| c[1].parse::<i64>().ok())
        .collect()
}

/// bookinfo 字段：value 属性优先，空则取首个非空直接文本子节点；另有 LatestSection 的 cid。
fn bookinfo_fields(xml: &str) -> Result<(HashMap<String, String>, i64), String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("解析书籍信息失败：{e}"))?;
    let mut map = HashMap::new();
    let mut latest_cid = 0i64;
    for n in doc.descendants().filter(|n| n.is_element()) {
        match n.tag_name().name() {
            "data" => {
                if let Some(k) = n.attribute("name") {
                    let mut v = n.attribute("value").unwrap_or("").trim().to_string();
                    if v.is_empty() {
                        v = n
                            .children()
                            .filter(|c| c.is_text())
                            .filter_map(|c| c.text())
                            .map(str::trim)
                            .find(|t| !t.is_empty())
                            .unwrap_or("")
                            .to_string();
                    }
                    map.entry(k.to_string()).or_insert(v);
                }
            }
            "LatestSection" => {
                if let Some(cid) = n.attribute("cid").and_then(|c| c.parse::<i64>().ok()) {
                    latest_cid = cid;
                }
            }
            _ => {}
        }
    }
    Ok((map, latest_cid))
}

fn parse_bookinfo(aid: i64, xml: &str) -> Result<Wenku8BookInfo, String> {
    let (map, latest_cid) = bookinfo_fields(xml)?;
    Ok(Wenku8BookInfo {
        aid,
        title: map.get("Title").cloned().unwrap_or_default(),
        author: map.get("Author").cloned().unwrap_or_default(),
        status: map.get("BookStatus").cloned().unwrap_or_default(),
        last_update: map.get("LastUpdate").cloned().unwrap_or_default(),
        latest_cid,
        intro: None,
    })
}

/// 元素全部直接文本子节点拼接后 trim（卷名/章名取法：不含子元素文本）
fn direct_text(n: roxmltree::Node) -> String {
    n.children()
        .filter(|c| c.is_text())
        .filter_map(|c| c.text())
        .collect::<String>()
        .trim()
        .to_string()
}

type Catalog = Vec<(String, Vec<(i64, String)>)>; // (卷名, [(cid, 章名)])

fn parse_catalog(xml: &str) -> Result<Catalog, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("解析目录失败：{e}"))?;
    let mut out: Catalog = Vec::new();
    for vol in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == "volume") {
        let chapters: Vec<(i64, String)> = vol
            .children()
            .filter(|c| c.is_element() && c.tag_name().name() == "chapter")
            .filter_map(|c| {
                let cid = c.attribute("cid")?.parse::<i64>().ok()?;
                Some((cid, direct_text(c)))
            })
            .collect();
        out.push((direct_text(vol), chapters));
    }
    Ok(out)
}

/// 每章正文开头常重复卷名/章名：逐层剥掉
fn strip_chapter_head(text: &str, vol: &str, chap: &str) -> String {
    let mut t = text.trim_start();
    if !vol.is_empty() {
        if let Some(r) = t.strip_prefix(vol) {
            t = r.trim_start();
        }
    }
    if !chap.is_empty() {
        if let Some(r) = t.strip_prefix(chap) {
            t = r.trim_start();
        }
    }
    t.trim().to_string()
}

// ---- 命令（壳：专用线程跑阻塞逻辑，照 update.rs 先例）----

#[tauri::command(async)]
pub fn wenku8_login(app: tauri::AppHandle, username: String, password: String) -> Result<Wenku8LoginResult, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Wenku8LoginResult, String>>();
    std::thread::spawn(move || {
        let _ = tx.send(do_login(&app, &username, &password));
    });
    rx.recv().map_err(|_| "登录线程异常退出".to_string())?
}

#[tauri::command(async)]
pub fn wenku8_status(app: tauri::AppHandle) -> Result<Wenku8Status, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Wenku8Status, String>>();
    std::thread::spawn(move || {
        let _ = tx.send(status_inner(&app));
    });
    rx.recv().map_err(|_| "状态查询线程异常退出".to_string())?
}

fn status_inner(app: &tauri::AppHandle) -> Result<Wenku8Status, String> {
    let user = setting_get(app, KEY_USER)?;
    let pass = setting_get(app, KEY_PASS)?;
    Ok(Wenku8Status { has_saved: user.is_some() && pass.is_some(), username: user })
}

#[tauri::command(async)]
pub fn wenku8_bookshelf(app: tauri::AppHandle) -> Result<Vec<Wenku8ShelfBook>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<Wenku8ShelfBook>, String>>();
    std::thread::spawn(move || {
        let _ = tx.send(bookshelf_inner(&app));
    });
    rx.recv().map_err(|_| "书架拉取线程异常退出".to_string())?
}

fn bookshelf_inner(app: &tauri::AppHandle) -> Result<Vec<Wenku8ShelfBook>, String> {
    let body = wenku8_action(app, "action=bookcase&do=list")?;
    Ok(parse_bookcase(&body)
        .into_iter()
        .map(|aid| Wenku8ShelfBook { aid, name: None, date: None })
        .collect())
}

#[tauri::command(async)]
pub fn wenku8_book_info(app: tauri::AppHandle, aid: i64) -> Result<Wenku8BookInfo, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Wenku8BookInfo, String>>();
    std::thread::spawn(move || {
        let _ = tx.send(book_info_inner(&app, aid));
    });
    rx.recv().map_err(|_| "书籍信息线程异常退出".to_string())?
}

fn book_info_inner(app: &tauri::AppHandle, aid: i64) -> Result<Wenku8BookInfo, String> {
    let xml = wenku8_action(app, &format!("action=book&do=bookinfo&aid={aid}&t=0"))?;
    let mut info = parse_bookinfo(aid, &xml)?;
    // 简介是独立 action（纯文本）；失败不拖垮整个 bookinfo
    if let Ok(intro) = wenku8_action(app, &format!("action=book&do=intro&aid={aid}&t=0")) {
        let t = intro.trim();
        if !t.is_empty() && t != "4" {
            info.intro = Some(t.to_string());
        }
    }
    Ok(info)
}

#[tauri::command(async)]
pub fn wenku8_download(app: tauri::AppHandle, aid: i64) -> Result<Wenku8DownloadResult, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Wenku8DownloadResult, String>>();
    std::thread::spawn(move || {
        let _ = tx.send(download_inner(&app, aid));
    });
    rx.recv().map_err(|_| "下载线程异常退出".to_string())?
}

fn download_inner(app: &tauri::AppHandle, aid: i64) -> Result<Wenku8DownloadResult, String> {
    // 1) bookinfo 取标题/作者
    let xml = wenku8_action(app, &format!("action=book&do=bookinfo&aid={aid}&t=0"))?;
    let (fields, _) = bookinfo_fields(&xml)?;
    let title = fields
        .get("Title")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| format!("wenku8 {aid}"));
    let author = fields.get("Author").cloned().unwrap_or_default();

    // 2) 目录拍平成 (卷名, cid, 章名) 序列
    let cat_xml = wenku8_action(app, &format!("action=book&do=list&aid={aid}&t=0"))?;
    let catalog = parse_catalog(&cat_xml)?;
    let flat: Vec<(&str, i64, &str)> = catalog
        .iter()
        .flat_map(|(vol, chs)| chs.iter().map(move |(cid, chap)| (vol.as_str(), *cid, chap.as_str())))
        .collect();
    let total = flat.len();
    if total == 0 {
        return Err("目录为空，无法下载".into());
    }

    // 3) 并发 4 拉全部正文，每完成一章报进度
    let done = AtomicUsize::new(0);
    let collected = Mutex::new(Vec::<(usize, Result<String, String>)>::new());
    let chunk_size = (total + 3) / 4;
    let indices: Vec<usize> = (0..total).collect();
    std::thread::scope(|s| {
        for chunk in indices.chunks(chunk_size) {
            let app2 = app.clone();
            let out = &collected;
            let done = &done;
            let flat = &flat;
            s.spawn(move || {
                for &i in chunk {
                    let (vol, cid, chap) = flat[i];
                    let r = wenku8_action(&app2, &format!("action=book&do=text&aid={aid}&cid={cid}&t=0"))
                        .map(|t| strip_chapter_head(&t, vol, chap));
                    let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                    let _ = app2.emit(
                        "wr:wenku8-progress",
                        Wenku8ProgressEvent { aid, done: d as i32, total: total as i32 },
                    );
                    out.lock().unwrap().push((i, r));
                }
            });
        }
    });
    let mut results = collected.into_inner().unwrap();
    results.sort_by_key(|(i, _)| *i);
    for (i, r) in &results {
        if let Err(e) = r {
            return Err(format!("第 {} 章下载失败：{e}", i + 1));
        }
    }

    // 4) 拼全书 TXT："{卷名} {章名}\n\n{正文}\n\n" 逐章拼接
    let mut book = String::new();
    for ((vol, _, chap), text) in flat.iter().zip(results) {
        book.push_str(&format!("{vol} {chap}\n\n{}\n\n", text.1.unwrap()));
    }

    // 5) 写临时文件（app_data_dir 下），封面尽力而为
    let dir = app_paths::app_data_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let tmp = dir.join(format!("wenku8-{aid}-{}.txt", sanitize_filename(&title)));
    std::fs::write(&tmp, book.as_bytes()).map_err(|e| format!("写临时文件失败：{e}"))?;

    let cover_url = format!("http://img.wenku8.com/image/{}/{aid}/{aid}s.jpg", aid / 1000);
    let cover = client()
        .get(&cover_url)
        .send()
        .ok()
        .filter(|r| r.status().is_success())
        .and_then(|r| r.bytes().ok())
        .filter(|b| !b.is_empty());

    // 6) 走现有导入管线入库，随后删临时文件（失败也删）
    let req = ImportBookRequest {
        source_path: tmp.to_string_lossy().into_owned(),
        title: Some(title.clone()),
        author: if author.is_empty() { None } else { Some(author) },
        cover_bytes_base64: cover.as_ref().map(|b| b64_encode(b)),
        cover_ext: cover.as_ref().map(|_| "jpg".to_string()),
        mode: None,
    };
    let imported = match import_book(app.clone(), req) {
        Ok(b) => b,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("导入书库失败：{e}"));
        }
    };
    let _ = std::fs::remove_file(&tmp);

    Ok(Wenku8DownloadResult { book_id: imported.id, title, chapters: total as i32 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appver_matches_openssl_vectors() {
        assert_eq!(appver_for(30477000), "1.29-digital-bento-eeefb41a");
        assert_eq!(appver_for(0), "1.29-digital-bento-dd6b7b47");
    }

    #[test]
    fn base64_and_percent_encoding() {
        assert_eq!(b64_encode(b"abc"), "YWJj");
        assert_eq!(b64_encode(b"ab"), "YWI=");
        assert_eq!(b64_encode(b"a"), "YQ==");
        assert_eq!(pct_encode("user一"), "user%E4%B8%80");
    }

    #[test]
    fn bookcase_parse_skips_non_numeric() {
        let fixture = "<book aid=\"3988\" />\n<book aid=\"1\" />\n<book aid=\"x\" />";
        assert_eq!(parse_bookcase(fixture), vec![3988, 1]);
    }

    #[test]
    fn bookinfo_attr_and_text_forms() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<root>
  <data name="Title" value="书名X"/>
  <data name="Author">作者Y</data>
  <data name="BookStatus" value="连载中"/>
  <data name="LastUpdate" value="2023-1-1"/>
  <LatestSection cid="123456"><![CDATA[最新章节]]></LatestSection>
</root>"#;
        let info = parse_bookinfo(7, xml).unwrap();
        assert_eq!(info.title, "书名X"); // value 属性形态
        assert_eq!(info.author, "作者Y"); // 文本子节点形态
        assert_eq!(info.status, "连载中");
        assert_eq!(info.last_update, "2023-1-1");
        assert_eq!(info.latest_cid, 123456);
    }

    #[test]
    fn catalog_two_volumes_two_chapters_each() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<root>
  <volume vid="1">第一卷 起始
    <chapter cid="101">第一章 出发</chapter>
    <chapter cid="102">第二章 途中</chapter>
  </volume>
  <volume vid="2">第二卷 后续
    <chapter cid="201">第三章 转折</chapter>
    <chapter cid="202">第四章 结局</chapter>
  </volume>
</root>"#;
        let cat = parse_catalog(xml).unwrap();
        assert_eq!(cat.len(), 2);
        assert_eq!(cat[0].0, "第一卷 起始");
        assert_eq!(cat[0].1, vec![(101, "第一章 出发".into()), (102, "第二章 途中".into())]);
        assert_eq!(cat[1].0, "第二卷 后续");
        assert_eq!(cat[1].1[1], (202, "第四章 结局".into()));
    }

    #[test]
    fn chapter_head_strip_and_assemble_format() {
        let body = "第一卷 起始\n\n第一章 出发\n\n\n　　正文内容。";
        let stripped = strip_chapter_head(body, "第一卷 起始", "第一章 出发");
        assert_eq!(stripped, "正文内容。");
        // 只剥一层也能剥另一层
        assert_eq!(strip_chapter_head("第一章 出发 xyz", "", "第一章 出发"), "xyz");
        // 拼装格式
        let catalog: Catalog = vec![("第一卷 起始".into(), vec![(101, "第一章 出发".into())])];
        let flat: Vec<(&str, i64, &str)> = catalog
            .iter()
            .flat_map(|(v, cs)| cs.iter().map(move |(c, n)| (v.as_str(), *c, n.as_str())))
            .collect();
        let results: Vec<(usize, Result<String, String>)> = vec![(0, Ok(stripped))];
        let mut book = String::new();
        for ((vol, _, chap), text) in flat.iter().zip(results) {
            book.push_str(&format!("{vol} {chap}\n\n{}\n\n", text.1.unwrap()));
        }
        assert_eq!(book, "第一卷 起始 第一章 出发\n\n正文内容。\n\n");
    }

    #[test]
    fn filename_sanitize() {
        assert_eq!(sanitize_filename("小说:第一卷?"), "小说_第一卷_"); // ASCII 非法字符替换；全角：合法保留
        assert_eq!(sanitize_filename("  ."), "book");
    }
}
