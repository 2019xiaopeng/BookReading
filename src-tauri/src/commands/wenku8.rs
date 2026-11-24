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
use crate::commands::tags::create_tag_db;
use crate::db;
use crate::models::ImportBookRequest;

const RELAY_URL: &str = "https://wenku8-relay.mewx.org/";
// C-2 直连备胎：源站原生 API，方言与中继不同（niuhuan/wild 实测）
const DIRECT_URL: &str = "http://app.wenku8.com/api.php";
const UA: &str = "Dalvik/2.1.0 (Linux; U; Android 7.1.2; unknown Build/NZH54D)";
// settings 表键
const KEY_COOKIE: &str = "wenku8.cookie";
const KEY_USER: &str = "wenku8.user";
const KEY_PASS: &str = "wenku8.pass";
const KEY_ENDPOINT: &str = "wenku8.endpoint"; // auto | relay | direct（缺省 auto）
const KEY_PROXY_HOST: &str = "proxy.host"; // C-3 代理三键（update.rs 老下载命令共用）
const KEY_PROXY_PORT: &str = "proxy.port";
const KEY_PROXY_ENABLED: &str = "proxy.enabled";

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

/// 云书架条目。imported=本地库命中（books.wenku8_aid 关联）；name 为 None 时由前端调
/// wenku8_book_info 懒取（会话内缓存）；last_cid 为本地记录的最新章节 cid（未入库 0）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Wenku8ShelfBook {
    pub aid: i64,
    pub name: Option<String>,
    pub date: Option<String>,
    pub imported: bool,
    pub book_id: Option<String>,
    pub last_cid: i64,
}

/// 目录章节（action=book&do=list）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Wenku8Chapter {
    pub cid: i64,
    pub title: String,
}

/// 目录卷：卷名 + 章节列表。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Wenku8Volume {
    pub name: String,
    pub chapters: Vec<Wenku8Chapter>,
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
    pub tags: Vec<String>,
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
pub(crate) fn b64_encode(data: &[u8]) -> String {
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

/// 标准 base64 解码（容忍缺省/多余填充；非法字符返回 None）
pub(crate) fn b64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let s = s.trim().trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.as_bytes().chunks(4) {
        if chunk.len() == 1 {
            return None;
        }
        let n = chunk.iter().try_fold(0u32, |acc, &c| val(c).map(|v| (acc << 6) | v))?;
        match chunk.len() {
            4 => out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8]),
            3 => out.extend_from_slice(&[(n >> 10) as u8, (n >> 2) as u8]),
            _ => out.push((n >> 4) as u8),
        }
    }
    Some(out)
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

// ---- HTTP（C-2 双端点 + C-3 可配代理）----

/// 接入地址。两方言见 relay_body/direct_body。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Endpoint {
    Relay,
    Direct,
}

impl Endpoint {
    fn url(self) -> &'static str {
        match self {
            Endpoint::Relay => RELAY_URL,
            Endpoint::Direct => DIRECT_URL,
        }
    }
    fn other(self) -> Self {
        match self {
            Endpoint::Relay => Endpoint::Direct,
            Endpoint::Direct => Endpoint::Relay,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Endpoint::Relay => "relay",
            Endpoint::Direct => "direct",
        }
    }
}

/// auto 模式会话记忆：本进程内记住网络层切换后可用的端点（不落库）
static SESSION_ENDPOINT: Mutex<Option<Endpoint>> = Mutex::new(None);

/// 纯函数：settings 值 → 固定端点（None = auto；未设置/非法值均归 auto）
fn fixed_endpoint(setting: Option<&str>) -> Option<Endpoint> {
    match setting.map(str::trim) {
        Some(s) if s.eq_ignore_ascii_case("relay") => Some(Endpoint::Relay),
        Some(s) if s.eq_ignore_ascii_case("direct") => Some(Endpoint::Direct),
        _ => None,
    }
}

/// 纯函数：auto 首选端点 = 会话记忆，无记忆默认中继
fn auto_first(remembered: Option<Endpoint>) -> Endpoint {
    remembered.unwrap_or(Endpoint::Relay)
}

/// 纯函数：代理三键 → "http://host:port"。enabled 真值（1/true）且 host 非空、port 合法 u16 才启用。
pub(crate) fn parse_proxy(host: Option<&str>, port: Option<&str>, enabled: Option<&str>) -> Option<String> {
    let on = matches!(enabled.map(str::trim), Some(v) if v == "1" || v.eq_ignore_ascii_case("true"));
    if !on {
        return None;
    }
    let host = host?.trim();
    if host.is_empty() {
        return None;
    }
    let port = port?.trim().parse::<u16>().ok()?;
    Some(format!("http://{host}:{port}"))
}

/// 读 settings 得代理地址（update.rs 老下载命令共用）
pub(crate) fn proxy_url(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(parse_proxy(
        setting_get(app, KEY_PROXY_HOST)?.as_deref(),
        setting_get(app, KEY_PROXY_PORT)?.as_deref(),
        setting_get(app, KEY_PROXY_ENABLED)?.as_deref(),
    ))
}

fn build_client(proxy: Option<&str>, timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    let mut b = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        // blocking 构建器无独立 read_timeout，总超时近似读超时
        .timeout(timeout)
        // 系统代理探测在 Tauri 进程内可能挂起（update.rs 先例）；中继直连可达。
        // 显式 .proxy() 不受 no_proxy 影响（update.rs 同款已在生产验证）
        .no_proxy();
    if let Some(p) = proxy {
        b = b.proxy(reqwest::Proxy::all(p).map_err(|e| format!("代理配置无效：{e}"))?);
    }
    b.build().map_err(|e| format!("构建 HTTP 客户端失败：{e}"))
}

/// 主客户端：按当前代理配置缓存（Client 内部是 Arc，克隆廉价）；代理配置变更后下一次请求生效
fn client_for(app: &tauri::AppHandle) -> Result<reqwest::blocking::Client, String> {
    static CACHE: Mutex<Option<(Option<String>, reqwest::blocking::Client)>> = Mutex::new(None);
    let proxy = proxy_url(app)?;
    let mut g = CACHE.lock().unwrap();
    if let Some((p, c)) = g.as_ref() {
        if *p == proxy {
            return Ok(c.clone());
        }
    }
    let c = build_client(proxy.as_deref(), Duration::from_secs(30))?;
    *g = Some((proxy, c.clone()));
    Ok(c)
}

// ---- 请求 body（两方言）----

/// 中继方言：前导 &、HMAC appver、timetoken 毫秒；request 值为原始 base64 不 urlencode（协议实测）
fn relay_body(action: &str, ms: i64) -> String {
    format!("&appver={}&request={}&timetoken={}", current_appver(), b64_encode(action.as_bytes()), ms)
}

/// 直连方言（niuhuan/wild 实测）：无前导 &、固定 appver=1.21、timestamp 秒
fn direct_body(action: &str, ms: i64) -> String {
    format!("request={}&appver=1.21&timestamp={}", b64_encode(action.as_bytes()), ms / 1000)
}

fn endpoint_body(ep: Endpoint, action: &str, ms: i64) -> String {
    match ep {
        Endpoint::Relay => relay_body(action, ms),
        Endpoint::Direct => direct_body(action, ms),
    }
}

/// 用给定客户端向端点发一个 action。Err = 网络层失败（send 错误/HTTP 非 2xx）；
/// 业务 errcode 在成功响应的 body 文本里，由调用方解析。
fn post_action(
    client: &reqwest::blocking::Client,
    ep: Endpoint,
    action: &str,
    cookie: Option<&str>,
) -> Result<reqwest::blocking::Response, String> {
    let body = endpoint_body(ep, action, now_ms());
    let mut req = client
        .post(ep.url())
        .header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
        .header("User-Agent", UA)
        .body(body);
    if let Some(c) = cookie {
        req = req.header("Cookie", c);
    }
    let resp = req.send().map_err(|e| format!("网络请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("wenku8 服务返回 HTTP {}", resp.status()));
    }
    Ok(resp)
}

fn try_endpoint(app: &tauri::AppHandle, ep: Endpoint, action: &str, cookie: Option<&str>) -> Result<reqwest::blocking::Response, String> {
    post_action(&client_for(app)?, ep, action, cookie)
}

/// 发一个 action（自动选端点）。固定模式（relay/direct）不切换；
/// auto 先用会话记忆（默认中继），网络层失败（非 errcode）换另一端点重试一次并记住可用者（仅本会话）。
fn send_action(app: &tauri::AppHandle, action: &str, cookie: Option<&str>) -> Result<reqwest::blocking::Response, String> {
    let fixed = fixed_endpoint(setting_get(app, KEY_ENDPOINT)?.as_deref());
    let first = match fixed {
        Some(ep) => ep,
        None => auto_first(*SESSION_ENDPOINT.lock().unwrap()),
    };
    match try_endpoint(app, first, action, cookie) {
        Ok(r) => Ok(r),
        Err(e1) if fixed.is_none() => {
            let alt = first.other();
            match try_endpoint(app, alt, action, cookie) {
                Ok(r) => {
                    *SESSION_ENDPOINT.lock().unwrap() = Some(alt);
                    Ok(r)
                }
                Err(e2) => Err(format!("{e1}；切换备用地址重试仍失败：{e2}")),
            }
        }
        Err(e) => Err(e),
    }
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
    let resp = send_action(app, &action, None)?;
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
    let body = send_action(app, action, cookie.as_deref())?
        .text()
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if body.trim() != "4" {
        return Ok(body);
    }
    let (user, pass) = match (setting_get(app, KEY_USER)?, setting_get(app, KEY_PASS)?) {
        // 登出后键值为空串：空串视同未保存，不拿空账密去撞登录接口
        (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => (u, p),
        _ => return Err("wenku8 会话已失效，请重新登录".into()),
    };
    let re = do_login(app, &user, &pass)?;
    if !re.ok {
        return Err(format!("wenku8 自动重登失败：{}", re.message));
    }
    let body2 = send_action(app, action, setting_get(app, KEY_COOKIE)?.as_deref())?
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

/// bookinfo 的 Tags 字段按空白切分（split_whitespace 含全角空格 U+3000，trim+空串丢弃天然成立）
fn split_tags(s: &str) -> Vec<String> {
    s.split_whitespace().map(str::to_string).collect()
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
        tags: split_tags(map.get("Tags").map(String::as_str).unwrap_or("")),
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
    // 登出后键值为空串：user/pass 任一为空串即视为未保存
    let user = setting_get(app, KEY_USER)?.filter(|u| !u.is_empty());
    let pass = setting_get(app, KEY_PASS)?.filter(|p| !p.is_empty());
    Ok(Wenku8Status { has_saved: user.is_some() && pass.is_some(), username: user })
}

/// B4 登出：三键置空串（status_inner / wenku8_action 均把空串当未保存/未登录）
#[tauri::command(async)]
pub fn wenku8_logout(app: tauri::AppHandle) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let _ = tx.send(logout_inner(&app));
    });
    rx.recv().map_err(|_| "登出线程异常退出".to_string())?
}

fn logout_inner(app: &tauri::AppHandle) -> Result<(), String> {
    setting_set(app, KEY_COOKIE, "")?;
    setting_set(app, KEY_USER, "")?;
    setting_set(app, KEY_PASS, "")?;
    Ok(())
}

/// C-2 端点状态：当前选择 + auto 会话记忆 + 两地址连通探测（短超时轻量请求，结果不落库）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Wenku8EndpointStatus {
    pub setting: String, // settings 实际值："auto" | "relay" | "direct"（缺省 auto）
    pub session: String, // auto 会话记忆："relay" | "direct" | ""（本会话未发生过切换）
    pub relay_ok: bool,
    pub direct_ok: bool,
}

#[tauri::command(async)]
pub fn wenku8_endpoint_status(app: tauri::AppHandle) -> Result<Wenku8EndpointStatus, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Wenku8EndpointStatus, String>>();
    std::thread::spawn(move || {
        let _ = tx.send(endpoint_status_inner(&app));
    });
    rx.recv().map_err(|_| "端点探测线程异常退出".to_string())?
}

fn endpoint_status_inner(app: &tauri::AppHandle) -> Result<Wenku8EndpointStatus, String> {
    let setting = setting_get(app, KEY_ENDPOINT)?
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "auto".into());
    let session = SESSION_ENDPOINT.lock().unwrap().map(Endpoint::as_str).unwrap_or("").to_string();
    // 探测：短超时客户端发一个轻量 action，拿到 2xx 即连通；不解析 body、不落库
    let cookie = setting_get(app, KEY_COOKIE)?.filter(|c| !c.is_empty());
    let probe_client = build_client(proxy_url(app)?.as_deref(), Duration::from_secs(8));
    let (relay_ok, direct_ok) = match probe_client {
        Ok(c) => (
            post_action(&c, Endpoint::Relay, "action=bookcase&do=list", cookie.as_deref()).is_ok(),
            post_action(&c, Endpoint::Direct, "action=bookcase&do=list", cookie.as_deref()).is_ok(),
        ),
        Err(_) => (false, false),
    };
    Ok(Wenku8EndpointStatus { setting, session, relay_ok, direct_ok })
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
    let aids = parse_bookcase(&wenku8_action(app, "action=bookcase&do=list")?);
    if aids.is_empty() {
        return Ok(Vec::new());
    }
    // 已入库书一次 IN 查询合并（替代前端逐本懒取的 N+1）
    let conn = db::open_db(app)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT wenku8_aid, id, title, wenku8_last_cid FROM books
             WHERE wenku8_aid IN {} AND deleted_at IS NULL",
            crate::commands::shelves::in_clause(aids.len())
        ))
        .map_err(|e| format!("查询本地书库失败：{e}"))?;
    let hits: Vec<(i64, String, Option<String>, Option<i64>)> = stmt
        .query_map(rusqlite::params_from_iter(aids.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| format!("查询本地书库失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("查询本地书库失败：{e}"))?;
    Ok(merge_shelf(&aids, &hits))
}

/// 纯映射：书架 aid 列表 × 本地命中行 (wenku8_aid, id, title, wenku8_last_cid) → 条目。
/// 命中取本地书名与进度（title 为 NULL 仍留懒取）；同 aid 多本（重复导入）取首行。
fn merge_shelf(aids: &[i64], hits: &[(i64, String, Option<String>, Option<i64>)]) -> Vec<Wenku8ShelfBook> {
    let mut by_aid: HashMap<i64, &(i64, String, Option<String>, Option<i64>)> = HashMap::new();
    for h in hits {
        by_aid.entry(h.0).or_insert(h);
    }
    aids.iter()
        .map(|&aid| match by_aid.get(&aid) {
            Some((_, id, title, last_cid)) => Wenku8ShelfBook {
                aid,
                name: title.clone(),
                date: None,
                imported: true,
                book_id: Some(id.clone()),
                last_cid: last_cid.unwrap_or(0),
            },
            None => Wenku8ShelfBook { aid, name: None, date: None, imported: false, book_id: None, last_cid: 0 },
        })
        .collect()
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
pub fn wenku8_download(
    app: tauri::AppHandle,
    aid: i64,
    shelf_id: Option<i64>,
) -> Result<Wenku8DownloadResult, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Wenku8DownloadResult, String>>();
    std::thread::spawn(move || {
        let _ = tx.send(download_inner(&app, aid, shelf_id));
    });
    rx.recv().map_err(|_| "下载线程异常退出".to_string())?
}

/// 给书打一个源站标签：同名不存在则按 create_tag 默认色（color=NULL）新建，再挂 book_tags（主键幂等）。
/// 用于导入流程，失败由调用方记录后继续，不阻断。
fn attach_tag(conn: &rusqlite::Connection, book_id: &str, name: &str) -> Result<(), String> {
    let id: Option<i64> = conn
        .query_row("SELECT id FROM tags WHERE name = ?1", params![name], |r| r.get(0))
        .ok();
    let id = match id {
        Some(id) => id,
        None => create_tag_db(conn, name, None)?.id,
    };
    conn.execute(
        "INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?1, ?2)",
        params![book_id, id],
    )
    .map_err(|e| format!("failed to link tag: {e}"))?;
    Ok(())
}

fn download_inner(app: &tauri::AppHandle, aid: i64, shelf_id: Option<i64>) -> Result<Wenku8DownloadResult, String> {
    // 1) bookinfo 取标题/作者（LatestSection cid 顺手留下，导入后回写 wenku8_last_cid，不二次请求）
    let xml = wenku8_action(app, &format!("action=book&do=bookinfo&aid={aid}&t=0"))?;
    let (fields, latest_cid) = bookinfo_fields(&xml)?;
    let title = fields
        .get("Title")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| format!("wenku8 {aid}"));
    let author = fields.get("Author").cloned().unwrap_or_default();
    let tags = split_tags(fields.get("Tags").map(String::as_str).unwrap_or(""));
    // 简介是独立 action（与 book_info_inner 同款取法）；取失败不拖垮下载
    let intro = wenku8_action(app, &format!("action=book&do=intro&aid={aid}&t=0"))
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty() && t != "4");

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
    let cover = client_for(app)?
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

    // 7) 回写源站关联列（书架刷新靠 wenku8_aid 命中）；指定书架时挂上去（新导入书 sort_order 本就 NULL）
    let conn = db::open_db(app)?;
    conn.execute(
        "UPDATE books SET wenku8_aid = ?2, wenku8_last_cid = ?3 WHERE id = ?1",
        params![imported.id, aid, latest_cid],
    )
    .map_err(|e| format!("回写 wenku8 关联失败：{e}"))?;
    if let Some(sid) = shelf_id {
        // 书架可能已被删：挂不上去不推翻导入结果，书留在根视图（用户可手动挪）
        if let Err(e) = conn.execute("UPDATE books SET shelf_id = ?2 WHERE id = ?1", params![imported.id, sid]) {
            eprintln!("[wenku8] 挂载书架 {sid} 失败（书已入根视图）：{e}");
        }
    }

    // 8) 源站详情尽力入库：简介→description、Tags→本地标签系统；单项失败仅记录不推翻导入
    if let Some(intro) = intro {
        if let Err(e) = conn.execute("UPDATE books SET description = ?2 WHERE id = ?1", params![imported.id, intro]) {
            eprintln!("[wenku8] 写入简介失败：{e}");
        }
    }
    for tag in &tags {
        if let Err(e) = attach_tag(&conn, &imported.id, tag) {
            eprintln!("[wenku8] 打标签“{tag}”失败：{e}");
        }
    }

    Ok(Wenku8DownloadResult { book_id: imported.id, title, chapters: total as i32 })
}

#[tauri::command(async)]
pub fn wenku8_catalog(app: tauri::AppHandle, aid: i64) -> Result<Vec<Wenku8Volume>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<Wenku8Volume>, String>>();
    std::thread::spawn(move || {
        let _ = tx.send(catalog_inner(&app, aid));
    });
    rx.recv().map_err(|_| "目录拉取线程异常退出".to_string())?
}

fn catalog_inner(app: &tauri::AppHandle, aid: i64) -> Result<Vec<Wenku8Volume>, String> {
    let xml = wenku8_action(app, &format!("action=book&do=list&aid={aid}&t=0"))?;
    Ok(catalog_to_volumes(parse_catalog(&xml)?))
}

fn catalog_to_volumes(cat: Catalog) -> Vec<Wenku8Volume> {
    cat.into_iter()
        .map(|(volume, chapters)| Wenku8Volume {
            name: volume,
            chapters: chapters.into_iter().map(|(cid, title)| Wenku8Chapter { cid, title }).collect(),
        })
        .collect()
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
    fn relay_body_leading_amp_timestoken_ms() {
        let b = relay_body("action=book&do=list", 1_725_000_000_123);
        // 前导 &（中继方言）
        assert!(b.starts_with('&'));
        assert!(!b.starts_with("request="));
        // timetoken 毫秒原样透传；request 原始 base64；HMAC appver
        assert!(b.contains("&timetoken=1725000000123"));
        assert!(b.contains(&format!("&request={}", b64_encode(b"action=book&do=list"))));
        assert!(b.starts_with("&appver=1.29-digital-bento-"));
        assert_eq!(b.matches('&').count(), 3);
    }

    #[test]
    fn direct_body_no_amp_timestamp_seconds() {
        let b = direct_body("action=book&do=list", 1_725_000_000_123);
        // 直连方言：无前导 &、固定 appver=1.21、timestamp 秒（字段名不同于中继的 timetoken）
        assert_eq!(
            b,
            format!("request={}&appver=1.21&timestamp=1725000000", b64_encode(b"action=book&do=list"))
        );
    }

    #[test]
    fn endpoint_selection_pure_fns() {
        // settings 值 → 固定端点；未设置/auto/非法值归 auto
        assert_eq!(fixed_endpoint(None), None);
        assert_eq!(fixed_endpoint(Some("auto")), None);
        assert_eq!(fixed_endpoint(Some("bogus")), None);
        assert_eq!(fixed_endpoint(Some(" relay ")), Some(Endpoint::Relay));
        assert_eq!(fixed_endpoint(Some("DIRECT")), Some(Endpoint::Direct));
        // auto 首选 = 会话记忆，无记忆默认中继；切换取另一端
        assert_eq!(auto_first(None), Endpoint::Relay);
        assert_eq!(auto_first(Some(Endpoint::Direct)), Endpoint::Direct);
        assert_eq!(Endpoint::Relay.other(), Endpoint::Direct);
        assert_eq!(Endpoint::Direct.other(), Endpoint::Relay);
        assert_eq!(Endpoint::Relay.as_str(), "relay");
        assert_eq!(Endpoint::Relay.url(), RELAY_URL);
        assert_eq!(Endpoint::Direct.url(), DIRECT_URL);
    }

    #[test]
    fn proxy_settings_parsing() {
        let url = "http://127.0.0.1:7897".to_string();
        assert_eq!(parse_proxy(Some("127.0.0.1"), Some("7897"), Some("1")), Some(url.clone()));
        assert_eq!(parse_proxy(Some("127.0.0.1"), Some("7897"), Some("true")), Some(url.clone()));
        assert_eq!(parse_proxy(Some(" 127.0.0.1 "), Some(" 7897 "), Some("1")), Some(url));
        // 关闭 / 未设置 / 缺 host / 空 host / 非法端口 / 超范围端口 → 不走代理
        assert_eq!(parse_proxy(Some("h"), Some("1"), Some("0")), None);
        assert_eq!(parse_proxy(Some("h"), Some("1"), None), None);
        assert_eq!(parse_proxy(None, Some("1"), Some("1")), None);
        assert_eq!(parse_proxy(Some(""), Some("1"), Some("1")), None);
        assert_eq!(parse_proxy(Some("h"), Some("abc"), Some("1")), None);
        assert_eq!(parse_proxy(Some("h"), Some("99999"), Some("1")), None);
    }

    #[test]
    fn base64_and_percent_encoding() {
        assert_eq!(b64_encode(b"abc"), "YWJj");
        assert_eq!(b64_encode(b"ab"), "YWI=");
        assert_eq!(b64_encode(b"a"), "YQ==");
        assert_eq!(pct_encode("user一"), "user%E4%B8%80");
        // decode 往返（B1 请求封面用）
        assert_eq!(b64_decode("YWJj").unwrap(), b"abc");
        assert_eq!(b64_decode("YWI=").unwrap(), b"ab");
        assert_eq!(b64_decode("YQ====").unwrap(), b"a"); // 多余填充容忍
        let data = vec![0u8, 1, 2, 254, 255, 7];
        assert_eq!(b64_decode(&b64_encode(&data)).unwrap(), data);
        assert!(b64_decode("!!!").is_none());
        assert!(b64_decode("A").is_none());
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
    fn bookinfo_tags_split_and_serde() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<root>
  <data name="Title" value="T"/>
  <data name="Tags" value=" 校园　恋爱  轻小说 "/>
</root>"#;
        let info = parse_bookinfo(1, xml).unwrap();
        // 半角空格 + 全角空格 U+3000 均切分，trim 与空串丢弃天然成立
        assert_eq!(info.tags, vec!["校园", "恋爱", "轻小说"]);
        assert_eq!(split_tags(""), Vec::<String>::new());
        assert_eq!(split_tags(" 　"), Vec::<String>::new());
        // 契约字段名 tags: string[]
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["tags"], serde_json::json!(["校园", "恋爱", "轻小说"]));
    }

    #[test]
    fn attach_tag_creates_reuses_and_is_idempotent() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, library_path, added_at) VALUES ('b1', 't', 'library/books/b1.txt', 1)",
            [],
        )
        .unwrap();

        attach_tag(&conn, "b1", "轻小说").unwrap();
        attach_tag(&conn, "b1", "轻小说").unwrap(); // 重放幂等（book_tags 主键兜底）

        // 预置同名标签：复用不新建、颜色不动
        let pre = create_tag_db(&conn, "科幻", Some("#1971c2")).unwrap();
        attach_tag(&conn, "b1", "科幻").unwrap();

        let tags = crate::commands::tags::list_tags_db(&conn).unwrap();
        assert_eq!(tags.len(), 2); // 重放未翻倍
        assert_eq!(tags.iter().find(|t| t.name == "科幻").unwrap().color.as_deref(), Some("#1971c2"));
        let ids: Vec<i64> = conn
            .prepare("SELECT tag_id FROM book_tags WHERE book_id = 'b1' ORDER BY tag_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&pre.id));

        // 目标书不存在：外键挡下，报错不 panic（调用方 eprintln 后继续）
        assert!(attach_tag(&conn, "nope", "新标签").is_err());
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

    #[test]
    fn shelf_merge_hit_miss_duplicate() {
        let hits = vec![
            (7, "b1".into(), Some("本地名".into()), Some(55)),
            (7, "b2".into(), Some("重复导入".into()), None), // 同 aid 多本：取首行 b1
            (9, "b9".into(), None, None), // 命中但本地书名 NULL：name 仍 None 走前端懒取
        ];
        let out = merge_shelf(&[7, 7, 8, 9], &hits); // 书架列表本身也可能重复 aid：各自独立映射
        assert_eq!(out.len(), 4);
        for (i, book_id, name, last_cid) in [
            (0, Some("b1"), Some("本地名"), 55),
            (1, Some("b1"), Some("本地名"), 55),
            (2, None, None, 0),
            (3, Some("b9"), None, 0),
        ] {
            assert_eq!(out[i].book_id.as_deref(), book_id, "index {i}");
            assert_eq!(out[i].name.as_deref(), name, "index {i}");
            assert_eq!(out[i].last_cid, last_cid, "index {i}");
        }
        assert!(out[0].imported && out[1].imported && out[3].imported);
        assert!(!out[2].imported);
        assert!(out.iter().all(|b| b.date.is_none()));
    }

    #[test]
    fn catalog_volume_serde_field_names() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<root><volume vid="1">第一卷 起始<chapter cid="101">第一章 出发</chapter></volume></root>"#;
        let v = serde_json::to_value(catalog_to_volumes(parse_catalog(xml).unwrap())).unwrap();
        assert_eq!(v[0]["name"], "第一卷 起始");
        assert_eq!(v[0]["chapters"][0]["cid"], 101);
        assert_eq!(v[0]["chapters"][0]["title"], "第一章 出发");
    }
}
