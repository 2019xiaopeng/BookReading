// v2.6.0 一·八 A+B：EPUB 阅读优化副本（.opt.epub）——插图降采样 + xhtml img 尺寸注入。
// v2.7 B-1 v2：剥离音视频条目 + xhtml 移除 <video>/<audio> + jpg/png 字节阈值重编码。
// 只换 media 资源不动结构（CFI 不受影响）；OPF/xhtml 除注入尺寸外字节级保留。
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use image::ImageEncoder;
use regex::Regex;
use tauri::Emitter;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::app_paths;
use crate::commands::images::sniff_dimensions;
use crate::commands::library::{encode_jpeg, encode_webp_lossless};
use crate::db;

// 长边 >1800 才缩；缩到 1520（纸面 2x DPR 上限）
const TRIGGER_LONG: u32 = 1800;
const TARGET_LONG: u32 = 1520;
// B-1 v2：jpg/png 超过此字节数即使尺寸达标也重编码（大插图书多为"尺寸合格但字节肥"）
const BYTES_TRIGGER: usize = 300 * 1024;
// 尺寸嗅探只读条目头部（PNG IHDR/JPEG SOF 都在前 128KB 内）
const HEAD_BYTES: u64 = 128 * 1024;

pub(crate) fn ext_lower(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map_or_else(String::new, |e| e.to_lowercase())
}

fn is_opt_image(name: &str) -> bool {
    matches!(ext_lower(name).as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif")
}

fn is_xhtml(name: &str) -> bool {
    matches!(ext_lower(name).as_str(), "xhtml" | "html" | "htm")
}

// B-1 v2：可播放音视频（V-1 媒体面板白名单同源）
pub(crate) fn is_media_entry(name: &str) -> bool {
    matches!(ext_lower(name).as_str(), "mp4" | "mp3" | "m4a" | "ogg" | "wav" | "avi")
}

// .opt 剥离集 = 音视频 + smil（媒体叠加时间轴，非可播放文件）
fn is_stripped_entry(name: &str) -> bool {
    is_media_entry(name) || ext_lower(name) == "smil"
}

fn basename_lower(name: &str) -> String {
    name.rsplit(['/', '\\']).next().unwrap_or(name).to_lowercase()
}

/// 同目录 {stem}.opt.epub（foo.epub → foo.opt.epub）
pub(crate) fn opt_path(src: &Path) -> PathBuf {
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    src.with_file_name(format!("{stem}.opt.epub"))
}

// 缩放后目标尺寸，与 image::resize 的取整口径一致（round(边×比例)）。
// shortcut: 若重编码未变小（保留原始字节），属性值与实际像素差一个等比缩放，纵横比不变不影响布局
fn final_dims((w, h): (u32, u32)) -> (u32, u32) {
    let long = w.max(h);
    if long <= TRIGGER_LONG || long == 0 {
        return (w, h);
    }
    let s = TARGET_LONG as f64 / long as f64;
    ((w as f64 * s).round() as u32, (h as f64 * s).round() as u32)
}

// R1 图片重编码：GIF 动图透传；长边>1800 LANCZOS3 缩到 1520；B-1 v2 jpg/png >300KB
// 即使尺寸达标也重编码（jpeg q85 / png 无损重打包，容器格式保持不变）。
// 缩幅 <10% 或解码失败保留原始字节
fn process_image(bytes: &[u8], ext: &str) -> Vec<u8> {
    let passthrough = || bytes.to_vec();
    if ext == "gif" {
        return passthrough();
    }
    let Ok(img) = image::load_from_memory(bytes) else {
        return passthrough();
    };
    let big = img.width().max(img.height()) > TRIGGER_LONG;
    let fat = bytes.len() > BYTES_TRIGGER && matches!(ext, "jpg" | "jpeg" | "png");
    if !big && !fat {
        return passthrough();
    }
    let target = if big {
        img.resize(TARGET_LONG, TARGET_LONG, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let encoded: Result<Vec<u8>, String> = match ext {
        "jpg" | "jpeg" => encode_jpeg(&target, 85),
        "png" => {
            let rgba = target.to_rgba8();
            let mut buf = Vec::new();
            image::codecs::png::PngEncoder::new(&mut buf)
                .write_image(rgba.as_raw(), rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
                .map(|_| buf)
                .map_err(|e| format!("png encode: {e}"))
        }
        "webp" => encode_webp_lossless(&target),
        _ => return passthrough(),
    };
    match encoded {
        Ok(v) if v.len() * 10 < bytes.len() * 9 => v,
        _ => passthrough(),
    }
}

// B-1 v2：xhtml 内整体移除 <video>/<audio> 元素（含自闭合变体），其余内容保留。
// shortcut: 正则非贪婪配对，未闭合的 <video> 不动（EPUB XHTML 要求良构，罕见）
fn strip_av_elements(html: &str) -> String {
    static AV: OnceLock<Regex> = OnceLock::new();
    let re = AV.get_or_init(|| {
        Regex::new(r"(?is)<(video|audio)\b[^>]*/>|<(video|audio)\b[^>]*>.*?</(video|audio)\s*>").unwrap()
    });
    re.replace_all(html, "").into_owned()
}

// R2：往缺 width/height 的 <img> 注入实量尺寸（仅当 src 基名在已测图片表内）；
// B-1 v2：同时移除 <video>/<audio> 元素。非 UTF-8 的 xhtml 原样返回。
// shortcut: 纯正则匹配、src 不做 URL 解码、SVG 包装的 <image xlink:href>（Z-Library 风格）本轮不处理
fn rebuild_xhtml(bytes: &[u8], dims: &HashMap<String, (u32, u32)>) -> Vec<u8> {
    match std::str::from_utf8(bytes) {
        Ok(text) => strip_av_elements(&inject_img_dims_str(text, dims)).into_bytes(),
        Err(_) => bytes.to_vec(),
    }
}

fn inject_img_dims_str(html: &str, dims: &HashMap<String, (u32, u32)>) -> String {
    static IMG_TAG: OnceLock<Regex> = OnceLock::new();
    static DIM_ATTR: OnceLock<Regex> = OnceLock::new();
    static SRC_ATTR: OnceLock<Regex> = OnceLock::new();
    let img_tag = IMG_TAG.get_or_init(|| Regex::new(r"(?i)<img\b[^>]*>").unwrap());
    let dim_attr = DIM_ATTR.get_or_init(|| Regex::new(r#"(?i)\b(width|height)\s*="#).unwrap());
    let src_attr = SRC_ATTR.get_or_init(|| Regex::new(r#"(?i)\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap());

    let mut out = String::with_capacity(html.len());
    let mut last = 0usize;
    for m in img_tag.find_iter(html) {
        out.push_str(&html[last..m.start()]);
        let tag = m.as_str();
        let patched = if dim_attr.is_match(tag) {
            tag.to_string() // 已有任一尺寸属性：不动，避免重复属性
        } else {
            let found = src_attr
                .captures(tag)
                .and_then(|c| c.get(1).or_else(|| c.get(2)))
                .and_then(|src| dims.get(&basename_lower(src.as_str())));
            match found {
                Some(&(w, h)) if w > 0 && h > 0 => {
                    let (body, close) = if let Some(b) = tag.strip_suffix("/>") {
                        (b, "/>")
                    } else if let Some(b) = tag.strip_suffix('>') {
                        (b, ">")
                    } else {
                        (tag, "")
                    };
                    if close.is_empty() {
                        tag.to_string()
                    } else if body.ends_with(char::is_whitespace) {
                        format!(r#"{body}width="{w}" height="{h}"{close}"#)
                    } else {
                        format!(r#"{body} width="{w}" height="{h}"{close}"#)
                    }
                }
                _ => tag.to_string(),
            }
        };
        out.push_str(&patched);
        last = m.end();
    }
    out.push_str(&html[last..]);
    out
}

/// 生成同目录 {stem}.opt.epub：mimetype 保持 STORED 且最前（沿用原条目顺序）；
/// 图片条目按 process_image 优化；xhtml 注入 img 尺寸并移除 video/audio 元素；
/// 音视频/媒体叠加条目整条跳过；其余条目字节原样。
/// 包内无可测图片时返回 Ok(false)（无事可做，不落盘——txt 转 epub 等纯文字书走原书）。
pub fn optimize_epub_file(src: &Path) -> Result<bool, String> {
    let f = fs::File::open(src).map_err(|e| format!("failed to open {}: {e}", src.display()))?;
    let mut zip = ZipArchive::new(BufReader::new(f))
        .map_err(|e| format!("failed to read epub {}: {e}", src.display()))?;

    // Pass 1：量全部图片条目的最终尺寸（只读头部，不解码像素）
    let mut dims: HashMap<String, (u32, u32)> = HashMap::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("failed to read entry: {e}"))?;
        if entry.is_dir() || !is_opt_image(entry.name()) {
            continue;
        }
        let mut head = Vec::new();
        let _ = Read::take(&mut entry, HEAD_BYTES).read_to_end(&mut head);
        let d = sniff_dimensions(&head);
        if d.0 > 0 && d.1 > 0 {
            dims.insert(basename_lower(entry.name()), final_dims(d));
        }
    }
    if dims.is_empty() {
        return Ok(false);
    }

    // Pass 2：逐条目重打包（保持原条目顺序 → mimetype 天然最前；音视频条目跳过）
    let out = opt_path(src);
    // B-4：临时名带 uuid，防"启动补生成线程"与"导入内联优化"两个写者互踩同一 .part
    let tmp = PathBuf::from(format!("{}.part-{}", out.display(), Uuid::new_v4()));
    let mut w = ZipWriter::new(
        fs::File::create(&tmp).map_err(|e| format!("failed to create {}: {e}", tmp.display()))?,
    );
    let mut error: Option<String> = None;
    'entries: for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("failed to read entry: {e}"))?;
        let name = entry.name().to_string();
        if !entry.is_dir() && is_stripped_entry(&name) {
            continue; // B-1 v2：音视频/媒体叠加条目不进阅读副本
        }
        let mut bytes = Vec::new();
        if let Err(e) = entry.read_to_end(&mut bytes) {
            error = Some(format!("failed to read {name}: {e}"));
            break;
        }
        let is_mimetype = name == "mimetype";
        let opts = if is_mimetype {
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored)
        } else {
            SimpleFileOptions::default()
        };
        let res = if entry.is_dir() {
            w.add_directory(name.as_str(), opts)
        } else {
            let payload = if is_mimetype {
                bytes
            } else if is_opt_image(&name) {
                process_image(&bytes, &ext_lower(&name))
            } else if is_xhtml(&name) {
                rebuild_xhtml(&bytes, &dims)
            } else {
                bytes
            };
            w.start_file(name.as_str(), opts).and_then(|_| Ok(w.write_all(&payload)?))
        };
        if let Err(e) = res {
            error = Some(format!("failed to write {name}: {e}"));
            break 'entries;
        }
    }
    let finished = w.finish();
    if let (None, Ok(file)) = (&error, finished) {
        drop(file); // 落盘后再改名
        fs::rename(&tmp, &out).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("failed to rename into place: {e}")
        })?;
        Ok(true)
    } else {
        let _ = fs::remove_file(&tmp);
        Err(error.unwrap_or_else(|| "failed to finish zip".to_string()))
    }
}

// 存量候选：未软删、库内 .epub（排除 .opt.epub 自身）
fn candidate_epubs(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let rows: Vec<String> = conn
        .prepare("SELECT library_path FROM books WHERE deleted_at IS NULL")
        .map_err(|e| format!("failed to list books: {e}"))?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("failed to query books: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to read books: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|lp| lp.replace('\\', "/"))
        .filter(|lp| {
            let lower = lp.to_lowercase();
            lp.starts_with("library/") && lower.ends_with(".epub") && !lower.ends_with(".opt.epub")
        })
        .collect())
}

#[derive(Clone, serde::Serialize)]
struct EpubOptProgress {
    done: usize,
    total: usize,
}

/// 存量 .opt.epub 幂等补生成：立即返回候选总数，后台线程逐本生成（已有跳过，
/// 独立 open_db_bg 连接取清单后不再碰库），每本 emit "epub-opt-progress" {done,total}。
/// B-3：按文件体积降序处理——最危险的大书最先拿到 .opt（file_size 列可能为 NULL，fs 实测最稳）。
#[tauri::command(async)]
pub fn optimize_epub_images(app: tauri::AppHandle) -> Result<u32, String> {
    let books = candidate_epubs(&db::open_db_bg(&app)?)?;
    let total = books.len();
    let handle = app.clone();
    std::thread::spawn(move || {
        let Ok(root) = app_paths::library_dir(&handle) else { return };
        let mut sized: Vec<(u64, String)> = books
            .into_iter()
            .map(|lp| {
                let abs = root.join(lp.strip_prefix("library/").unwrap_or(&lp));
                let size = fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
                (size, lp)
            })
            .collect();
        sized.sort_by(|a, b| b.0.cmp(&a.0));
        for (i, (_, lp)) in sized.into_iter().enumerate() {
            let abs = root.join(lp.strip_prefix("library/").unwrap_or(&lp));
            if !opt_path(&abs).exists() {
                if let Err(e) = optimize_epub_file(&abs) {
                    eprintln!("[epub-opt] {}: {e}", abs.display());
                }
            }
            let _ = handle.emit("epub-opt-progress", EpubOptProgress { done: i + 1, total });
        }
    });
    Ok(total as u32)
}

/// B-2 配套：单本立即优化。已有 .opt 或非库内 epub（引用书）返回 false；
/// 启动后台线程生成，进度事件复用 "epub-opt-progress"（单本 total=1，done 0→1）。
#[tauri::command(async)]
pub fn optimize_epub_now(app: tauri::AppHandle, book_id: String) -> Result<bool, String> {
    let lp: String = db::open_db(&app)?
        .query_row("SELECT library_path FROM books WHERE id = ?1", [&book_id], |r| r.get(0))
        .map_err(|_| format!("书 {book_id} 不存在"))?;
    let lp = lp.replace('\\', "/");
    let lower = lp.to_lowercase();
    if !lower.ends_with(".epub") || lower.ends_with(".opt.epub") {
        return Ok(false);
    }
    let Some(rest) = lp.strip_prefix("library/") else {
        return Ok(false); // 引用书（绝对路径）：.opt 无处消费，不做
    };
    let abs = app_paths::library_dir(&app)?.join(rest);
    if opt_path(&abs).exists() {
        return Ok(false);
    }
    let handle = app.clone();
    let _ = handle.emit("epub-opt-progress", EpubOptProgress { done: 0, total: 1 });
    std::thread::spawn(move || {
        if let Err(e) = optimize_epub_file(&abs) {
            eprintln!("[epub-opt] {}: {e}", abs.display());
        }
        let _ = handle.emit("epub-opt-progress", EpubOptProgress { done: 1, total: 1 });
    });
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bookreading-{tag}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // 伪随机噪点：PNG 压不动，字节量≈像素数（缩放前后大小差能稳定超 10% 阈值）
    fn noise_png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([
                ((x * 7 + y * 13) % 251) as u8,
                ((x * 31 + y * 5) % 241) as u8,
                ((x * 3 + y * 17) % 251) as u8,
            ])
        });
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        buf
    }

    fn write_zip(path: &Path, entries: &[(&str, Vec<u8>, bool)]) {
        let mut w = ZipWriter::new(fs::File::create(path).unwrap());
        for (name, bytes, stored) in entries {
            let mut opts = SimpleFileOptions::default();
            if *stored {
                opts = opts.compression_method(CompressionMethod::Stored);
            }
            w.start_file(name, opts).unwrap();
            w.write_all(bytes).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn optimize_shrinks_big_image_injects_dims_and_keeps_rest_verbatim() {
        let dir = temp("opt-big");
        let src = dir.join("book.epub");
        let big = noise_png(1900, 120);
        let xhtml = br#"<html><body><p><img src="images/big.png"/><img width="9" src="images/big.png"/><img src="images/unknown.png"/></p></body></html>"#.to_vec();
        write_zip(
            &src,
            &[
                ("mimetype", b"application/epub+zip".to_vec(), true),
                ("META-INF/container.xml", b"<container/>".to_vec(), false),
                ("OEBPS/ch1.xhtml", xhtml, false),
                ("OEBPS/images/big.png", big.clone(), false),
            ],
        );

        assert_eq!(optimize_epub_file(&src).unwrap(), true);
        let opt = dir.join("book.opt.epub");
        assert!(opt.is_file(), ".opt.epub not generated");

        let mut zip = ZipArchive::new(BufReader::new(fs::File::open(&opt).unwrap())).unwrap();
        // 条目顺序保持，mimetype 仍 STORED 且在最前
        let first = zip.by_index(0).unwrap();
        assert_eq!(first.name(), "mimetype");
        assert_eq!(first.compression(), CompressionMethod::Stored);
        drop(first);
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert_eq!(
            names,
            vec!["mimetype", "META-INF/container.xml", "OEBPS/ch1.xhtml", "OEBPS/images/big.png"]
        );
        // 非图片条目字节一致
        let mut container = Vec::new();
        zip.by_index(1).unwrap().read_to_end(&mut container).unwrap();
        assert_eq!(container, b"<container/>".to_vec());
        // 大图缩到长边 1520（1900x120 → 1520x96）
        let mut img_bytes = Vec::new();
        zip.by_index(3).unwrap().read_to_end(&mut img_bytes).unwrap();
        let decoded = image::load_from_memory(&img_bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1520, 96));
        assert!(img_bytes.len() * 10 < big.len() * 9, "expect >=10% shrink");
        // xhtml：缺尺寸的 img 注入实量；已有 width 的不动；基名不在表内的不动
        let mut text = Vec::new();
        zip.by_index(2).unwrap().read_to_end(&mut text).unwrap();
        let text = String::from_utf8(text).unwrap();
        assert!(text.contains(r#"<img src="images/big.png" width="1520" height="96"/>"#), "{text}");
        assert!(text.contains(r#"<img width="9" src="images/big.png"/>"#), "{text}");
        assert!(text.contains(r#"<img src="images/unknown.png"/>"#), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn optimize_keeps_small_images_byte_verbatim() {
        let dir = temp("opt-small");
        let src = dir.join("s.epub");
        let small = noise_png(800, 600);
        write_zip(
            &src,
            &[
                ("mimetype", b"application/epub+zip".to_vec(), true),
                ("OEBPS/ch1.xhtml", br#"<img src="images/s.png">"#.to_vec(), false),
                ("OEBPS/images/s.png", small.clone(), false),
            ],
        );

        assert_eq!(optimize_epub_file(&src).unwrap(), true);
        let mut zip = ZipArchive::new(BufReader::new(fs::File::open(dir.join("s.opt.epub")).unwrap())).unwrap();
        let mut img_bytes = Vec::new();
        zip.by_index(2).unwrap().read_to_end(&mut img_bytes).unwrap();
        assert_eq!(img_bytes, small, "small image bytes must pass through");
        let mut text = Vec::new();
        zip.by_index(1).unwrap().read_to_end(&mut text).unwrap();
        assert_eq!(
            String::from_utf8(text).unwrap(),
            r#"<img src="images/s.png" width="800" height="600">"#
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn optimize_skips_imageless_epub() {
        let dir = temp("opt-none");
        let src = dir.join("t.epub");
        write_zip(
            &src,
            &[
                ("mimetype", b"application/epub+zip".to_vec(), true),
                ("OEBPS/ch1.xhtml", b"<p>text</p>".to_vec(), false),
            ],
        );
        assert_eq!(optimize_epub_file(&src).unwrap(), false);
        assert!(!dir.join("t.opt.epub").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    // B-1 v2：音视频/媒体叠加条目整条剥除；xhtml 内 video/audio 元素移除（含自闭合）
    #[test]
    fn optimize_strips_av_entries_and_elements() {
        let dir = temp("opt-av");
        let src = dir.join("av.epub");
        let small = noise_png(800, 600);
        let xhtml = r#"<html><body><p>前</p><video src="video/ch1.mp4" width="640">fallback</video><audio controls src="audio/a.mp3">no audio</audio><audio src="audio/b.ogg"/><p>正文 <img src="images/s.png"></p></body></html>"#
            .as_bytes()
            .to_vec();
        write_zip(
            &src,
            &[
                ("mimetype", b"application/epub+zip".to_vec(), true),
                ("OEBPS/ch1.xhtml", xhtml, false),
                ("OEBPS/images/s.png", small, false),
                ("OEBPS/video/ch1.mp4", vec![1u8; 128], false),
                ("OEBPS/audio/a.mp3", vec![2u8; 64], false),
                ("OEBPS/audio/b.ogg", vec![3u8; 32], false),
                ("OEBPS/nav.smil", b"<smil/>".to_vec(), false),
            ],
        );

        assert_eq!(optimize_epub_file(&src).unwrap(), true);
        let mut zip = ZipArchive::new(BufReader::new(fs::File::open(dir.join("av.opt.epub")).unwrap())).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert_eq!(names, vec!["mimetype", "OEBPS/ch1.xhtml", "OEBPS/images/s.png"]);
        let mut text = Vec::new();
        zip.by_index(1).unwrap().read_to_end(&mut text).unwrap();
        let text = String::from_utf8(text).unwrap();
        assert!(!text.contains("video") && !text.contains("audio"), "{text}");
        // 元素外内容保留；img 尺寸注入照常工作
        assert!(text.contains("<p>前</p>") && text.contains("<p>正文"), "{text}");
        assert!(
            text.contains(r#"<img src="images/s.png" width="800" height="600">"#),
            "{text}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // B-1 v2：jpg >300KB 即使长边 ≤1800 也重编码（q85），尺寸不动、缩幅 ≥10% 才换
    #[test]
    fn optimize_reencodes_fat_small_jpg() {
        let dir = temp("opt-fat");
        let src = dir.join("fat.epub");
        let img = image::RgbImage::from_fn(1000, 1000, |x, y| {
            image::Rgb([
                ((x * 7 + y * 13) % 251) as u8,
                ((x * 31 + y * 5) % 241) as u8,
                ((x * 3 + y * 17) % 251) as u8,
            ])
        });
        let mut fat = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut fat, 100)
            .write_image(img.as_raw(), 1000, 1000, image::ExtendedColorType::Rgb8)
            .unwrap();
        assert!(fat.len() > BYTES_TRIGGER, "fixture must exceed byte threshold: {}", fat.len());
        write_zip(
            &src,
            &[
                ("mimetype", b"application/epub+zip".to_vec(), true),
                ("OEBPS/i.jpg", fat.clone(), false),
            ],
        );

        assert_eq!(optimize_epub_file(&src).unwrap(), true);
        let mut zip = ZipArchive::new(BufReader::new(fs::File::open(dir.join("fat.opt.epub")).unwrap())).unwrap();
        let mut out = Vec::new();
        zip.by_index(1).unwrap().read_to_end(&mut out).unwrap();
        let decoded = image::load_from_memory(&out).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1000, 1000)); // 尺寸达标不动尺寸
        assert!(out.len() * 10 < fat.len() * 9, "expect >=10% shrink: {} -> {}", fat.len(), out.len());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn strip_av_handles_plain_and_selfclosing_only() {
        assert_eq!(strip_av_elements("<p>a<video>b</video>c</p>"), "<p>ac</p>");
        assert_eq!(strip_av_elements(r#"<audio src="x.ogg"/>"#), "");
        // 未闭合标签不动（良构 EPUB 不会出现）
        assert_eq!(strip_av_elements("<video>unclosed"), "<video>unclosed");
    }
}
