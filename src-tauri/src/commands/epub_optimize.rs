// v2.6.0 一·八 A+B：EPUB 阅读优化副本（.opt.epub）——插图降采样 + xhtml img 尺寸注入。
// 只换 media 资源不动结构（CFI 不受影响）；OPF/xhtml 除注入尺寸外字节级保留。
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use image::ImageEncoder;
use regex::Regex;
use tauri::Emitter;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::app_paths;
use crate::commands::images::sniff_dimensions;
use crate::commands::library::{encode_jpeg, encode_webp_lossless};
use crate::db;

// 长边 >1800 才缩；缩到 1520（纸面 2x DPR 上限）
const TRIGGER_LONG: u32 = 1800;
const TARGET_LONG: u32 = 1520;
// 尺寸嗅探只读条目头部（PNG IHDR/JPEG SOF 都在前 128KB 内）
const HEAD_BYTES: u64 = 128 * 1024;

fn ext_lower(name: &str) -> String {
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

// R1 图片重编码：GIF 动图透传；长边>1800 才 LANCZOS3 缩到 1520，容器格式保持
// 不变（jpeg q85 / png 无损 / webp 无损重打包），缩幅 <10% 或解码失败保留原始字节
fn process_image(bytes: &[u8], ext: &str) -> Vec<u8> {
    let passthrough = || bytes.to_vec();
    if ext == "gif" {
        return passthrough();
    }
    let Ok(img) = image::load_from_memory(bytes) else {
        return passthrough();
    };
    if img.width().max(img.height()) <= TRIGGER_LONG {
        return passthrough();
    }
    let resized = img.resize(TARGET_LONG, TARGET_LONG, image::imageops::FilterType::Lanczos3);
    let encoded: Result<Vec<u8>, String> = match ext {
        "jpg" | "jpeg" => encode_jpeg(&resized, 85),
        "png" => {
            let rgba = resized.to_rgba8();
            let mut buf = Vec::new();
            image::codecs::png::PngEncoder::new(&mut buf)
                .write_image(rgba.as_raw(), rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
                .map(|_| buf)
                .map_err(|e| format!("png encode: {e}"))
        }
        "webp" => encode_webp_lossless(&resized),
        _ => return passthrough(),
    };
    match encoded {
        Ok(v) if v.len() * 10 < bytes.len() * 9 => v,
        _ => passthrough(),
    }
}

// R2：往缺 width/height 的 <img> 注入实量尺寸（仅当 src 基名在已测图片表内）
// shortcut: 纯正则匹配、src 不做 URL 解码、SVG 包装的 <image xlink:href>（Z-Library 风格）本轮不处理
fn inject_img_dims(bytes: &[u8], dims: &HashMap<String, (u32, u32)>) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    inject_img_dims_str(text, dims).into_bytes()
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
/// 图片条目按 process_image 优化；xhtml 注入 img 尺寸；其余条目字节原样。
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

    // Pass 2：逐条目重打包（保持原条目顺序 → mimetype 天然最前）
    let out = opt_path(src);
    let mut tmp = out.clone().into_os_string();
    tmp.push(".part");
    let tmp = PathBuf::from(tmp);
    let mut w = ZipWriter::new(
        fs::File::create(&tmp).map_err(|e| format!("failed to create {}: {e}", tmp.display()))?,
    );
    let mut error: Option<String> = None;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("failed to read entry: {e}"))?;
        let name = entry.name().to_string();
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
                inject_img_dims(&bytes, &dims)
            } else {
                bytes
            };
            w.start_file(name.as_str(), opts).and_then(|_| Ok(w.write_all(&payload)?))
        };
        if let Err(e) = res {
            error = Some(format!("failed to write {name}: {e}"));
            break;
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
#[tauri::command(async)]
pub fn optimize_epub_images(app: tauri::AppHandle) -> Result<u32, String> {
    let books = candidate_epubs(&db::open_db_bg(&app)?)?;
    let total = books.len();
    let handle = app.clone();
    std::thread::spawn(move || {
        let Ok(root) = app_paths::library_dir(&handle) else { return };
        for (i, lp) in books.iter().enumerate() {
            let abs = root.join(lp.strip_prefix("library/").unwrap_or(lp));
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
}
