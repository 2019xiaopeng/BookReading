use std::cmp::Ordering;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use uuid::Uuid;
use zip::ZipArchive;

use crate::app_paths;
use crate::commands::library::{
    atomic_copy_to, atomic_write_to, fetch_book_by_id, insert_book, now_ts, require_library_rel,
};
use crate::db;
use crate::models::Book;

const IMAGE_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"];

fn is_image_name(name: &str) -> bool {
    !name.ends_with('/')
        && Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .map_or(false, |e| IMAGE_EXTS.contains(&e.to_lowercase().as_str()))
}

// 自然排序：数字段按数值比较，第 2 页排在第 10 页前
fn nat_cmp(a: &str, b: &str) -> Ordering {
    fn take_digits(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
        let mut s = String::new();
        while matches!(it.peek(), Some(c) if c.is_ascii_digit()) {
            s.push(it.next().unwrap());
        }
        s
    }

    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        let ad = matches!(ai.peek(), Some(c) if c.is_ascii_digit());
        let bd = matches!(bi.peek(), Some(c) if c.is_ascii_digit());
        match (ai.peek(), bi.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(_), Some(_)) if ad && bd => {
                let an = take_digits(&mut ai);
                let bn = take_digits(&mut bi);
                let at = an.trim_start_matches('0');
                let bt = bn.trim_start_matches('0');
                match at.len().cmp(&bt.len()).then_with(|| at.cmp(bt)) {
                    Ordering::Equal => {}
                    o => return o,
                }
            }
            (Some(_), Some(_)) => match ai
                .next()
                .unwrap()
                .to_ascii_lowercase()
                .cmp(&bi.next().unwrap().to_ascii_lowercase())
            {
                Ordering::Equal => {}
                o => return o,
            },
        }
    }
}

// 单层遍历（不递归），只收图片文件，按文件名自然排序
fn folder_image_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| format!("failed to read dir {}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && p.file_name().map_or(false, |n| is_image_name(&n.to_string_lossy())))
        .collect();
    files.sort_by(|a, b| nat_cmp(&a.to_string_lossy(), &b.to_string_lossy()));
    Ok(files)
}

fn open_cbz(path: &Path) -> Result<ZipArchive<fs::File>, String> {
    let f = fs::File::open(path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    ZipArchive::new(f).map_err(|e| format!("failed to read cbz {}: {e}", path.display()))
}

// CBZ 按压缩包内条目顺序取页
fn cbz_image_names(path: &Path) -> Result<Vec<String>, String> {
    let mut zip = open_cbz(path)?;
    let mut names = Vec::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| format!("failed to read cbz entry: {e}"))?;
        let name = entry.name().to_string();
        if !entry.is_dir() && is_image_name(&name) {
            names.push(name);
        }
    }
    Ok(names)
}

fn read_cbz_page(path: &Path, index: usize) -> Result<Vec<u8>, String> {
    let mut zip = open_cbz(path)?;
    let mut page = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("failed to read cbz entry: {e}"))?;
        if entry.is_dir() || !is_image_name(entry.name()) {
            continue;
        }
        if page == index {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| format!("failed to read cbz page: {e}"))?;
            return Ok(buf);
        }
        page += 1;
    }
    Err(format!("页码 {index} 超出范围（共 {page} 页）"))
}

enum ImageSource {
    // 文件夹：原地引用的绝对路径，不复制、不改动源目录
    Folder(PathBuf),
    Cbz(PathBuf),
}

fn resolve_image_source(app: &tauri::AppHandle, book: &Book) -> Result<ImageSource, String> {
    if book.format.as_deref() != Some("images") {
        return Err(format!("{}: 不是图片书", book.id));
    }
    let lp = book.library_path.replace('\\', "/");
    if Path::new(&lp)
        .extension()
        .and_then(|e| e.to_str())
        .map_or(false, |e| e.eq_ignore_ascii_case("cbz"))
    {
        require_library_rel(&lp)?;
        Ok(ImageSource::Cbz(app_paths::app_data_dir(app)?.join(&lp)))
    } else {
        Ok(ImageSource::Folder(PathBuf::from(&lp)))
    }
}

fn trim_title(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn import_image_folder(
    app: tauri::AppHandle,
    source_path: String,
    title_opt: Option<String>,
) -> Result<Book, String> {
    let src = PathBuf::from(&source_path);
    let is_cbz = src
        .extension()
        .and_then(|e| e.to_str())
        .map_or(false, |e| e.eq_ignore_ascii_case("cbz"));
    if is_cbz {
        import_cbz(&app, &src, title_opt)
    } else {
        import_folder(&app, &src, title_opt)
    }
}

fn import_folder(app: &tauri::AppHandle, src: &Path, title_opt: Option<String>) -> Result<Book, String> {
    if !src.is_dir() {
        return Err(format!("{}: 不是文件夹", src.display()));
    }
    if !src.is_absolute() {
        return Err(format!("{}: 文件夹引用只支持绝对路径", src.display()));
    }
    let pages = folder_image_files(src)?;
    if pages.is_empty() {
        return Err(format!("{}: 未找到图片（png/jpg/jpeg/webp/gif/avif/bmp）", src.display()));
    }

    let book_id = Uuid::new_v4().to_string();
    let covers_dir = app_paths::covers_dir(app)?;
    fs::create_dir_all(&covers_dir).map_err(|e| format!("failed to create covers dir: {e}"))?;

    let ext = pages[0]
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "png".to_string());
    let final_cover_abs = covers_dir.join(format!("{book_id}.{ext}"));
    let tmp_cover_abs = covers_dir.join(format!("{book_id}.{ext}.part"));
    atomic_copy_to(&pages[0].to_string_lossy(), &tmp_cover_abs, &final_cover_abs)
        .map_err(|e| format!("failed to copy cover: {e}"))?;

    let title = trim_title(title_opt).or_else(|| {
        src.file_name()
            .and_then(|s| s.to_str())
            .and_then(|s| trim_title(Some(s.to_string())))
    });

    let book = Book {
        id: book_id.clone(),
        title,
        author: None,
        cover_path: Some(format!("library/covers/{book_id}.{ext}")),
        // 原地引用：存源目录绝对路径，删除书时不碰源目录
        library_path: src.to_string_lossy().to_string(),
        added_at: now_ts(),
        last_opened_at: None,
        note: None,
        group_name: None,
        pinned_at: None,
        format: Some("images".to_string()),
        page_count: Some(pages.len() as i64),
        reading_percent: None,
        is_favorite: false,
    };

    let conn = db::open_db(app)?;
    if let Err(e) = insert_book(&conn, &book) {
        let _ = fs::remove_file(&final_cover_abs);
        return Err(format!("failed to insert book: {e}"));
    }
    Ok(book)
}

fn import_cbz(app: &tauri::AppHandle, src: &Path, title_opt: Option<String>) -> Result<Book, String> {
    if !src.is_file() {
        return Err(format!("{}: 不是 CBZ 文件", src.display()));
    }
    let names = cbz_image_names(src)?;
    if names.is_empty() {
        return Err(format!("{}: CBZ 内未找到图片", src.display()));
    }

    let book_id = Uuid::new_v4().to_string();
    let books_dir = app_paths::books_dir(app)?;
    let covers_dir = app_paths::covers_dir(app)?;
    fs::create_dir_all(&books_dir).map_err(|e| format!("failed to create books dir: {e}"))?;
    fs::create_dir_all(&covers_dir).map_err(|e| format!("failed to create covers dir: {e}"))?;

    let final_book_abs = books_dir.join(format!("{book_id}.cbz"));
    let tmp_book_abs = books_dir.join(format!("{book_id}.cbz.part"));
    atomic_copy_to(&src.to_string_lossy(), &tmp_book_abs, &final_book_abs)
        .map_err(|e| format!("failed to copy cbz into library: {e}"))?;

    let ext = Path::new(&names[0])
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .filter(|e| IMAGE_EXTS.contains(&e.as_str()))
        .unwrap_or_else(|| "png".to_string());
    let final_cover_abs = covers_dir.join(format!("{book_id}.{ext}"));
    let tmp_cover_abs = covers_dir.join(format!("{book_id}.{ext}.part"));
    if let Err(e) =
        read_cbz_page(&final_book_abs, 0).and_then(|bytes| atomic_write_to(&tmp_cover_abs, &final_cover_abs, &bytes))
    {
        let _ = fs::remove_file(&final_book_abs);
        return Err(format!("failed to write cover: {e}"));
    }

    let title = trim_title(title_opt).or_else(|| {
        src.file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| trim_title(Some(s.to_string())))
    });

    let book = Book {
        id: book_id.clone(),
        title,
        author: None,
        cover_path: Some(format!("library/covers/{book_id}.{ext}")),
        library_path: format!("library/books/{book_id}.cbz"),
        added_at: now_ts(),
        last_opened_at: None,
        note: None,
        group_name: None,
        pinned_at: None,
        format: Some("images".to_string()),
        page_count: Some(names.len() as i64),
        reading_percent: None,
        is_favorite: false,
    };

    let conn = db::open_db(app)?;
    if let Err(e) = insert_book(&conn, &book) {
        let _ = fs::remove_file(&final_book_abs);
        let _ = fs::remove_file(&final_cover_abs);
        return Err(format!("failed to insert book: {e}"));
    }
    Ok(book)
}

#[tauri::command]
pub fn list_image_pages(app: tauri::AppHandle, book_id: String) -> Result<Vec<String>, String> {
    let conn = db::open_db(&app)?;
    let book = fetch_book_by_id(&conn, &book_id).map_err(|e| format!("failed to fetch book: {e}"))?;
    match resolve_image_source(&app, &book)? {
        ImageSource::Folder(dir) => Ok(folder_image_files(&dir)?
            .iter()
            .map(|p| p.file_name().map_or(String::new(), |n| n.to_string_lossy().to_string()))
            .collect()),
        ImageSource::Cbz(path) => cbz_image_names(&path),
    }
}

#[tauri::command]
pub fn read_image_page(app: tauri::AppHandle, book_id: String, index: usize) -> Result<tauri::ipc::Response, String> {
    let conn = db::open_db(&app)?;
    let book = fetch_book_by_id(&conn, &book_id).map_err(|e| format!("failed to fetch book: {e}"))?;
    match resolve_image_source(&app, &book)? {
        ImageSource::Folder(dir) => {
            let pages = folder_image_files(&dir)?;
            let path = pages
                .get(index)
                .ok_or_else(|| format!("页码 {index} 超出范围（共 {} 页）", pages.len()))?;
            fs::read(path).map(tauri::ipc::Response::new).map_err(|e| format!("failed to read page {}: {e}", path.display()))
        }
        ImageSource::Cbz(path) => read_cbz_page(&path, index).map(tauri::ipc::Response::new),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn nat_cmp_sorts_digit_runs_numerically() {
        let mut names = vec!["p10.png", "p2.png", "p1.png"];
        names.sort_by(|a, b| nat_cmp(a, b));
        assert_eq!(names, vec!["p1.png", "p2.png", "p10.png"]);
        assert_eq!(nat_cmp("a02", "a2"), Ordering::Equal);
        assert_eq!(nat_cmp("a1b", "a1c"), Ordering::Less);
    }

    #[test]
    fn folder_image_files_single_level_natural_order() {
        let dir = std::env::temp_dir().join(format!("bookreading-img-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        for name in ["p10.png", "p2.png", "p1.jpg", "note.txt"] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("p0.png"), b"x").unwrap();

        let names: Vec<String> = folder_image_files(&dir)
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["p1.jpg", "p2.png", "p10.png"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cbz_pages_follow_entry_order_and_bounds_error() {
        let path = std::env::temp_dir().join(format!("bookreading-cbz-{}.cbz", Uuid::new_v4()));
        let file = fs::File::create(&path).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, bytes) in [("b/notes.txt", b"t" as &[u8]), ("002.png", b"two"), ("001.png", b"one")] {
            zw.start_file(name, opts).unwrap();
            zw.write_all(bytes).unwrap();
        }
        zw.finish().unwrap();

        assert_eq!(cbz_image_names(&path).unwrap(), vec!["002.png", "001.png"]);
        assert_eq!(read_cbz_page(&path, 0).unwrap(), b"two");
        assert_eq!(read_cbz_page(&path, 1).unwrap(), b"one");
        assert!(read_cbz_page(&path, 2).is_err());
        let _ = fs::remove_file(&path);
    }
}
