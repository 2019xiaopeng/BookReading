use std::fs;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use image::ImageEncoder;
use rusqlite::{params, Connection};
use tauri::Emitter;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::app_paths;
use crate::db;
use crate::epub;
use crate::models::{Book, BookTagBrief, ImportBookRequest, UpdateBookMetadataRequest};
use crate::txt;

pub(crate) fn now_ts() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn is_safe_rel_path(p: &str) -> bool {
    let path = Path::new(p);
    if !path.is_relative() {
        return false;
    }
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => return false,
            std::path::Component::Prefix(_) => return false,
            std::path::Component::RootDir => return false,
            _ => {}
        }
    }
    true
}

pub(crate) fn require_library_rel(p: &str) -> Result<&str, String> {
    let v = p.replace('\\', "/");
    if !v.starts_with("library/") {
        return Err(format!("invalid library path: {p}"));
    }
    if !is_safe_rel_path(&v) {
        return Err(format!("unsafe relative path: {p}"));
    }
    Ok(p)
}

fn abs_from_library_rel(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    require_library_rel(&rel)?;
    app_paths::library_abs(app, &rel)
}

pub(crate) fn atomic_copy_to(src: &str, tmp: &Path, final_path: &Path) -> Result<(), String> {
    fs::copy(src, tmp).map_err(|e| format!("failed to copy file: {e}"))?;
    if let Err(e) = fs::rename(tmp, final_path) {
        let _ = fs::remove_file(tmp);
        return Err(format!("failed to rename into place: {e}"));
    }
    Ok(())
}

pub(crate) fn atomic_write_to(tmp: &Path, final_path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::write(tmp, bytes).map_err(|e| format!("failed to write file: {e}"))?;
    if let Err(e) = fs::rename(tmp, final_path) {
        let _ = fs::remove_file(tmp);
        return Err(format!("failed to rename into place: {e}"));
    }
    Ok(())
}

pub(crate) fn insert_book(conn: &Connection, book: &Book) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO books (id, title, author, cover_path, library_path, added_at, last_opened_at, is_favorite, format, page_count, shelf_id, sort_order, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            book.id,
            book.title,
            book.author,
            book.cover_path,
            book.library_path,
            book.added_at,
            book.last_opened_at,
            book.is_favorite,
            book.format,
            book.page_count,
            book.shelf_id,
            book.sort_order,
            book.deleted_at
        ],
    )?;
    Ok(())
}

pub(crate) fn fetch_books(conn: &Connection) -> Result<Vec<Book>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.title, b.author, b.cover_path, b.library_path, b.added_at, b.last_opened_at,
               b.is_favorite, b.note, b.pinned_at, b.format, b.page_count, b.shelf_id, b.sort_order, b.deleted_at, r.percent,
               b.description, b.content_chars, b.file_size
         FROM books b LEFT JOIN reading_state r ON r.book_id = b.id
         WHERE b.deleted_at IS NULL
         ORDER BY (b.pinned_at IS NULL) ASC, COALESCE(b.pinned_at, 0) DESC, COALESCE(b.last_opened_at, b.added_at) DESC",
    )?;

    let mut books = stmt
        .query_map([], |row| {
            Ok(Book {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                cover_path: row.get(3)?,
                library_path: row.get(4)?,
                added_at: row.get(5)?,
                last_opened_at: row.get(6)?,
                is_favorite: row.get(7)?,
                note: row.get(8)?,
                pinned_at: row.get(9)?,
                format: row.get(10)?,
                page_count: row.get(11)?,
                shelf_id: row.get(12)?,
                sort_order: row.get(13)?,
                deleted_at: row.get(14)?,
                reading_percent: row.get(15)?,
                description: row.get(16)?,
                content_chars: row.get(17)?,
                file_size: row.get(18)?,
                tags: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    attach_book_tags(conn, &mut books)?;
    Ok(books)
}

// 二次查询组装 tags（fetch_books 已过滤软删书）
pub(crate) fn attach_book_tags(conn: &Connection, books: &mut [Book]) -> Result<(), rusqlite::Error> {
    if books.is_empty() {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT bt.book_id, t.id, t.name, t.color
         FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
         ORDER BY t.sort_order, t.name",
    )?;
    let mut by_book: std::collections::HashMap<String, Vec<BookTagBrief>> = std::collections::HashMap::new();
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            BookTagBrief {
                id: row.get(1)?,
                name: row.get(2)?,
                color: row.get(3)?,
            },
        ))
    })?;
    for r in rows {
        let (book_id, brief) = r?;
        by_book.entry(book_id).or_default().push(brief);
    }
    for b in books.iter_mut() {
        b.tags = by_book.remove(&b.id).unwrap_or_default();
    }
    Ok(())
}

fn delete_book_by_id(conn: &Connection, book_id: &str) -> Result<(Option<String>, Option<String>), rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT library_path, cover_path FROM books WHERE id = ?1")?;
    let mut rows = stmt.query([book_id])?;

    let (library_path, cover_path): (Option<String>, Option<String>) = if let Some(row) = rows.next()? {
        (Some(row.get(0)?), row.get(1)?)
    } else {
        (None, None)
    };

    Ok((library_path, cover_path))
}

pub(crate) fn fetch_book_by_id(conn: &Connection, book_id: &str) -> Result<Book, rusqlite::Error> {
    conn.query_row(
        "SELECT id, title, author, cover_path, library_path, added_at, last_opened_at,
               is_favorite, note, pinned_at, format, page_count, shelf_id, sort_order, deleted_at,
               description, content_chars, file_size
         FROM books
         WHERE id = ?1",
        [book_id],
        |row| {
            Ok(Book {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                cover_path: row.get(3)?,
                library_path: row.get(4)?,
                added_at: row.get(5)?,
                last_opened_at: row.get(6)?,
                is_favorite: row.get(7)?,
                note: row.get(8)?,
                pinned_at: row.get(9)?,
                format: row.get(10)?,
                page_count: row.get(11)?,
                shelf_id: row.get(12)?,
                sort_order: row.get(13)?,
                deleted_at: row.get(14)?,
                reading_percent: None,
                description: row.get(15)?,
                content_chars: row.get(16)?,
                file_size: row.get(17)?,
                tags: Vec::new(),
            })
        },
    )
}

fn merge_optional_text(update: Option<String>, existing: Option<String>) -> Option<String> {
    match update {
        Some(v) => {
            let t = v.trim().to_string();
            if t.is_empty() {
                existing
            } else {
                Some(t)
            }
        }
        None => existing,
    }
}

#[tauri::command(async)]
pub fn repair_book_metadata(app: tauri::AppHandle, book_id: String) -> Result<Book, String> {
    let conn = db::open_db(&app)?;
    let existing =
        fetch_book_by_id(&conn, &book_id).map_err(|e| format!("failed to fetch book: {e}"))?;

    let books_dir = app_paths::books_dir(&app)?;
    let epub_abs = books_dir.join(format!("{book_id}.epub"));
    if !epub_abs.exists() {
        return Ok(existing);
    }

    let extracted = epub::extract_epub_metadata(&epub_abs).ok();
    let title = merge_optional_text(extracted.as_ref().and_then(|m| m.title.clone()), existing.title.clone());
    let author = merge_optional_text(extracted.as_ref().and_then(|m| m.author.clone()), existing.author.clone());

    let mut cover_path = existing.cover_path.clone();
    if let Some(rel) = cover_path.as_deref() {
        if let Ok(abs) = abs_from_library_rel(&app, rel) {
            if !abs.exists() {
                cover_path = None;
            }
        }
    }
    if cover_path.is_none() {
        if let Some(bytes) = extracted.as_ref().and_then(|m| m.cover_bytes.as_ref()) {
            if !bytes.is_empty() {
                let ext = extracted
                    .as_ref()
                    .and_then(|m| m.cover_ext.as_ref())
                    .map(|s| s.trim().trim_start_matches('.').to_lowercase())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "png".to_string());
                let allowed = ["png", "jpg", "jpeg", "webp"];
                if allowed.contains(&ext.as_str()) {
                    let covers_dir = app_paths::covers_dir(&app)?;
                    fs::create_dir_all(&covers_dir)
                        .map_err(|e| format!("failed to create covers dir: {e}"))?;
                    let final_cover_abs = covers_dir.join(format!("{book_id}.{ext}"));
                    let tmp_cover_abs = covers_dir.join(format!("{book_id}.{ext}.part"));
                    atomic_write_to(&tmp_cover_abs, &final_cover_abs, bytes)
                        .map_err(|e| format!("failed to write cover: {e}"))?;
                    gen_cover_thumb(&covers_dir.join("thumbs"), &book_id, &final_cover_abs);
                    cover_path = Some(format!("library/covers/{book_id}.{ext}"));
                }
            }
        }
    }

    conn.execute(
        "UPDATE books SET title = ?2, author = ?3, cover_path = ?4 WHERE id = ?1",
        params![book_id, title, author, cover_path],
    )
    .map_err(|e| format!("failed to update book: {e}"))?;

    fetch_book_by_id(&conn, &book_id).map_err(|e| format!("failed to fetch book: {e}"))
}

#[tauri::command(async)]
pub fn list_books(app: tauri::AppHandle) -> Result<Vec<Book>, String> {
    let conn = db::open_db(&app)?;
    fetch_books(&conn).map_err(|e| format!("failed to list books: {e}"))
}

/// 单书查询（替换前端三处全量 list_books 拉书）
#[tauri::command(async)]
pub fn get_book(app: tauri::AppHandle, book_id: String) -> Result<Option<Book>, String> {
    let conn = db::open_db(&app)?;
    match fetch_book_by_id(&conn, &book_id) {
        Ok(b) => Ok(Some(b)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("failed to fetch book: {e}")),
    }
}

#[tauri::command(async)]
pub fn import_book(app: tauri::AppHandle, req: ImportBookRequest) -> Result<Book, String> {
    let book_id = Uuid::new_v4().to_string();

    let books_dir = app_paths::books_dir(&app)?;
    let covers_dir = app_paths::covers_dir(&app)?;

    fs::create_dir_all(&books_dir).map_err(|e| format!("failed to create books dir: {e}"))?;
    fs::create_dir_all(&covers_dir).map_err(|e| format!("failed to create covers dir: {e}"))?;

    let fallback_title = Path::new(&req.source_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // sniff before touching the library: magic bytes first, then extension
    let mut head = [0u8; 5];
    fs::File::open(&req.source_path)
        .and_then(|mut f| f.read(&mut head))
        .map_err(|e| format!("failed to read {}: {e}", req.source_path))?;

    let ext = Path::new(&req.source_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    let is_txt = ext.as_deref() == Some("txt");
    // PDF（魔数优先，扩展名兜底）：原样入库 format='pdf'，无封面（文字卡）、页数由前端 pdfjs 读取
    let is_pdf = head.starts_with(b"%PDF-") || ext.as_deref() == Some("pdf");

    let final_book_abs: PathBuf;
    let tmp_book_abs: PathBuf;
    let mut book_format: Option<String> = None;
    let library_path: String;
    if is_pdf {
        final_book_abs = books_dir.join(format!("{book_id}.pdf"));
        tmp_book_abs = books_dir.join(format!("{book_id}.pdf.part"));
        atomic_copy_to(&req.source_path, &tmp_book_abs, &final_book_abs)
            .map_err(|e| format!("failed to copy pdf into library: {e}"))?;
        book_format = Some("pdf".to_string());
        library_path = format!("library/books/{book_id}.pdf");
    } else if is_txt {
        final_book_abs = books_dir.join(format!("{book_id}.epub"));
        tmp_book_abs = books_dir.join(format!("{book_id}.epub.part"));
        let bytes = fs::read(&req.source_path)
            .map_err(|e| format!("failed to read {}: {e}", req.source_path))?;
        let text = txt::decode_txt(&bytes).map_err(|e| format!("{}: {e}", req.source_path))?;
        let epub_bytes = txt::txt_to_epub(fallback_title.as_deref().unwrap_or("未命名"), &text)
            .map_err(|e| format!("{}: {e}", req.source_path))?;
        atomic_write_to(&tmp_book_abs, &final_book_abs, &epub_bytes)
            .map_err(|e| format!("failed to write book into library: {e}"))?;
        library_path = format!("library/books/{book_id}.epub");
    } else if ext.as_deref() == Some("epub") {
        final_book_abs = books_dir.join(format!("{book_id}.epub"));
        tmp_book_abs = books_dir.join(format!("{book_id}.epub.part"));
        atomic_copy_to(&req.source_path, &tmp_book_abs, &final_book_abs)
            .map_err(|e| format!("failed to copy epub into library: {e}"))?;
        library_path = format!("library/books/{book_id}.epub");
    } else {
        return Err(format!("{}: 暂不支持该格式", req.source_path));
    }

    let extracted = if is_txt || is_pdf {
        None
    } else {
        epub::extract_epub_metadata(&final_book_abs).ok()
    };

    let title = merge_optional_text(
        req.title.clone().or_else(|| extracted.as_ref().and_then(|m| m.title.clone())),
        fallback_title,
    );
    let author = merge_optional_text(req.author.clone(), extracted.as_ref().and_then(|m| m.author.clone()));

    let cover_ext = extracted.as_ref().and_then(|m| m.cover_ext.clone());
    let cover_abs: Option<PathBuf> = match (extracted.as_ref().and_then(|m| m.cover_bytes.as_deref()), cover_ext.as_deref()) {
        (Some(bytes), Some(ext)) if !bytes.is_empty() && !ext.is_empty() => {
            let ext = ext.trim().trim_start_matches('.').to_lowercase();
            let allowed = ["png", "jpg", "jpeg", "webp"];
            if !allowed.contains(&ext.as_str()) {
                None
            } else {
                let final_cover_abs = covers_dir.join(format!("{book_id}.{ext}"));
                let tmp_cover_abs = covers_dir.join(format!("{book_id}.{ext}.part"));
                if let Err(e) = atomic_write_to(&tmp_cover_abs, &final_cover_abs, bytes) {
                    let _ = fs::remove_file(&final_book_abs);
                    return Err(format!("failed to write cover: {e}"));
                }
                Some(final_cover_abs)
            }
        }
        _ => None,
    };

    let cover_path = cover_abs
        .as_ref()
        .and_then(|p| p.extension().and_then(|e| e.to_str()))
        .map(|ext| format!("library/covers/{book_id}.{ext}"));

    let book = Book {
        id: book_id,
        title,
        author,
        cover_path,
        library_path,
        added_at: now_ts(),
        last_opened_at: None,
        note: None,
        pinned_at: None,
        format: book_format,
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
    };

    let conn = db::open_db(&app)?;
    if let Err(e) = insert_book(&conn, &book) {
        let _ = fs::remove_file(&final_book_abs);
        if let Some(p) = cover_abs.as_ref() {
            let _ = fs::remove_file(p);
        }
        return Err(format!("failed to insert book: {e}"));
    }

    // 封面落库成功后顺手生成缩略档（best-effort，失败不影响导入）
    if let (Some(abs), Ok(thumbs)) = (cover_abs.as_ref(), thumbs_dir(&app)) {
        gen_cover_thumb(&thumbs, &book.id, abs);
    }

    Ok(book)
}

// rename must never blank out a title; repair merges only fill gaps, so blank = user error
fn validated_title(req_title: &Option<String>) -> Result<Option<String>, String> {
    match req_title {
        Some(t) => {
            let t = t.trim();
            if t.is_empty() {
                Err("标题不能为空".to_string())
            } else {
                Ok(Some(t.to_string()))
            }
        }
        None => Ok(None),
    }
}

fn merge_metadata(existing: &Book, req: &UpdateBookMetadataRequest, now: i64) -> Book {
    let apply = |update: &Option<String>, current: &Option<String>| -> Option<String> {
        match update {
            Some(v) => {
                let t = v.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                }
            }
            None => current.clone(),
        }
    };
    Book {
        // blank titles are rejected by validated_title before merge runs
        title: match &req.title {
            Some(t) => Some(t.trim().to_string()),
            None => existing.title.clone(),
        },
        note: apply(&req.note, &existing.note),
        author: apply(&req.author, &existing.author),
        description: apply(&req.description, &existing.description),
        pinned_at: match req.pinned {
            Some(true) => Some(now),
            Some(false) => None,
            None => existing.pinned_at,
        },
        ..existing.clone()
    }
}

#[tauri::command(async)]
pub fn update_book_metadata(app: tauri::AppHandle, req: UpdateBookMetadataRequest) -> Result<Book, String> {
    let conn = db::open_db(&app)?;

    let existing =
        fetch_book_by_id(&conn, &req.book_id).map_err(|e| format!("failed to fetch book: {e}"))?;
    validated_title(&req.title)?;
    let merged = merge_metadata(&existing, &req, now_ts());

    conn.execute(
        "UPDATE books SET note = ?2, pinned_at = ?3, title = ?4, author = ?5, description = ?6 WHERE id = ?1",
        params![req.book_id, merged.note, merged.pinned_at, merged.title, merged.author, merged.description],
    )
    .map_err(|e| format!("failed to update book: {e}"))?;

    fetch_book_by_id(&conn, &req.book_id).map_err(|e| format!("failed to fetch book: {e}"))
}

#[tauri::command(async)]
pub fn delete_book(app: tauri::AppHandle, book_id: String) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    let (library_path, cover_path) =
        delete_book_by_id(&conn, &book_id).map_err(|e| format!("failed to load book paths: {e}"))?;

    let trash_dir = app_paths::trash_dir(&app)?;
    fs::create_dir_all(&trash_dir).map_err(|e| format!("failed to create trash dir: {e}"))?;

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();

    if let Some(rel) = library_path.as_deref() {
        if let Ok(abs) = abs_from_library_rel(&app, rel) {
            if abs.exists() {
                let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("epub");
                let trash = trash_dir.join(format!("{}-{}.{}", book_id, Uuid::new_v4(), ext));
                if let Err(e) = fs::rename(&abs, &trash) {
                    for (t, o) in moved.iter() {
                        let _ = fs::rename(t, o);
                    }
                    return Err(format!("failed to move book to trash: {e}"));
                }
                moved.push((trash, abs));
            }
        }
    }

    if let Some(rel) = cover_path.as_deref() {
        if let Ok(abs) = abs_from_library_rel(&app, rel) {
            if abs.exists() {
                let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("img");
                let trash = trash_dir.join(format!("{}-{}.{}", book_id, Uuid::new_v4(), ext));
                if let Err(e) = fs::rename(&abs, &trash) {
                    for (t, o) in moved.iter() {
                        let _ = fs::rename(t, o);
                    }
                    return Err(format!("failed to move cover to trash: {e}"));
                }
                moved.push((trash, abs));
            }
        }
    }

    if let Err(e) = conn.execute("DELETE FROM books WHERE id = ?1", [&book_id]) {
        for (trash, original) in moved.iter() {
            let _ = fs::rename(trash, original);
        }
        return Err(format!("failed to delete book: {e}"));
    }

    for (trash, _) in moved {
        let _ = fs::remove_file(trash);
    }

    Ok(())
}

// png/jpg/webp 且 ≤8MB：阅读背景与自定义封面共用校验，返回小写扩展名
fn validate_image_file(source_path: &str) -> Result<String, String> {
    let ext = Path::new(source_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("不支持的图片格式，仅支持 PNG/JPG/WebP".to_string());
    }
    let meta = fs::metadata(source_path).map_err(|e| format!("failed to read {source_path}: {e}"))?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("图片超过 8MB 限制".to_string());
    }
    Ok(ext)
}

// core takes bg_dir so tests can run against a tempdir instead of real appdata
fn store_reader_background(bg_dir: &Path, source_path: &str) -> Result<String, String> {
    let ext = validate_image_file(source_path)?;
    fs::create_dir_all(bg_dir).map_err(|e| format!("failed to create bg dir: {e}"))?;
    let final_bg = bg_dir.join(format!("bg.{ext}"));
    let tmp_bg = bg_dir.join(format!("bg.{ext}.part"));
    atomic_copy_to(source_path, &tmp_bg, &final_bg)
        .map_err(|e| format!("failed to save background: {e}"))?;
    // single slot: drop stale bg.* of other extensions, best-effort
    let keep = format!("bg.{ext}");
    if let Ok(entries) = fs::read_dir(bg_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("bg.") && name.as_ref() != keep.as_str() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(keep)
}

#[tauri::command(async)]
pub fn save_reader_background(app: tauri::AppHandle, source_path: String) -> Result<String, String> {
    let bg_dir = app_paths::library_dir(&app)?.join("bg");
    let name = store_reader_background(&bg_dir, &source_path)?;
    Ok(format!("library/bg/{name}"))
}

// B11 自定义正文字体：ttf/otf/woff2 且 ≤20MB，返回小写扩展名
fn validate_font_file(source_path: &str) -> Result<String, String> {
    let ext = Path::new(source_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "ttf" | "otf" | "woff2") {
        return Err("不支持的字体格式，仅支持 TTF/OTF/WOFF2".to_string());
    }
    let meta = fs::metadata(source_path).map_err(|e| format!("failed to read {source_path}: {e}"))?;
    if meta.len() > 20 * 1024 * 1024 {
        return Err("字体文件超过 20MB 限制".to_string());
    }
    Ok(ext)
}

// core takes fonts_dir so tests can run against a tempdir instead of real appdata
fn store_reader_font(fonts_dir: &Path, source_path: &str) -> Result<String, String> {
    let ext = validate_font_file(source_path)?;
    fs::create_dir_all(fonts_dir).map_err(|e| format!("failed to create fonts dir: {e}"))?;
    let final_font = fonts_dir.join(format!("font.{ext}"));
    let tmp_font = fonts_dir.join(format!("font.{ext}.part"));
    atomic_copy_to(source_path, &tmp_font, &final_font)
        .map_err(|e| format!("failed to save font: {e}"))?;
    // single slot: drop stale font.* of other extensions, best-effort
    let keep = format!("font.{ext}");
    if let Ok(entries) = fs::read_dir(fonts_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("font.") && name.as_ref() != keep.as_str() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(keep)
}

#[tauri::command(async)]
pub fn save_reader_font(app: tauri::AppHandle, source_path: String) -> Result<String, String> {
    let fonts_dir = app_paths::library_dir(&app)?.join("fonts");
    let name = store_reader_font(&fonts_dir, &source_path)?;
    Ok(format!("library/fonts/{name}"))
}

/// B11 恢复默认：删除字体单槽（目录不存在/已空视为成功）
#[tauri::command(async)]
pub fn delete_reader_font(app: tauri::AppHandle) -> Result<(), String> {
    let fonts_dir = app_paths::library_dir(&app)?.join("fonts");
    if let Ok(entries) = fs::read_dir(&fonts_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("font.") && !name.ends_with(".part") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

// covers/{book_id}.* 单槽：保留 keep，删其它扩展名残留（best-effort；设置封面与重提取共用）
fn drop_stale_covers(covers_dir: &Path, book_id: &str, keep: &str) {
    if let Ok(entries) = fs::read_dir(covers_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&format!("{book_id}.")) && name.as_ref() != keep {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

pub(crate) fn thumbs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_paths::covers_dir(app)?.join("thumbs"))
}

// 缩略档宽（覆盖 120px 格 ×3DPR=360px 留余量）
pub(crate) const THUMB_WIDTH: u32 = 480;

// shortcut: image 0.25 的 webp 只有无损编码（有损需 libwebp C 库），
// 不透明封面按文档退路直接走 JPEG q80；带透明的图才用无损 webp（保 alpha）
fn encode_webp_lossless(img: &image::DynamicImage) -> Result<Vec<u8>, String> {
    let rgba = img.to_rgba8();
    let mut buf = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut buf)
        .write_image(rgba.as_raw(), rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("webp encode: {e}"))?;
    Ok(buf)
}

pub(crate) fn encode_jpeg(img: &image::DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let rgb = img.to_rgb8();
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
        .write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("jpeg encode: {e}"))?;
    Ok(buf)
}

/// 封面缩略档（A5）：covers/thumbs/{id}.{webp|jpg} 宽 480，只缩不放——原图宽 ≤480 或解码
/// 失败时跳过（前端回退原图路径）。best-effort：任何失败静默放弃，绝不影响主封面写入。
/// 扩展名与实际格式一致：不透明封面 JPEG q80（.jpg），带透明封面无损 webp（.webp），前端按扩展名推 mime。
// core takes thumbs_dir so tests can run against a tempdir instead of real appdata
pub(crate) fn gen_cover_thumb(thumbs_dir: &Path, book_id: &str, cover_abs: &Path) {
    let build = || -> Result<(), String> {
        let bytes = fs::read(cover_abs).map_err(|e| format!("failed to read cover: {e}"))?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("failed to decode cover: {e}"))?;
        if img.width() <= THUMB_WIDTH {
            return Ok(()); // 小图源不放大也不落盘
        }
        let resized = img.resize(THUMB_WIDTH, u32::MAX, image::imageops::FilterType::Lanczos3);
        let has_alpha = resized.color().has_alpha();
        // JPEG 无 alpha：带透明的图只走 webp，失败即放弃缩略图（前端回退原图）
        let (bytes, ext) = if has_alpha {
            (encode_webp_lossless(&resized)?, "webp")
        } else {
            (encode_jpeg(&resized, 80)?, "jpg")
        };
        fs::create_dir_all(thumbs_dir).map_err(|e| format!("failed to create thumbs dir: {e}"))?;
        let keep = format!("{book_id}.{ext}");
        let final_thumb = thumbs_dir.join(&keep);
        let tmp_thumb = thumbs_dir.join(format!("{keep}.part"));
        atomic_write_to(&tmp_thumb, &final_thumb, &bytes)?;
        drop_stale_covers(thumbs_dir, book_id, &keep);
        Ok(())
    };
    let _ = build();
}

// 已有缩略档即跳过（幂等闸；generate_cover_thumbs 与前端探测共用）
pub(crate) fn thumb_exists(thumbs_dir: &Path, book_id: &str) -> bool {
    thumbs_dir.join(format!("{book_id}.webp")).is_file() || thumbs_dir.join(format!("{book_id}.jpg")).is_file()
}

#[derive(Clone, serde::Serialize)]
struct CoverThumbsProgress {
    done: usize,
    total: usize,
}

/// 存量封面补生成缩略档：立即返回，后台线程遍历有封面的书逐本补（已有跳过），
/// 每本完成 emit "cover-thumbs-progress" {done,total}。setup 启动时自动触发一次。
#[tauri::command(async)]
pub fn generate_cover_thumbs(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    std::thread::spawn(move || {
        let conn = match db::open_db_bg(&handle) {
            Ok(c) => c,
            Err(_) => return,
        };
        let rows: Vec<(String, String)> = match conn
            .prepare("SELECT id, cover_path FROM books WHERE deleted_at IS NULL AND cover_path IS NOT NULL")
            .and_then(|mut stmt| {
                stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                    .map(|rows| rows.collect::<Result<Vec<_>, _>>())
            }) {
            Ok(Ok(v)) => v,
            _ => return,
        };
        let total = rows.len();
        let Ok(thumbs) = thumbs_dir(&handle) else { return };
        for (i, (book_id, rel)) in rows.iter().enumerate() {
            if !thumb_exists(&thumbs, book_id) {
                let abs = rel.replace('\\', "/");
                let abs = abs.strip_prefix("library/").map(|rest| app_paths::library_dir(&handle).ok().map(|root| root.join(rest)));
                if let Some(Some(abs)) = abs {
                    if abs.is_file() {
                        gen_cover_thumb(&thumbs, book_id, &abs);
                    }
                }
            }
            let _ = handle.emit("cover-thumbs-progress", CoverThumbsProgress { done: i + 1, total });
        }
    });
    Ok(())
}

// core takes covers_dir so tests can run against a tempdir instead of real appdata
fn store_book_cover(covers_dir: &Path, book_id: &str, source_path: &str) -> Result<String, String> {
    let ext = validate_image_file(source_path)?;
    fs::create_dir_all(covers_dir).map_err(|e| format!("failed to create covers dir: {e}"))?;
    let final_cover = covers_dir.join(format!("{book_id}.{ext}"));
    let tmp_cover = covers_dir.join(format!("{book_id}.{ext}.part"));
    atomic_copy_to(source_path, &tmp_cover, &final_cover)
        .map_err(|e| format!("failed to save cover: {e}"))?;
    // single slot per book: drop stale {book_id}.* of other extensions, best-effort
    let keep = format!("{book_id}.{ext}");
    drop_stale_covers(covers_dir, book_id, &keep);
    Ok(format!("library/covers/{keep}"))
}

#[tauri::command(async)]
pub fn set_book_cover(app: tauri::AppHandle, book_id: String, source_path: String) -> Result<String, String> {
    let conn = db::open_db(&app)?;
    // 仅确认书存在（uuid 为文件名，不存在即报错）；无封面书同样可设
    let _ = fetch_book_by_id(&conn, &book_id).map_err(|e| format!("failed to fetch book: {e}"))?;
    let cover_path = store_book_cover(&app_paths::covers_dir(&app)?, &book_id, &source_path)?;
    conn.execute("UPDATE books SET cover_path = ?2 WHERE id = ?1", params![book_id, cover_path])
        .map_err(|e| format!("failed to update book: {e}"))?;
    let thumbs = thumbs_dir(&app)?;
    let cover_name = cover_path.rsplit('/').next().unwrap_or(cover_path.as_str());
    gen_cover_thumb(&thumbs, &book_id, &app_paths::covers_dir(&app)?.join(cover_name));
    Ok(cover_path)
}

/// B13 存量书封面重提取：未软删且非 images 格式的书，读库内 epub 按 13a"选最大图"
/// 逻辑重提封面，原子覆盖 covers/{id}.{ext}（file_size 等其余字段不动）；
/// 库内文件缺失 / 解析失败 / 无合法封面的书跳过。返回成功更新的本数。
// core takes dirs so tests can run against a tempdir instead of real appdata
fn reextract_covers(conn: &Connection, books_dir: &Path, covers_dir: &Path) -> Result<usize, String> {
    let rows: Vec<(String, Option<String>)> = conn
        .prepare("SELECT id, cover_path FROM books WHERE deleted_at IS NULL AND (format IS NULL OR format != 'images')")
        .map_err(|e| format!("failed to list books: {e}"))?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| format!("failed to query books: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to read books: {e}"))?;

    fs::create_dir_all(covers_dir).map_err(|e| format!("failed to create covers dir: {e}"))?;
    let mut done = 0usize;
    for (book_id, old_cover) in rows {
        let book_abs = books_dir.join(format!("{book_id}.epub"));
        if !book_abs.is_file() {
            continue;
        }
        let Ok(meta) = epub::extract_epub_metadata(&book_abs) else { continue };
        let ext = meta
            .cover_ext
            .as_deref()
            .map(|s| s.trim().trim_start_matches('.').to_lowercase())
            .filter(|s| ["png", "jpg", "jpeg", "webp"].contains(&s.as_str()));
        let (Some(ext), Some(bytes)) = (ext, meta.cover_bytes.filter(|b| !b.is_empty())) else {
            continue;
        };
        let keep = format!("{book_id}.{ext}");
        let final_cover = covers_dir.join(&keep);
        let tmp_cover = covers_dir.join(format!("{keep}.part"));
        atomic_write_to(&tmp_cover, &final_cover, &bytes)
            .map_err(|e| format!("failed to write cover for {book_id}: {e}"))?;
        gen_cover_thumb(&covers_dir.join("thumbs"), &book_id, &final_cover);
        drop_stale_covers(covers_dir, &book_id, &keep);
        let cover_path = format!("library/covers/{keep}");
        if old_cover.as_deref() != Some(cover_path.as_str()) {
            conn.execute(
                "UPDATE books SET cover_path = ?2 WHERE id = ?1",
                params![book_id, cover_path],
            )
            .map_err(|e| format!("failed to update book {book_id}: {e}"))?;
        }
        done += 1;
    }
    Ok(done)
}

#[tauri::command(async)]
pub fn reextract_all_covers(app: tauri::AppHandle) -> Result<usize, String> {
    let conn = db::open_db(&app)?;
    reextract_covers(&conn, &app_paths::books_dir(&app)?, &app_paths::covers_dir(&app)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_fetch_books() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();

        let book = Book {
            id: "b1".to_string(),
            title: Some("t".to_string()),
            author: Some("a".to_string()),
            cover_path: None,
            library_path: "library/books/b1.epub".to_string(),
            added_at: 1,
            last_opened_at: None,
            note: None,
            pinned_at: None,
            format: None,
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
        };

        insert_book(&conn, &book).unwrap();
        conn.execute(
            "INSERT INTO reading_state (book_id, cfi, percent, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params!["b1", "cfi", 0.25f64, 1i64],
        )
        .unwrap();
        let books = fetch_books(&conn).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].id, "b1");
        assert_eq!(books[0].reading_percent, Some(0.25));

        conn.execute("UPDATE books SET format = 'images', page_count = 9 WHERE id = 'b1'", []).unwrap();
        let books = fetch_books(&conn).unwrap();
        assert_eq!(books[0].format.as_deref(), Some("images"));
        assert_eq!(books[0].page_count, Some(9));
    }

    #[test]
    fn delete_book_removes_row() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();

        let book = Book {
            id: "b2".to_string(),
            title: None,
            author: None,
            cover_path: Some("library/covers/b2.png".to_string()),
            library_path: "library/books/b2.epub".to_string(),
            added_at: 1,
            last_opened_at: None,
            note: None,
            pinned_at: None,
            format: None,
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
        };

        insert_book(&conn, &book).unwrap();
        conn.execute("DELETE FROM books WHERE id = ?1", ["b2"]).unwrap();
        let books = fetch_books(&conn).unwrap();
        assert!(books.is_empty());
    }

    #[test]
    fn merge_optional_text_prefers_update_when_non_empty() {
        assert_eq!(
            merge_optional_text(Some("New".to_string()), Some("Old".to_string())),
            Some("New".to_string())
        );
    }

    #[test]
    fn merge_optional_text_keeps_existing_when_update_none() {
        assert_eq!(merge_optional_text(None, Some("Old".to_string())), Some("Old".to_string()));
    }

    #[test]
    fn merge_optional_text_keeps_existing_when_update_blank() {
        assert_eq!(
            merge_optional_text(Some("   ".to_string()), Some("Old".to_string())),
            Some("Old".to_string())
        );
    }

    fn test_book(id: &str, added_at: i64) -> Book {
        Book {
            id: id.to_string(),
            title: Some("t".to_string()),
            author: None,
            cover_path: None,
            library_path: format!("library/books/{id}.epub"),
            added_at,
            last_opened_at: None,
            note: None,
            pinned_at: None,
            format: None,
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
    fn fetch_books_orders_pinned_first() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        insert_book(&conn, &test_book("b1", 1)).unwrap();
        insert_book(&conn, &test_book("b2", 2)).unwrap();

        let ids: Vec<String> = fetch_books(&conn).unwrap().into_iter().map(|b| b.id).collect();
        assert_eq!(ids, vec!["b2".to_string(), "b1".to_string()]);

        conn.execute("UPDATE books SET pinned_at = 100 WHERE id = 'b1'", []).unwrap();
        let ids: Vec<String> = fetch_books(&conn).unwrap().into_iter().map(|b| b.id).collect();
        assert_eq!(ids, vec!["b1".to_string(), "b2".to_string()]);
    }

    #[test]
    fn merge_metadata_keeps_existing_when_request_none() {
        let mut existing = test_book("b1", 1);
        existing.note = Some("备注".to_string());
        existing.pinned_at = Some(7);
        let req = UpdateBookMetadataRequest {
            book_id: "b1".to_string(),
            title: None,
            note: None,
            pinned: None,
            author: None,
            description: None,
        };
        let merged = merge_metadata(&existing, &req, 42);
        assert_eq!(merged.note, existing.note);
        assert_eq!(merged.pinned_at, existing.pinned_at);
    }

    #[test]
    fn merge_metadata_blank_request_clears_value() {
        let mut existing = test_book("b1", 1);
        existing.note = Some("旧备注".to_string());
        let req = UpdateBookMetadataRequest {
            book_id: "b1".to_string(),
            title: None,
            note: Some("   ".to_string()),
            pinned: None,
            author: None,
            description: None,
        };
        let merged = merge_metadata(&existing, &req, 42);
        assert_eq!(merged.note, None);
    }

    #[test]
    fn fetch_books_excludes_soft_deleted() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        insert_book(&conn, &test_book("b1", 1)).unwrap();
        insert_book(&conn, &test_book("b2", 2)).unwrap();
        conn.execute("UPDATE books SET deleted_at = 99 WHERE id = 'b2'", []).unwrap();

        let ids: Vec<String> = fetch_books(&conn).unwrap().into_iter().map(|b| b.id).collect();
        assert_eq!(ids, vec!["b1".to_string()]);
    }

    #[test]
    fn merge_metadata_pinned_sets_and_clears_timestamp() {
        let mut existing = test_book("b1", 1);
        existing.pinned_at = Some(7);
        let pin = UpdateBookMetadataRequest {
            book_id: "b1".to_string(),
            title: None,
            note: None,
            pinned: Some(true),
            author: None,
            description: None,
        };
        assert_eq!(merge_metadata(&existing, &pin, 42).pinned_at, Some(42));
        let unpin = UpdateBookMetadataRequest {
            book_id: "b1".to_string(),
            title: None,
            note: None,
            pinned: Some(false),
            author: None,
            description: None,
        };
        assert_eq!(merge_metadata(&existing, &unpin, 42).pinned_at, None);
    }

    #[test]
    fn validated_title_rejects_blank() {
        assert_eq!(
            validated_title(&Some("   ".to_string())),
            Err("标题不能为空".to_string())
        );
        assert_eq!(validated_title(&Some(String::new())), Err("标题不能为空".to_string()));
    }

    #[test]
    fn validated_title_trims_and_passes_none_through() {
        assert_eq!(validated_title(&Some(" 新书名 ".to_string())), Ok(Some("新书名".to_string())));
        assert_eq!(validated_title(&None), Ok(None));
    }

    #[test]
    fn merge_metadata_author_and_description_follow_note_semantics() {
        let mut existing = test_book("b1", 1);
        existing.author = Some("旧作者".to_string());
        existing.description = Some("旧简介".to_string());
        let update = UpdateBookMetadataRequest {
            book_id: "b1".to_string(),
            title: None,
            note: None,
            pinned: None,
            author: Some(" 新作者 ".to_string()),
            description: Some("新简介".to_string()),
        };
        let merged = merge_metadata(&existing, &update, 42);
        assert_eq!(merged.author.as_deref(), Some("新作者"));
        assert_eq!(merged.description.as_deref(), Some("新简介"));

        let clear = UpdateBookMetadataRequest {
            book_id: "b1".to_string(),
            title: None,
            note: None,
            pinned: None,
            author: Some("   ".to_string()),
            description: Some(String::new()),
        };
        let merged = merge_metadata(&existing, &clear, 42);
        assert_eq!(merged.author, None); // Some("") 清除
        assert_eq!(merged.description, None);

        let keep = UpdateBookMetadataRequest {
            book_id: "b1".to_string(),
            title: None,
            note: None,
            pinned: None,
            author: None,
            description: None,
        };
        let merged = merge_metadata(&existing, &keep, 42);
        assert_eq!(merged.author, existing.author); // None 不改
        assert_eq!(merged.description, existing.description);
    }

    #[test]
    fn merge_metadata_title_updates_when_provided() {
        let existing = test_book("b1", 1);
        let req = UpdateBookMetadataRequest {
            book_id: "b1".to_string(),
            title: Some("改名".to_string()),
            note: None,
            pinned: None,
            author: None,
            description: None,
        };
        assert_eq!(merge_metadata(&existing, &req, 42).title, Some("改名".to_string()));
    }

    #[test]
    fn merge_metadata_keeps_title_when_none() {
        let mut existing = test_book("b1", 1);
        existing.title = Some("原名".to_string());
        let req = UpdateBookMetadataRequest {
            book_id: "b1".to_string(),
            title: None,
            note: None,
            pinned: None,
            author: None,
            description: None,
        };
        assert_eq!(merge_metadata(&existing, &req, 42).title, Some("原名".to_string()));
    }

    fn temp_bg_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bookreading-bg-{tag}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reader_background_rejects_bad_extension() {
        let dir = temp_bg_dir("ext");
        let src = dir.join("bg.txt");
        fs::write(&src, b"x").unwrap();
        let err = store_reader_background(&dir, src.to_str().unwrap()).unwrap_err();
        assert_eq!(err, "不支持的图片格式，仅支持 PNG/JPG/WebP");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reader_background_rejects_oversize() {
        let dir = temp_bg_dir("size");
        let src = dir.join("big.png");
        fs::write(&src, vec![0u8; 8 * 1024 * 1024 + 1]).unwrap();
        let err = store_reader_background(&dir, src.to_str().unwrap()).unwrap_err();
        assert_eq!(err, "图片超过 8MB 限制");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reader_background_overwrites_single_slot() {
        let dir = temp_bg_dir("slot");
        let png = dir.join("in.png");
        fs::write(&png, b"png").unwrap();
        assert_eq!(store_reader_background(&dir, png.to_str().unwrap()).unwrap(), "bg.png");
        // uppercase extension must pass too, and replace the png slot
        let jpg = dir.join("in.JPG");
        fs::write(&jpg, b"jpeg").unwrap();
        assert_eq!(store_reader_background(&dir, jpg.to_str().unwrap()).unwrap(), "bg.jpg");
        assert_eq!(fs::read(dir.join("bg.jpg")).unwrap(), b"jpeg");
        assert!(!dir.join("bg.png").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reader_font_rejects_bad_extension_and_oversize() {
        let dir = temp_bg_dir("font-bad");
        let txt = dir.join("f.txt");
        fs::write(&txt, b"x").unwrap();
        assert_eq!(
            store_reader_font(&dir, txt.to_str().unwrap()).unwrap_err(),
            "不支持的字体格式，仅支持 TTF/OTF/WOFF2"
        );
        let big = dir.join("big.ttf");
        fs::write(&big, vec![0u8; 20 * 1024 * 1024 + 1]).unwrap();
        assert_eq!(store_reader_font(&dir, big.to_str().unwrap()).unwrap_err(), "字体文件超过 20MB 限制");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reader_font_overwrites_single_slot() {
        let dir = temp_bg_dir("font-slot");
        let ttf = dir.join("in.ttf");
        fs::write(&ttf, b"ttf").unwrap();
        assert_eq!(store_reader_font(&dir, ttf.to_str().unwrap()).unwrap(), "font.ttf");
        let woff2 = dir.join("in.woff2");
        fs::write(&woff2, b"woff").unwrap();
        assert_eq!(store_reader_font(&dir, woff2.to_str().unwrap()).unwrap(), "font.woff2");
        assert_eq!(fs::read(dir.join("font.woff2")).unwrap(), b"woff");
        assert!(!dir.join("font.ttf").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_book_cover_replaces_existing_and_cleans_stale_extensions() {
        let dir = temp_bg_dir("cover");
        // 已有其他扩展名的旧封面（残留）
        fs::write(dir.join("b9.webp"), b"old").unwrap();
        let png = dir.join("in.png");
        fs::write(&png, b"png").unwrap();
        assert_eq!(store_book_cover(&dir, "b9", png.to_str().unwrap()).unwrap(), "library/covers/b9.png");
        assert_eq!(fs::read(dir.join("b9.png")).unwrap(), b"png");
        assert!(!dir.join("b9.webp").exists());

        // 大写扩展名也过，且替换后清掉 png 槽位
        let jpg = dir.join("in.JPG");
        fs::write(&jpg, b"jpeg").unwrap();
        assert_eq!(store_book_cover(&dir, "b9", jpg.to_str().unwrap()).unwrap(), "library/covers/b9.jpg");
        assert_eq!(fs::read(dir.join("b9.jpg")).unwrap(), b"jpeg");
        assert!(!dir.join("b9.png").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_book_cover_rejects_bad_extension_and_oversize() {
        let dir = temp_bg_dir("cover-bad");
        let txt = dir.join("c.txt");
        fs::write(&txt, b"x").unwrap();
        assert_eq!(
            store_book_cover(&dir, "b1", txt.to_str().unwrap()).unwrap_err(),
            "不支持的图片格式，仅支持 PNG/JPG/WebP"
        );
        let big = dir.join("big.png");
        fs::write(&big, vec![0u8; 8 * 1024 * 1024 + 1]).unwrap();
        assert_eq!(store_book_cover(&dir, "b1", big.to_str().unwrap()).unwrap_err(), "图片超过 8MB 限制".to_string());
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- B13 存量封面重提取 ----

    fn png_head(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&[0u8; 9]);
        v
    }

    // 小 cover-image（元数据语义）+ 大普通图：extract_epub_metadata 按面积应选 big.png
    fn write_reextract_epub(path: &std::path::Path, small: &[u8], big: &[u8]) {
        use std::io::{Cursor, Write};
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("META-INF/container.xml", opts).unwrap();
            w.write_all(
                br#"<container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
            )
            .unwrap();
            w.start_file("content.opf", opts).unwrap();
            w.write_all(
                br#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c" href="cover.png" media-type="image/png" properties="cover-image"/><item id="b" href="big.png" media-type="image/png"/></manifest></package>"#,
            )
            .unwrap();
            w.start_file("cover.png", opts).unwrap();
            w.write_all(small).unwrap();
            w.start_file("big.png", opts).unwrap();
            w.write_all(big).unwrap();
            w.finish().unwrap();
        }
        fs::write(path, &buf).unwrap();
    }

    #[test]
    fn reextract_covers_picks_largest_image_skips_comics_and_missing_files() {
        let dir = temp_bg_dir("reextract");
        let books_dir = dir.join("books");
        let covers_dir = dir.join("covers");
        fs::create_dir_all(&books_dir).unwrap();
        fs::create_dir_all(&covers_dir).unwrap();

        let small = png_head(200, 300);
        let big = png_head(1200, 1800);
        // 存量书 b1：封面是小图（jpg），另有旧扩展残留 webp
        fs::write(covers_dir.join("b1.jpg"), &small).unwrap();
        fs::write(covers_dir.join("b1.webp"), b"stale").unwrap();
        write_reextract_epub(&books_dir.join("b1.epub"), &small, &big);

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA_SQL).unwrap();
        let mut b1 = test_book("b1", 1);
        b1.cover_path = Some("library/covers/b1.jpg".to_string());
        insert_book(&conn, &b1).unwrap();
        // b2 images 格式（漫画封面另有逻辑）、b3 库内文件缺失：都应跳过
        let mut b2 = test_book("b2", 2);
        b2.format = Some("images".to_string());
        insert_book(&conn, &b2).unwrap();
        insert_book(&conn, &test_book("b3", 3)).unwrap();

        assert_eq!(reextract_covers(&conn, &books_dir, &covers_dir).unwrap(), 1);
        // 封面换成大图字节，旧扩展残留清除，DB cover_path 同步
        assert_eq!(fs::read(covers_dir.join("b1.png")).unwrap(), big);
        assert!(!covers_dir.join("b1.jpg").exists());
        assert!(!covers_dir.join("b1.webp").exists());
        let updated = fetch_book_by_id(&conn, "b1").unwrap();
        assert_eq!(updated.cover_path.as_deref(), Some("library/covers/b1.png"));
        assert_eq!(updated.title, b1.title);
        assert_eq!(updated.file_size, b1.file_size);

        let _ = fs::remove_dir_all(&dir);
    }

    // ---- A5 封面缩略档 ----

    fn write_test_cover(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
        let path = dir.join(name);
        image::RgbImage::from_pixel(w, h, image::Rgb([200u8, 30, 30]))
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();
        path
    }

    #[test]
    fn cover_thumb_shrinks_big_covers_and_skips_small() {
        let dir = temp_bg_dir("thumb");
        let thumbs = dir.join("thumbs");
        let big = write_test_cover(&dir, "big.png", 1200, 1800);

        gen_cover_thumb(&thumbs, "b1", &big);
        let thumb = thumbs.join("b1.jpg"); // 不透明 → JPEG 退路 + .jpg 扩展名
        assert!(thumb.is_file(), "thumb missing");
        let decoded = image::ImageReader::open(&thumb).unwrap().decode().unwrap();
        assert_eq!(decoded.width(), THUMB_WIDTH);
        assert_eq!(decoded.height(), 720); // 等比：1200x1800 → 480x720
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cover_thumb_never_upscales_small_covers() {
        let dir = temp_bg_dir("thumb-small");
        let thumbs = dir.join("thumbs");
        let small = write_test_cover(&dir, "s.png", 200, 300);

        gen_cover_thumb(&thumbs, "b2", &small);
        assert!(!thumbs.join("b2.jpg").exists());
        assert!(!thumbs.join("b2.webp").exists()); // 小图不放大也不落盘
        let _ = fs::remove_dir_all(&dir);
    }
}
