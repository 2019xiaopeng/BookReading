use std::cmp::Ordering;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use uuid::Uuid;
use zip::ZipArchive;

use crate::app_paths;
use crate::commands::library::{
    atomic_copy_to, atomic_write_to, fetch_book_by_id, fetch_books, insert_book, now_ts,
    require_library_rel,
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
pub(crate) fn folder_image_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
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
        Ok(ImageSource::Cbz(app_paths::library_abs(app, &lp)?))
    } else {
        Ok(ImageSource::Folder(PathBuf::from(&lp)))
    }
}

fn trim_title(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

// 漫画命名元数据（批次15）：剥离开头的前导 (...) 段（汉化组等发布标记，不作元数据）后
// 匹配 "[作者] 标题"；纯前导括号无中括号时保持原名不解析
fn parse_name_meta(name: &str) -> Option<(String, String)> {
    let mut s = name.trim();
    loop {
        let t = s.trim_start();
        let Some(rest) = t.strip_prefix('(') else { break };
        let Some(close) = rest.find(')') else { break };
        s = rest[close + 1..].trim_start();
    }
    let after = s.strip_prefix('[')?;
    let close = after.find(']')?;
    let author = after[..close].trim();
    let title = after[close + 1..].trim();
    if author.is_empty() || title.is_empty() {
        return None;
    }
    Some((author.to_string(), title.to_string()))
}

// 显式 title_opt 优先（不解析括号，作者留空）；否则文件夹名/CBZ 文件名（去扩展）解析
fn resolve_comic_meta(base: Option<&str>, title_opt: Option<String>) -> (Option<String>, Option<String>) {
    if let Some(t) = trim_title(title_opt) {
        return (Some(t), None);
    }
    let name = base.map(str::trim).filter(|s| !s.is_empty());
    match name.and_then(parse_name_meta) {
        Some((author, title)) => (Some(title), Some(author)),
        None => (name.map(str::to_string), None),
    }
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
    // 封面=原图直出（不缩放不压缩）：书架清晰度只受源文件限制，可用“设置封面”上传高清图替换
    atomic_copy_to(&pages[0].to_string_lossy(), &tmp_cover_abs, &final_cover_abs)
        .map_err(|e| format!("failed to copy cover: {e}"))?;

    let (title, author) = resolve_comic_meta(
        src.file_name().and_then(|s| s.to_str()),
        title_opt,
    );

    let book = Book {
        id: book_id.clone(),
        title,
        author,
        cover_path: Some(format!("library/covers/{book_id}.{ext}")),
        // 原地引用：存源目录绝对路径，删除书时不碰源目录
        library_path: src.to_string_lossy().to_string(),
        added_at: now_ts(),
        last_opened_at: None,
        note: None,
        pinned_at: None,
        format: Some("images".to_string()),
        page_count: Some(pages.len() as i64),
        reading_percent: None,
        is_favorite: false,
        shelf_id: None,
        sort_order: None,
        deleted_at: None,
        description: None,
        content_chars: None,
        file_size: None,
        tags: Vec::new(),
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

    let (title, author) = resolve_comic_meta(
        src.file_stem().and_then(|s| s.to_str()),
        title_opt,
    );

    let book = Book {
        id: book_id.clone(),
        title,
        author,
        cover_path: Some(format!("library/covers/{book_id}.{ext}")),
        library_path: format!("library/books/{book_id}.cbz"),
        added_at: now_ts(),
        last_opened_at: None,
        note: None,
        pinned_at: None,
        format: Some("images".to_string()),
        page_count: Some(names.len() as i64),
        reading_percent: None,
        is_favorite: false,
        shelf_id: None,
        sort_order: None,
        deleted_at: None,
        description: None,
        content_chars: None,
        file_size: None,
        tags: Vec::new(),
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

// 批量导入：父目录的一级子目录，仅保留"直接含图片"的（空/纯文本目录服务端跳过），目录名自然序
#[tauri::command]
pub fn list_image_subdirs(parent: String) -> Result<Vec<String>, String> {    let dir = PathBuf::from(&parent);
    if !dir.is_dir() {
        return Err(format!("{}: 不是文件夹", dir.display()));
    }
    let mut subs: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| format!("failed to read dir {}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| folder_image_files(p).map_or(false, |f| !f.is_empty()))
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    subs.sort_by(|a, b| nat_cmp(a, b));
    Ok(subs)
}

// 批次18：文件夹漫画源目录移动/删除后的"找回"——校验后改写 library_path（原地引用书唯一恢复路径）
#[tauri::command]
pub fn relink_image_book(app: tauri::AppHandle, book_id: String, new_path: String) -> Result<Book, String> {
    let conn = db::open_db(&app)?;
    relink_image_folder(&conn, &book_id, &new_path)
}

// 与前端 normPath 同口径：反斜杠归一 + 小写 + 去尾斜杠，用于"一书一文件夹"防撞比较
fn norm_folder_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn relink_image_folder(conn: &Connection, book_id: &str, new_path: &str) -> Result<Book, String> {
    let book = fetch_book_by_id(conn, book_id).map_err(|e| format!("failed to fetch book: {e}"))?;
    if book.format.as_deref() != Some("images") {
        return Err(format!("{}: 不是图片书，无法重链接", book_id));
    }
    // CBZ 是复制入库的库内文件（相对路径），不会丢源，也不允许改写成文件夹引用
    if Path::new(&book.library_path.replace('\\', "/"))
        .extension()
        .and_then(|e| e.to_str())
        .map_or(false, |e| e.eq_ignore_ascii_case("cbz"))
    {
        return Err("CBZ 漫画文件在书库内，无需重链接".to_string());
    }
    let dir = PathBuf::from(new_path);
    if !dir.is_dir() {
        return Err(format!("{}: 不是文件夹", dir.display()));
    }
    if !dir.is_absolute() {
        return Err(format!("{}: 文件夹引用只支持绝对路径", dir.display()));
    }
    let pages = folder_image_files(&dir)?;
    if pages.is_empty() {
        return Err(format!("{}: 未找到图片（png/jpg/jpeg/webp/gif/avif/bmp）", dir.display()));
    }
    // 防一书双记录：其它在库 images 文件夹书已指向该目录则拒绝（与导入查重同口径，忽略回收站内）
    let new_norm = norm_folder_path(new_path);
    for b in fetch_books(conn).map_err(|e| format!("failed to list books: {e}"))? {
        if b.id != book_id && b.format.as_deref() == Some("images") && norm_folder_path(&b.library_path) == new_norm {
            return Err(format!("该文件夹已链接到《{}》，不能重复链接", b.title.clone().unwrap_or_else(|| b.id.clone())));
        }
    }
    conn.execute(
        "UPDATE books SET library_path = ?2, page_count = ?3 WHERE id = ?1",
        params![book_id, dir.to_string_lossy().to_string(), pages.len() as i64],
    )
    .map_err(|e| format!("failed to update book: {e}"))?;
    fetch_book_by_id(conn, book_id).map_err(|e| format!("failed to fetch book: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn comic_meta_parses_bracket_author_title() {
        assert_eq!(
            resolve_comic_meta(Some("[作者A] 标题B"), None),
            (Some("标题B".to_string()), Some("作者A".to_string()))
        );
        assert_eq!(
            resolve_comic_meta(Some("[A]B"), None),
            (Some("B".to_string()), Some("A".to_string()))
        );
    }

    #[test]
    fn comic_meta_plain_names_stay_whole() {
        assert_eq!(
            resolve_comic_meta(Some("第01卷 漫画名"), None),
            (Some("第01卷 漫画名".to_string()), None)
        );
        assert_eq!(
            resolve_comic_meta(Some("[ ]标题"), None),
            (Some("[ ]标题".to_string()), None)
        );
        assert_eq!(resolve_comic_meta(None, None), (None, None));
    }

    #[test]
    fn comic_meta_title_opt_wins() {
        assert_eq!(
            resolve_comic_meta(Some("[A]B"), Some("显式标题".to_string())),
            (Some("显式标题".to_string()), None)
        );
        // 空白 title_opt 视为未传，回退解析文件名
        assert_eq!(
            resolve_comic_meta(Some("[A]B"), Some("  ".to_string())),
            (Some("B".to_string()), Some("A".to_string()))
        );
    }

    #[test]
    fn comic_meta_leading_parens_dropped_before_bracket() {
        assert_eq!(
            resolve_comic_meta(Some("(汉化组) [A] B"), None),
            (Some("B".to_string()), Some("A".to_string()))
        );
        assert_eq!(
            resolve_comic_meta(Some("(X)(Y) [A]B"), None),
            (Some("B".to_string()), Some("A".to_string()))
        );
        // 无中括号：不剥离不解析，整名作标题
        assert_eq!(
            resolve_comic_meta(Some("(X) 普通名"), None),
            (Some("(X) 普通名".to_string()), None)
        );
    }

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

    #[test]
    fn list_image_subdirs_keeps_only_image_dirs_in_natural_order() {
        let parent = std::env::temp_dir().join(format!("bookreading-subdirs-{}", Uuid::new_v4()));
        for sub in ["vol10", "vol2", "empty", "texts"] {
            fs::create_dir_all(parent.join(sub)).unwrap();
        }
        fs::write(parent.join("vol2").join("a.png"), b"x").unwrap();
        fs::write(parent.join("vol10").join("b.jpg"), b"x").unwrap();
        fs::write(parent.join("texts").join("n.txt"), b"x").unwrap();
        // 根下散文件与深层图片均不算：只看一级子目录是否"直接含图"
        fs::write(parent.join("loose.png"), b"x").unwrap();
        fs::create_dir_all(parent.join("texts").join("inner")).unwrap();
        fs::write(parent.join("texts").join("inner").join("deep.png"), b"x").unwrap();

        let subs = list_image_subdirs(parent.to_string_lossy().to_string()).unwrap();
        let names: Vec<String> = subs
            .iter()
            .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["vol2", "vol10"]);
        assert!(list_image_subdirs(parent.join("missing").to_string_lossy().to_string()).is_err());
        let _ = fs::remove_dir_all(&parent);
    }

    // ---- 批次18 源文件夹重链接 ----

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        conn
    }

    fn book_row(id: &str, library_path: &str, format: Option<&str>) -> Book {
        Book {
            id: id.to_string(),
            title: Some(id.to_string()),
            author: None,
            cover_path: None,
            library_path: library_path.to_string(),
            added_at: 1,
            last_opened_at: None,
            note: None,
            pinned_at: None,
            format: format.map(str::to_string),
            page_count: None,
            reading_percent: None,
            is_favorite: false,
            shelf_id: None,
            sort_order: None,
            deleted_at: None,
            description: None,
            content_chars: None,
            file_size: None,
            tags: Vec::new(),
        }
    }

    #[test]
    fn relink_rejects_non_images_and_cbz() {
        let conn = test_conn();
        insert_book(&conn, &book_row("b1", "library/books/b1.epub", None)).unwrap();
        assert!(relink_image_folder(&conn, "b1", "C:/whatever").unwrap_err().contains("不是图片书"));
        insert_book(&conn, &book_row("b2", "library/books/b2.cbz", Some("images"))).unwrap();
        assert!(relink_image_folder(&conn, "b2", "C:/whatever").unwrap_err().contains("CBZ"));
        assert!(relink_image_folder(&conn, "missing", "C:/whatever").is_err());
    }

    #[test]
    fn relink_rejects_missing_or_empty_dir() {
        let conn = test_conn();
        insert_book(&conn, &book_row("b1", "D:/gone/comic", Some("images"))).unwrap();
        let root = std::env::temp_dir().join(format!("bookreading-relink-{}", Uuid::new_v4()));
        let empty = root.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(relink_image_folder(&conn, "b1", root.join("missing").to_string_lossy().as_ref())
            .unwrap_err()
            .contains("不是文件夹"));
        assert!(relink_image_folder(&conn, "b1", empty.to_string_lossy().as_ref())
            .unwrap_err()
            .contains("未找到图片"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn relink_updates_path_and_page_count() {
        let conn = test_conn();
        insert_book(&conn, &book_row("b1", "D:/gone/comic", Some("images"))).unwrap();
        let dir = std::env::temp_dir().join(format!("bookreading-relink-ok-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("p2.png"), b"x").unwrap();
        fs::write(dir.join("p10.png"), b"x").unwrap();

        let updated = relink_image_folder(&conn, "b1", dir.to_string_lossy().as_ref()).unwrap();
        assert_eq!(updated.library_path, dir.to_string_lossy().to_string());
        assert_eq!(updated.page_count, Some(2));
        let again = fetch_book_by_id(&conn, "b1").unwrap();
        assert_eq!(again.library_path, dir.to_string_lossy().to_string());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn relink_rejects_folder_already_linked_by_another_book() {
        let conn = test_conn();
        let dir = std::env::temp_dir().join(format!("bookreading-relink-dup-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("p1.png"), b"x").unwrap();
        // 已有书指向同一目录（反斜杠 + 大小写差异也要撞车：规范化比较）
        let other = dir.to_string_lossy().replace('/', "\\").to_uppercase();
        insert_book(&conn, &book_row("other", &other, Some("images"))).unwrap();
        insert_book(&conn, &book_row("b2", "D:/gone/other", Some("images"))).unwrap();
        let err = relink_image_folder(&conn, "b2", dir.to_string_lossy().as_ref()).unwrap_err();
        assert!(err.contains("已链接"), "unexpected: {err}");
        // 自身路径不变
        assert_eq!(fetch_book_by_id(&conn, "b2").unwrap().library_path, "D:/gone/other");
        let _ = fs::remove_dir_all(&dir);
    }
}
