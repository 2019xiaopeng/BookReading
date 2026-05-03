use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use roxmltree::Document;
use zip::ZipArchive;

fn read_zip_text<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, name: &str) -> Result<String, String> {
    let mut f = zip.by_name(name).map_err(|e| format!("zip missing {name}: {e}"))?;
    let mut s = String::new();
    f.read_to_string(&mut s).map_err(|e| format!("failed to read {name}: {e}"))?;
    Ok(s)
}

fn read_zip_bytes<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, name: &str) -> Result<Vec<u8>, String> {
    let mut f = zip.by_name(name).map_err(|e| format!("zip missing {name}: {e}"))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| format!("failed to read {name}: {e}"))?;
    Ok(buf)
}

fn find_rootfile_path(container_xml: &str) -> Result<String, String> {
    let doc = Document::parse(container_xml).map_err(|e| format!("invalid container.xml: {e}"))?;
    let rootfile = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("rootfile"))
        .ok_or_else(|| "container.xml missing rootfile".to_string())?;
    let full_path = rootfile
        .attribute("full-path")
        .ok_or_else(|| "container.xml rootfile missing full-path".to_string())?;
    Ok(full_path.to_string())
}

fn first_dc_text(doc: &Document, local: &str) -> Option<String> {
    doc.descendants()
        .find(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case(local))
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn find_cover_href(doc: &Document) -> Option<(String, Option<String>)> {
    let cover_id = doc.descendants().find_map(|n| {
        if !n.is_element() || !n.tag_name().name().eq_ignore_ascii_case("meta") {
            return None;
        }
        let name = n.attribute("name")?;
        if name.eq_ignore_ascii_case("cover") {
            return n.attribute("content").map(|s| s.to_string());
        }
        None
    });

    if let Some(id) = cover_id {
        let item = doc.descendants().find(|n| {
            n.is_element()
                && n.tag_name().name().eq_ignore_ascii_case("item")
                && n.attribute("id").is_some_and(|v| v == id)
        });
        if let Some(item) = item {
            let href = item.attribute("href").map(|s| s.to_string())?;
            let media_type = item.attribute("media-type").map(|s| s.to_string());
            return Some((href, media_type));
        }
    }

    let cover_item = doc.descendants().find(|n| {
        if !n.is_element() || !n.tag_name().name().eq_ignore_ascii_case("item") {
            return false;
        }
        n.attribute("properties")
            .is_some_and(|p| p.split_whitespace().any(|v| v.eq_ignore_ascii_case("cover-image")))
    });
    if let Some(item) = cover_item {
        let href = item.attribute("href").map(|s| s.to_string())?;
        let media_type = item.attribute("media-type").map(|s| s.to_string());
        return Some((href, media_type));
    }

    None
}

fn ext_from_media_type(media_type: &str) -> Option<&'static str> {
    let m = media_type.to_lowercase();
    if m.contains("png") {
        return Some("png");
    }
    if m.contains("jpeg") {
        return Some("jpeg");
    }
    if m.contains("jpg") {
        return Some("jpg");
    }
    if m.contains("webp") {
        return Some("webp");
    }
    None
}

pub struct EpubMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub cover_bytes: Option<Vec<u8>>,
    pub cover_ext: Option<String>,
}

pub fn extract_epub_metadata(epub_path: &Path) -> Result<EpubMetadata, String> {
    let file = File::open(epub_path).map_err(|e| format!("failed to open epub: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("invalid zip: {e}"))?;

    let container_xml = read_zip_text(&mut zip, "META-INF/container.xml")
        .or_else(|_| read_zip_text(&mut zip, "meta-inf/container.xml"))?;
    let rootfile = find_rootfile_path(&container_xml)?;
    let opf_xml = read_zip_text(&mut zip, &rootfile)?;

    let doc = Document::parse(&opf_xml).map_err(|e| format!("invalid opf: {e}"))?;
    let title = first_dc_text(&doc, "title");
    let author = first_dc_text(&doc, "creator");

    let opf_dir = PathBuf::from(&rootfile).parent().map(|p| p.to_path_buf()).unwrap_or_default();

    let (cover_bytes, cover_ext) = if let Some((href, media_type)) = find_cover_href(&doc) {
        let cover_path = opf_dir.join(href.replace('\\', "/"));
        let cover_name = cover_path.to_string_lossy().to_string();
        let bytes = read_zip_bytes(&mut zip, &cover_name).ok();
        let ext = cover_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .or_else(|| media_type.as_deref().and_then(ext_from_media_type).map(|s| s.to_string()));
        (bytes, ext)
    } else {
        (None, None)
    };

    Ok(EpubMetadata {
        title,
        author,
        cover_bytes,
        cover_ext,
    })
}

