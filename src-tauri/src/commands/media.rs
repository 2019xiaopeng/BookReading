// v2.7 V-1/P-1：多媒体 EPUB 的原书条目访问。.opt 剥掉音视频后，观看/原图入口回到原书 zip——
// 只读目录与单条目字节，不解压整包，大视频不进内存全书。
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use zip::ZipArchive;

use crate::app_paths;
use crate::commands::epub_optimize::{ext_lower, is_media_entry};
use crate::commands::library::fetch_book_by_id;
use crate::db;
use crate::epub::read_limited;

// P-1 lightbox 原图条目白名单（svg/avif/bmp 前端按 blob 展示同样可行）
const IMAGE_ENTRY_EXTS: [&str; 8] = ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp"];
// 单条目读取上限——按实际读出的字节算，不信 zip 头里（可伪造的）声明大小。
// 原图 512 MiB（image 解码器自身上限的量级）；音视频整条读进内存再交给前端，1 GiB 封顶
const MAX_IMAGE_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MEDIA_ENTRY_BYTES: u64 = 1024 * 1024 * 1024;

fn is_image_entry(name: &str) -> bool {
    IMAGE_ENTRY_EXTS.contains(&ext_lower(name).as_str())
}

#[derive(Debug, serde::Serialize)]
pub struct MediaEntry {
    pub name: String,
    pub size: u64,
    pub ext: String,
}

// 原书 zip 绝对路径：library/ 相对路径按当前库根解析，绝对路径（引用导入/文件夹漫画）原样
fn original_book_abs(app: &tauri::AppHandle, conn: &rusqlite::Connection, book_id: &str) -> Result<PathBuf, String> {
    let book = fetch_book_by_id(conn, book_id).map_err(|_| format!("书 {book_id} 不存在"))?;
    let lp = book.library_path.replace('\\', "/");
    if let Some(rest) = lp.strip_prefix("library/") {
        Ok(app_paths::library_dir(app)?.join(rest))
    } else if Path::new(&lp).is_absolute() {
        Ok(PathBuf::from(&lp))
    } else {
        Err(format!("无法识别的库路径: {}", book.library_path))
    }
}

fn open_zip(path: &Path) -> Result<ZipArchive<BufReader<fs::File>>, String> {
    let f = fs::File::open(path).map_err(|e| format!("源文件不存在 {}: {e}", path.display()))?;
    ZipArchive::new(BufReader::new(f)).map_err(|e| format!("不是有效的 EPUB/CBZ 包: {e}"))
}

// 只读目录：列出全部音视频条目（V-1 媒体面板数据源）
fn list_media_entries(path: &Path) -> Result<Vec<MediaEntry>, String> {
    let mut zip = open_zip(path)?;
    let mut out = Vec::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| format!("failed to read entry: {e}"))?;
        let name = entry.name();
        if entry.is_dir() || !is_media_entry(name) {
            continue;
        }
        out.push(MediaEntry {
            name: name.to_string(),
            size: entry.size(),
            ext: ext_lower(name),
        });
    }
    Ok(out)
}

// 按条目名读单条字节；白名单闸防把 xhtml/opf 等任意条目当媒体读出（名字即 zip 键，无路径穿越面）
fn read_allowed_entry(
    path: &Path,
    name: &str,
    allow: fn(&str) -> bool,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    if name.is_empty() || !allow(name) {
        return Err(format!("不允许读取的条目: {name}"));
    }
    let mut zip = open_zip(path)?;
    let mut entry = zip.by_name(name).map_err(|_| format!("条目不存在: {name}"))?;
    read_limited(&mut entry, max_bytes).map_err(|e| format!("failed to read {name}: {e}"))
}

#[tauri::command(async)]
pub fn list_book_media(app: tauri::AppHandle, book_id: String) -> Result<Vec<MediaEntry>, String> {
    let conn = db::open_db(&app)?;
    let abs = original_book_abs(&app, &conn, &book_id)?;
    list_media_entries(&abs)
}

#[tauri::command(async)]
pub fn read_book_media(
    app: tauri::AppHandle,
    book_id: String,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    let conn = db::open_db(&app)?;
    let abs = original_book_abs(&app, &conn, &book_id)?;
    let bytes = read_allowed_entry(&abs, &name, is_media_entry, MAX_MEDIA_ENTRY_BYTES)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command(async)]
pub fn read_epub_image(
    app: tauri::AppHandle,
    book_id: String,
    entry_name: String,
) -> Result<tauri::ipc::Response, String> {
    let conn = db::open_db(&app)?;
    let abs = original_book_abs(&app, &conn, &book_id)?;
    let bytes = read_allowed_entry(&abs, &entry_name, is_image_entry, MAX_IMAGE_ENTRY_BYTES)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use uuid::Uuid;

    fn temp_zip(entries: &[(&str, Vec<u8>)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bookreading-media-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.epub");
        let mut w = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        for (name, bytes) in entries {
            w.start_file(name.to_string(), opts).unwrap();
            w.write_all(bytes).unwrap();
        }
        w.finish().unwrap();
        path
    }

    #[test]
    fn lists_only_media_entries_with_size_and_ext() {
        let path = temp_zip(&[
            ("mimetype", b"application/epub+zip".to_vec()),
            ("OEBPS/ch1.xhtml", b"<p>x</p>".to_vec()),
            ("OEBPS/video/v1.MP4", vec![1u8; 1024]),
            ("OEBPS/audio/a1.mp3", vec![2u8; 512]),
            ("OEBPS/audio/a2.ogg", vec![3u8; 256]),
            ("OEBPS/nav.smil", b"<smil/>".to_vec()), // smil 不进媒体面板
        ]);
        let media = list_media_entries(&path).unwrap();
        let names: Vec<&str> = media.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["OEBPS/video/v1.MP4", "OEBPS/audio/a1.mp3", "OEBPS/audio/a2.ogg"]);
        assert_eq!(media[0].ext, "mp4"); // 大写扩展名归一
        assert_eq!(media[0].size, 1024);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn reads_media_and_image_entries_but_rejects_others() {
        let path = temp_zip(&[
            ("mimetype", b"application/epub+zip".to_vec()),
            ("OEBPS/ch1.xhtml", b"secret-html".to_vec()),
            ("OEBPS/video/v1.mp4", vec![9u8; 32]),
            ("OEBPS/images/pic.PNG", b"png-bytes".to_vec()),
        ]);
        // 媒体白名单：能读 mp4，不能借道读 xhtml
        assert_eq!(read_allowed_entry(&path, "OEBPS/video/v1.mp4", is_media_entry, 1 << 20).unwrap(), vec![9u8; 32]);
        assert!(read_allowed_entry(&path, "OEBPS/ch1.xhtml", is_media_entry, 1 << 20).is_err());
        assert!(read_allowed_entry(&path, "OEBPS/nope.mp4", is_media_entry, 1 << 20).is_err());
        // 图片白名单：能读 png（大写扩展名过），不能读 xhtml
        assert_eq!(
            read_allowed_entry(&path, "OEBPS/images/pic.PNG", is_image_entry, 1 << 20).unwrap(),
            b"png-bytes".to_vec()
        );
        assert!(read_allowed_entry(&path, "OEBPS/ch1.xhtml", is_image_entry, 1 << 20).is_err());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
