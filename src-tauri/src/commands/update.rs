// v2.7 U-1/U-2/U-5 应用内更新：GitHub Releases 检查 + 一键下载安装（NSIS 原地升级，半自动方案）。
// 网络尝试顺序：直连(6s) → 本地代理 127.0.0.1:7897 → 7890；版本比较在前端复核，Rust 侧只给字符串与布尔。
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::Emitter;

const RELEASES_API: &str = "https://api.github.com/repos/2019xiaopeng/BookReading/releases/latest";
const PROXY_PORTS: [&str; 2] = ["7897", "7890"];
const DIRECT_TIMEOUT: Duration = Duration::from_secs(6);
const PROXY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    pub notes: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub asset_size: Option<i64>,
}

#[derive(Debug, serde::Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: i64,
}

#[derive(Debug, serde::Deserialize)]
struct GhRelease {
    tag_name: String,
    body: Option<String>,
    assets: Option<Vec<GhAsset>>,
}

fn client(proxy: Option<&str>, timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    // 系统代理探测在 Tauri 环境下可能死锁（winhttp 挂起——实测本应用进程内 build() 永不返回，
    // 同代码 cargo run 独立进程 1.5s 完成）。禁用系统代理探测，只用手动指定的代理。
    let mut b = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout)
        .no_proxy();
    if let Some(port) = proxy {
        b = b.proxy(
            reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?,
        );
    }
    let b = b.user_agent(concat!("BookReading/", env!("CARGO_PKG_VERSION"))); // GitHub API 必须带 UA
    b.build().map_err(|e| e.to_string())
}

// 直连与两个本地代理依次尝试；任一成功即用。
// 代理 403=出口 IP 被 GitHub 限流也算失败，继续尝试（f 回调校验 status）。
fn with_fallback<T>(mut f: impl FnMut(&reqwest::blocking::Client) -> Result<T, String>) -> Result<T, String> {
    let attempts: Vec<Result<reqwest::blocking::Client, String>> = vec![
        client(None, DIRECT_TIMEOUT),
        client(Some(PROXY_PORTS[0]), PROXY_TIMEOUT),
        client(Some(PROXY_PORTS[1]), PROXY_TIMEOUT),
    ];
    let mut last = String::new();
    for c in attempts.into_iter().flatten() {
        match f(&c) {
            Ok(v) => return Ok(v),
            Err(e) => last = e,
        }
    }
    Err(format!("无法连接 GitHub（直连与本地代理均失败）：{last}"))
}

// x.y.z 数值逐段比较（前端另有一份语义化比较复核）；解析失败视为无更新
fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Option<Vec<u64>> {
        s.split('.').map(|p| p.parse::<u64>().ok()).collect::<Option<Vec<_>>>()
    };
    match (parse(latest), parse(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

#[tauri::command(async)]
pub fn check_app_update() -> Result<UpdateInfo, String> {
    // reqwest::blocking 的 Client build 在 Tauri async 命令线程（tokio 上下文）内死锁——
    // 同代码独立进程 1.5s 完成、app 内永不返回（实测）。解法：专用 std::thread 跑全部网络。
    let (tx, rx) = std::sync::mpsc::channel::<Result<UpdateInfo, String>>();
    std::thread::spawn(move || {
        let r = check_app_update_inner();
        let _ = tx.send(r);
    });
    rx.recv().map_err(|_| "更新检查线程异常退出".to_string())?
}

fn check_app_update_inner() -> Result<UpdateInfo, String> {
    let attempts: Vec<Result<reqwest::blocking::Client, String>> = vec![
        client(None, DIRECT_TIMEOUT),
        client(Some(PROXY_PORTS[0]), PROXY_TIMEOUT),
        client(Some(PROXY_PORTS[1]), PROXY_TIMEOUT),
    ];
    let mut last_err = String::new();
    let mut release: Option<GhRelease> = None;
    for c in attempts.into_iter().flatten() {
        match (|| -> Result<GhRelease, String> {
            let resp = c
                .get(RELEASES_API)
                .header("Accept", "application/vnd.github+json")
                .send()
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            let body = resp.text().map_err(|e| e.to_string())?;
            serde_json::from_str(&body).map_err(|e| format!("bad release json: {e}"))
        })() {
            Ok(r) => {
                release = Some(r);
                break;
            }
            Err(e) => last_err = e,
        }
    }
    let release = release.ok_or_else(|| format!("无法连接 GitHub（直连与本地代理均失败）：{last_err}"))?;

    let current = env!("CARGO_PKG_VERSION").to_string();
    let latest = release.tag_name.trim().trim_start_matches('v').trim().to_string();
    let asset = release
        .assets
        .unwrap_or_default()
        .into_iter()
        .find(|a| a.name.to_lowercase().contains("x64-setup.exe"));
    Ok(UpdateInfo {
        has_update: version_newer(&latest, &current),
        notes: release.body.unwrap_or_default().chars().take(2000).collect(),
        asset_name: asset.as_ref().map(|a| a.name.clone()),
        asset_url: asset.as_ref().map(|a| a.browser_download_url.clone()),
        asset_size: asset.as_ref().map(|a| a.size),
        current,
        latest,
    })
}

#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

fn update_dir() -> PathBuf {
    std::env::temp_dir().join("bookreading-update")
}

#[tauri::command(async)]
pub fn download_app_update(app: tauri::AppHandle, asset_url: String) -> Result<String, String> {
    // 同 check_app_update：阻塞客户端必须在专用线程跑（Tauri async 线程内 build 死锁）
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let app2 = app.clone();
    std::thread::spawn(move || {
        let r = download_app_update_inner(app2, asset_url);
        let _ = tx.send(r);
    });
    rx.recv().map_err(|_| "下载线程异常退出".to_string())?
}

fn download_app_update_inner(app: tauri::AppHandle, asset_url: String) -> Result<String, String> {
    let dir = update_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    let name = asset_url
        .rsplit('/')
        .next()
        .unwrap_or("update.exe")
        .split('?')
        .next()
        .unwrap_or("update.exe");
    let path = dir.join(name);

    // 直连/代理依次尝试下载（下载体量大，代理超时放宽到 10s 只管建连）
    let mut response = with_fallback(|c| {
        let resp = c.get(&asset_url).timeout(Duration::from_secs(30)).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        Ok(resp)
    })?;
    let total = response.content_length().unwrap_or(0);

    let mut file = std::fs::File::create(&path).map_err(|e| format!("failed to create {}: {e}", path.display()))?;
    let mut buf = vec![0u8; 64 * 1024];
    let (mut downloaded, mut since_emit) = (0u64, 0u64);
    loop {
        let n = response.read(&mut buf).map_err(|e| format!("download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("failed to write: {e}"))?;
        downloaded += n as u64;
        since_emit += n as u64;
        if since_emit >= 1024 * 1024 {
            // 每 1MB 报一次进度
            let _ = app.emit("update-download-progress", DownloadProgress { downloaded, total });
            since_emit = 0;
        }
    }
    let _ = app.emit("update-download-progress", DownloadProgress { downloaded, total });
    if total > 0 && downloaded != total {
        let _ = std::fs::remove_file(&path);
        return Err(format!("下载不完整（{downloaded}/{total}），已丢弃半截包"));
    }
    if downloaded == 0 {
        let _ = std::fs::remove_file(&path);
        return Err("下载内容为空".to_string());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn run_update_installer(installer_path: String) -> Result<(), String> {
    let p = Path::new(&installer_path);
    // 路径来自前端回传：只执行我们下载目录里的 .exe，防任意程序拉起
    if !p.starts_with(update_dir())
        || p.extension().and_then(|e| e.to_str()).map_or(true, |e| !e.eq_ignore_ascii_case("exe"))
        || !p.is_file()
    {
        return Err(format!("非法安装器路径: {installer_path}"));
    }
    // spawn 挂起启动即返回；NSIS 自己接管（UAC/进度/收尾），前端随后 quit_app
    std::process::Command::new(p)
        .spawn()
        .map_err(|e| format!("启动安装器失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_newer_compares_numeric_segments() {
        assert!(version_newer("2.7.0", "2.6.0"));
        assert!(version_newer("2.6.10", "2.6.9"));
        assert!(version_newer("3.0.0", "2.99.99"));
        assert!(!version_newer("2.6.0", "2.6.0"));
        assert!(!version_newer("2.5.9", "2.6.0"));
        assert!(!version_newer("abc", "2.6.0")); // 解析失败视为无更新
    }

    #[test]
    fn update_info_serializes_camel_case() {
        let info = UpdateInfo {
            current: "2.6.0".into(),
            latest: "2.7.0".into(),
            has_update: true,
            notes: "n".into(),
            asset_name: Some("a".into()),
            asset_url: Some("u".into()),
            asset_size: Some(1),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["hasUpdate"], serde_json::json!(true));
        assert_eq!(json["assetName"], serde_json::json!("a"));
        assert_eq!(json["assetUrl"], serde_json::json!("u"));
        assert_eq!(json["assetSize"], serde_json::json!(1));
    }

    #[test]
    fn installer_path_must_be_exe_inside_update_dir() {
        assert!(run_update_installer(update_dir().join("x.exe").to_string_lossy().into_owned()).is_err());
        assert!(run_update_installer("C:\\Windows\\notepad.exe".into()).is_err());
    }
}

#[cfg(test)]
mod net_probe_tests {
    use super::*;

    #[test]
    fn probe_direct_client_reaches_github() {
        // 只在有网络时跑：直连 6s + 系统代理回退。CI/离线环境跳过。
        if std::env::var("BOOKREADING_NET_PROBE").is_err() {
            return;
        }
        let c = client(None, DIRECT_TIMEOUT).unwrap();
        let r = c.get(RELEASES_API).send();
        assert!(r.is_ok(), "direct github api failed: {:?}", r.err());
    }
}
