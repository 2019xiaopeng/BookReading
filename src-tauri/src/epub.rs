use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use roxmltree::Document;
use zip::ZipArchive;

const MAX_CONTAINER_XML_BYTES: u64 = 1_000_000;
const MAX_OPF_XML_BYTES: u64 = 4_000_000;
const MAX_COVER_BYTES: u64 = 8_000_000;
// B13 封面选最大图：候选数上限与单候选文件头读取量（尺寸头在前 64KB 内）
const MAX_COVER_CANDIDATES: usize = 8;
const MAX_COVER_HEADER_BYTES: u64 = 64 * 1024;
// 尺寸合理性上限（1e12 px²）：超出视为损坏头
const MAX_IMAGE_AREA: u64 = 1_000_000_000_000;

/// 实际限量读取：超过 max_bytes 即报错。只对照 zip 头里声明的大小不够——声明可伪造，
/// 而 zip 解压器对输出不设上限（伪造的小尺寸能让实际输出放大上千倍）
pub(crate) fn read_limited<R: Read>(r: &mut R, max_bytes: u64) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    r.take(max_bytes + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > max_bytes {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "zip entry too large"));
    }
    Ok(buf)
}

/// 入库校验：是读得开的 zip，且里面有 container.xml——这才是 EPUB 的最低门槛
/// （只验 zip 的话，改名成 .epub 的 docx / cbz 同样能入库，打开才报错）
pub fn validate_zip(path: &Path) -> Result<(), String> {
    let f = File::open(path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    let mut zip = ZipArchive::new(BufReader::new(f))
        .map_err(|_| "不是有效的 EPUB 文件（不是合法的 zip 压缩包）".to_string())?;
    let has_container =
        zip.by_name("META-INF/container.xml").is_ok() || zip.by_name("meta-inf/container.xml").is_ok();
    if !has_container {
        return Err("不是有效的 EPUB 文件（压缩包里没有 META-INF/container.xml）".to_string());
    }
    Ok(())
}

fn read_zip_text_limited<R: Read + std::io::Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
    max_bytes: u64,
) -> Result<String, String> {
    let mut f = zip.by_name(name).map_err(|e| format!("zip missing {name}: {e}"))?;
    if f.size() > max_bytes {
        return Err(format!("zip entry too large: {name}"));
    }
    let bytes = read_limited(&mut f, max_bytes).map_err(|e| format!("failed to read {name}: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("invalid utf-8 in {name}: {e}"))
}

fn read_zip_bytes_limited<R: Read + std::io::Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let mut f = zip.by_name(name).map_err(|e| format!("zip missing {name}: {e}"))?;
    if f.size() > max_bytes {
        return Err(format!("zip entry too large: {name}"));
    }
    read_limited(&mut f, max_bytes).map_err(|e| format!("failed to read {name}: {e}"))
}

/// 读 zip entry 前 max_bytes 字节（解析图片头用；entry 超大也只读头部）
fn read_zip_head_limited<R: Read + std::io::Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
    max_bytes: u64,
) -> Option<Vec<u8>> {
    let f = zip.by_name(name).ok()?;
    let mut buf = Vec::new();
    let _ = f.take(max_bytes).read_to_end(&mut buf);
    Some(buf)
}

/// 手写 PNG(IHDR)/JPEG(SOF0-2 等) 宽高解析（B13 封面选最大图；不引第三方图片库）。
/// 调用方传文件头（zip entry 前 64KB）；其余格式/损坏数据返回 None。
fn image_dimensions(head: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if head.len() >= 24 && head[..8] == PNG_SIG {
        // IHDR 数据段固定在 16..24（签名 8 + 长度 4 + "IHDR" 4），宽高各 4 字节大端
        let w = u32::from_be_bytes(head[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(head[20..24].try_into().ok()?);
        return (w > 0 && h > 0).then_some((w, h));
    }
    if head.len() >= 4 && head[0] == 0xff && head[1] == 0xd8 {
        let mut i = 2usize;
        while i + 1 < head.len() {
            if head[i] != 0xff {
                i += 1; // 跳到下一个 0xff（容忍段间填充字节）
                continue;
            }
            let marker = head[i + 1];
            if marker == 0x00 || marker == 0xff {
                i += 1;
                continue;
            }
            if (0xd0..=0xd9).contains(&marker) {
                i += 2; // RSTn/SOI/EOI：无长度段
                continue;
            }
            if i + 4 > head.len() {
                return None;
            }
            let seg_len = u16::from_be_bytes([head[i + 2], head[i + 3]]) as usize;
            if seg_len < 2 {
                return None;
            }
            // SOF0..SOF15（除 DHT C4 / JPG C8 / DAC CC）含尺寸：高在段数据 +3..+5、宽 +5..+7（含 2 字节长度）
            if (0xc0..=0xcf).contains(&marker) && marker != 0xc4 && marker != 0xc8 && marker != 0xcc {
                if i + 9 >= head.len() {
                    return None;
                }
                let h = u16::from_be_bytes([head[i + 5], head[i + 6]]) as u32;
                let w = u16::from_be_bytes([head[i + 7], head[i + 8]]) as u32;
                return (w > 0 && h > 0).then_some((w, h));
            }
            if marker == 0xda {
                return None; // 已到扫描数据仍未见 SOF：无效或头 64KB 不含尺寸
            }
            i += 2 + seg_len;
        }
    }
    None
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

/// 收集封面候选（B13）：按优先级依次为 meta name=cover → item properties~cover-image →
/// id/href 含 cover 的全部 image → manifest 顺序的全部 image，去重后 ≤ MAX_COVER_CANDIDATES 个；
/// 第二个返回值为"元数据语义封面"（meta/properties）在候选中的序号。
fn find_cover_candidates(doc: &Document) -> (Vec<(String, Option<String>)>, Option<usize>) {
    fn push(
        out: &mut Vec<(String, Option<String>)>,
        href: Option<String>,
        media: Option<String>,
    ) -> Option<usize> {
        let href = href?;
        if out.iter().any(|(h, _)| h.eq_ignore_ascii_case(&href)) {
            return None;
        }
        out.push((href, media));
        Some(out.len() - 1)
    }
    let item_of = |n: roxmltree::Node| -> Option<(String, Option<String>)> {
        Some((
            n.attribute("href")?.to_string(),
            n.attribute("media-type").map(|s| s.to_string()),
        ))
    };
    let is_item = |n: &roxmltree::Node| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("item");
    let is_image = |n: &roxmltree::Node| match n.attribute("media-type") {
        Some(m) => m.to_lowercase().starts_with("image/"),
        // 不合规但存在：清单条目没写 media-type——按 href 的扩展名认，否则这类书的封面会丢
        None => cover_ext(n.attribute("href").unwrap_or(""), None).is_some(),
    };

    let mut out: Vec<(String, Option<String>)> = Vec::new();
    let mut meta_pref: Option<usize> = None;

    // 1) meta name=cover → item@id（或 href==id 兜底）。EPUB 2 的 meta cover 常指向「封面页」xhtml——
    //    那不是图：跳过它，让后面的图片候选接管（原先把 xhtml 当封面读出来，扩展名过不了白名单，整本没封面）
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
        let found = doc
            .descendants()
            .find(|n| is_item(n) && is_image(n) && n.attribute("id").is_some_and(|v| v == id))
            .and_then(item_of)
            .or_else(|| {
                doc.descendants()
                    .find(|n| {
                        is_item(n)
                            && is_image(n)
                            && (n.attribute("href").unwrap_or("") == id
                                || n.attribute("href")
                                    .unwrap_or("")
                                    .to_lowercase()
                                    .ends_with(&format!("/{}", id.to_lowercase())))
                    })
                    .and_then(item_of)
            });
        if let Some((href, media)) = found {
            meta_pref = push(&mut out, Some(href), media);
        }
    }

    // 2) properties 含 cover-image
    if meta_pref.is_none() {
        let found = doc
            .descendants()
            .find(|n| {
                is_item(n)
                    && is_image(n)
                    && n.attribute("properties")
                        .is_some_and(|p| p.split_whitespace().any(|v| v.eq_ignore_ascii_case("cover-image")))
            })
            .and_then(item_of);
        if let Some((href, media)) = found {
            meta_pref = push(&mut out, Some(href), media);
        }
    }

    // 3) id/href 含 cover 的全部 image；4) manifest 顺序的全部 image（"书内更大图"常在正文图里，
    //    只取首个会漏掉；候选 ≤8 控制头部读取量）
    for n in doc.descendants().filter(|n| {
        is_item(n)
            && is_image(n)
            && (n.attribute("id").unwrap_or("").to_lowercase().contains("cover")
                || n.attribute("href").unwrap_or("").to_lowercase().contains("cover"))
    }) {
        if let Some((href, media)) = item_of(n) {
            push(&mut out, Some(href), media);
        }
    }
    for n in doc.descendants().filter(|n| is_item(n) && is_image(n)) {
        if let Some((href, media)) = item_of(n) {
            push(&mut out, Some(href), media);
        }
    }

    out.truncate(MAX_COVER_CANDIDATES);
    (out, meta_pref)
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

/// 封面文件扩展名：优先 href 的扩展名，其次 media-type；None = 前端显示不了的类型（svg / gif 等，
/// 与 library.rs 入库时的白名单同一份口径）
fn cover_ext(href: &str, media_type: Option<&str>) -> Option<String> {
    let ext = Path::new(href)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .or_else(|| media_type.and_then(ext_from_media_type).map(|s| s.to_string()))?;
    (["png", "jpg", "jpeg", "webp"].contains(&ext.as_str())).then_some(ext)
}

/// href 里的 %XX 还原（EPUB 的 href 允许百分号编码，zip 条目名存的是还原后的名字）；
/// 没有百分号或不是合法编码 / UTF-8 时返回 None
fn percent_decoded(s: &str) -> Option<String> {
    if !s.contains('%') {
        return None;
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16)?;
            let lo = (b[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn normalize_zip_path(base: &Path, href: &str) -> Option<PathBuf> {
    let mut out = PathBuf::from(base);
    for c in Path::new(&href.replace('\\', "/")).components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(p) => out.push(p),
            std::path::Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(out)
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

    let container_xml = read_zip_text_limited(&mut zip, "META-INF/container.xml", MAX_CONTAINER_XML_BYTES)
        .or_else(|_| read_zip_text_limited(&mut zip, "meta-inf/container.xml", MAX_CONTAINER_XML_BYTES))?;
    let rootfile = find_rootfile_path(&container_xml)?;
    let opf_xml = read_zip_text_limited(&mut zip, &rootfile, MAX_OPF_XML_BYTES)?;

    let doc = Document::parse(&opf_xml).map_err(|e| format!("invalid opf: {e}"))?;
    let title = first_dc_text(&doc, "title");
    let author = first_dc_text(&doc, "creator");

    let opf_dir = PathBuf::from(&rootfile).parent().map(|p| p.to_path_buf()).unwrap_or_default();

    // B13 封面选最大图：EPUB cover 元数据常指向小图而书内有更大图（两轮"封面糊"反馈根因）。
    // 各候选读 zip entry 前 64KB 解析 PNG/JPEG 头得面积，取面积最大者；元数据封面（meta/cover-image）
    // 仅在其面积 ≥ 最大图 60% 时优先（保元数据语义又防小图）；全都解析失败时回退优先级第一个候选。
    let (candidates, meta_pref) = find_cover_candidates(&doc);
    // 候选在 zip 里的条目名：先按 href 原样，再按还原百分号编码后的（EPUB 两种做法都有）
    let cover_names = |href: &str| -> Vec<String> {
        let to_name = |h: &str| {
            normalize_zip_path(&opf_dir, h)
                .map(|p| p.to_string_lossy().to_string().replace('\\', "/"))
        };
        let mut names: Vec<String> = to_name(href).into_iter().collect();
        if let Some(d) = percent_decoded(href).and_then(|h| to_name(&h)) {
            if !names.contains(&d) {
                names.push(d);
            }
        }
        names
    };
    let mut areas: Vec<Option<u64>> = Vec::with_capacity(candidates.len());
    let mut best: Option<(usize, u64)> = None;
    for (i, (href, _media)) in candidates.iter().enumerate() {
        let head = cover_names(href)
            .into_iter()
            .find_map(|name| read_zip_head_limited(&mut zip, &name, MAX_COVER_HEADER_BYTES))
            .unwrap_or_default();
        let area = image_dimensions(&head)
            .map(|(w, h)| (w as u64) * (h as u64))
            .filter(|&a| a <= MAX_IMAGE_AREA);
        areas.push(area);
        if let Some(a) = area {
            if best.map_or(true, |(_, ba)| a > ba) {
                best = Some((i, a));
            }
        }
    }
    let pick = match (best, meta_pref) {
        (Some((bi, ba)), Some(mi)) if mi == bi || areas[mi].is_some_and(|a| a * 10 >= ba * 6) => Some(mi),
        (Some((bi, _)), _) => Some(bi),
        // 全部解析失败（webp/无图/损坏）：维持既有启发式——优先级第一个候选，
        // 但跳过前端显示不了的类型（svg / gif）——轮到它当第一个，整本就没封面了
        (None, _) => candidates
            .iter()
            .position(|(href, media)| cover_ext(href, media.as_deref()).is_some())
            .or_else(|| (0..candidates.len()).next()),
    };

    let (cover_bytes, cover_ext) = match pick.and_then(|i| candidates.get(i)) {
        Some((href, media_type)) => {
            let bytes = cover_names(href)
                .into_iter()
                .find_map(|name| read_zip_bytes_limited(&mut zip, &name, MAX_COVER_BYTES).ok());
            (bytes, cover_ext(href, media_type.as_deref()))
        }
        None => (None, None),
    };

    Ok(EpubMetadata {
        title,
        author,
        cover_bytes,
        cover_ext,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_EPUB_SEQ: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn cover_fallback_matches_image_item_with_cover_in_id() {
        let opf = r#"
        <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>t</dc:title>
          </metadata>
          <manifest>
            <item id="cover-image" href="Images/cover.jpg" media-type="image/jpeg" />
          </manifest>
        </package>
        "#;
        let doc = Document::parse(opf).unwrap();
        let (candidates, _meta) = find_cover_candidates(&doc);
        let (href, media) = &candidates[0];
        assert_eq!(href, "Images/cover.jpg");
        assert_eq!(media.as_deref(), Some("image/jpeg"));
    }

    #[test]
    fn cover_fallback_matches_image_item_with_cover_in_href() {
        let opf = r#"
        <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
          <manifest>
            <item id="img1" href="cover.png" media-type="image/png" />
          </manifest>
        </package>
        "#;
        let doc = Document::parse(opf).unwrap();
        let (candidates, _meta) = find_cover_candidates(&doc);
        let (href, media) = &candidates[0];
        assert_eq!(href, "cover.png");
        assert_eq!(media.as_deref(), Some("image/png"));
    }

    #[test]
    fn cover_fallback_uses_first_manifest_image_when_no_markers() {
        let opf = r#"
        <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
          <manifest>
            <item id="img1" href="Images/0001.jpg" media-type="image/jpeg" />
            <item id="img2" href="Images/0002.jpg" media-type="image/jpeg" />
          </manifest>
        </package>
        "#;
        let doc = Document::parse(opf).unwrap();
        let (candidates, _meta) = find_cover_candidates(&doc);
        let (href, media) = &candidates[0];
        assert_eq!(href, "Images/0001.jpg");
        assert_eq!(media.as_deref(), Some("image/jpeg"));
    }

    #[test]
    fn meta_cover_item_is_preferred_candidate() {
        let opf = r#"
        <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
          <metadata>
            <meta name="cover" content="c1" />
          </metadata>
          <manifest>
            <item id="c1" href="images/small.png" media-type="image/png" />
            <item id="big" href="images/big.png" media-type="image/png" />
          </manifest>
        </package>
        "#;
        let doc = Document::parse(opf).unwrap();
        let (candidates, meta_pref) = find_cover_candidates(&doc);
        assert_eq!(meta_pref, Some(0));
        assert_eq!(candidates[0].0, "images/small.png");
        // 含 cover 提示与首个 image 已并入候选（去重后共 2 项）
        assert_eq!(candidates.len(), 2);
    }

    // ---- B13 手写图片头解析 ----

    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        v.extend_from_slice(&13u32.to_be_bytes()); // IHDR 长度
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&[0u8; 9]); // 位深/颜色类型等 + 假 CRC（解析不校验）
        v
    }

    fn jpeg_bytes(sof_marker: u8, w: u16, h: u16) -> Vec<u8> {
        let mut v = vec![0xff, 0xd8];
        // APP0 段：验证普通段跳过
        v.extend_from_slice(&[0xff, 0xe0, 0x00, 0x10]);
        v.extend_from_slice(&[0u8; 14]);
        // SOFn 段：长度 17（含自身 2 字节），precision 1 + 高 2 + 宽 2 + 分量数 1 + ...
        v.push(0xff);
        v.push(sof_marker);
        v.extend_from_slice(&17u16.to_be_bytes());
        v.push(0x08);
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&w.to_be_bytes());
        v.push(0x03);
        v.extend_from_slice(&[0u8; 9]); // 分量数据（解析不读）
        v
    }

    #[test]
    fn image_dimensions_parses_png_jpeg_baseline_and_progressive() {
        assert_eq!(image_dimensions(&png_bytes(640, 1024)), Some((640, 1024)));
        assert_eq!(image_dimensions(&jpeg_bytes(0xc0, 1200, 800)), Some((1200, 800))); // SOF0 基线
        assert_eq!(image_dimensions(&jpeg_bytes(0xc2, 300, 500)), Some((300, 500))); // SOF2 渐进
    }

    #[test]
    fn image_dimensions_rejects_non_images_and_truncated_heads() {
        assert_eq!(image_dimensions(b"<html>not an image</html>"), None);
        assert_eq!(image_dimensions(&[0x89, b'P', b'N', b'G', 0x0d]), None); // PNG 签名截断
        assert_eq!(image_dimensions(&[]), None);
        assert_eq!(image_dimensions(&[0xff, 0xd8, 0xff]), None); // JPEG 头截断
        assert_eq!(image_dimensions(&png_bytes(0, 100)), None); // 零宽无效
    }

    // ---- R4：实际限量读取 / 入库校验 ----

    #[test]
    fn read_limited_counts_real_bytes() {
        assert_eq!(read_limited(&mut Cursor::new(b"abc".to_vec()), 3).unwrap(), b"abc");
        assert!(read_limited(&mut Cursor::new(b"abcd".to_vec()), 3).is_err());
        assert!(read_limited(&mut Cursor::new(Vec::<u8>::new()), 0).unwrap().is_empty());
    }

    // 改名成 .epub 的普通文件、被截断的 zip、别的 zip 格式（docx 之类）都过不了入库校验
    #[test]
    fn validate_zip_rejects_plain_and_truncated_files() {
        let dir = std::env::temp_dir().join(format!("bookreading-zipval-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("plain.epub");
        std::fs::write(&plain, b"just some text, not a zip").unwrap();
        assert!(validate_zip(&plain).unwrap_err().contains("EPUB"));

        let good = write_test_epub(&[("cover-item", "cover.png")], &[("cover.png", png_bytes(20, 30))]);
        assert!(validate_zip(&good).is_ok());
        let bytes = std::fs::read(&good).unwrap();
        let truncated = dir.join("cut.epub");
        std::fs::write(&truncated, &bytes[..bytes.len() / 2]).unwrap();
        assert!(validate_zip(&truncated).is_err());

        // 合法 zip 但不是 EPUB（没有 container.xml）
        let other = dir.join("docx.epub");
        {
            let mut w = zip::ZipWriter::new(File::create(&other).unwrap());
            w.start_file("word/document.xml", zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(b"<w/>").unwrap();
            w.finish().unwrap();
        }
        assert!(validate_zip(&other).unwrap_err().contains("container.xml"));

        let _ = std::fs::remove_file(&good);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- R5：封面丢失的三种情形 ----

    // EPUB 2 的 meta cover 指向封面页 xhtml：不当封面，落到后面的图片候选
    #[test]
    fn cover_meta_pointing_at_xhtml_cover_page_falls_back_to_images() {
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>t</dc:title>
            <meta name="cover" content="cover-page"/></metadata>
          <manifest>
            <item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml" />
            <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" />
          </manifest></package>"#;
        let doc = Document::parse(opf).unwrap();
        let (candidates, meta) = find_cover_candidates(&doc);
        assert_eq!(meta, None, "xhtml 封面页不该成为元数据封面");
        assert_eq!(candidates[0].0, "images/cover.jpg");
    }

    // 候选尺寸全都解析不了时，回退到第一个前端显示得了的类型（跳过 svg）
    #[test]
    fn cover_fallback_prefers_displayable_type_when_nothing_parses() {
        let path = write_test_epub(
            &[("x1", "a.svg"), ("x2", "b.webp")],
            &[("a.svg", b"<svg/>".to_vec()), ("b.webp", b"RIFF-webp".to_vec())],
        );
        let meta = extract_epub_metadata(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(meta.cover_ext.as_deref(), Some("webp"));
        assert_eq!(meta.cover_bytes.as_deref(), Some(b"RIFF-webp".as_slice()));
    }

    // href 带百分号编码、zip 条目名是还原后的名字
    #[test]
    fn cover_resolves_percent_encoded_href() {
        let path = write_test_epub(&[("cover-item", "my%20cover.png")], &[("my cover.png", png_bytes(40, 60))]);
        let meta = extract_epub_metadata(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let bytes = meta.cover_bytes.expect("cover bytes");
        assert_eq!(image_dimensions(&bytes), Some((40, 60)));
        assert_eq!(percent_decoded("a%2Fb%zz"), None, "非法编码不算解码");
        assert_eq!(percent_decoded("plain.png"), None);
    }

    // 清单条目没写 media-type（不合规但存在）：按 href 扩展名认图片，封面不能因此丢
    #[test]
    fn cover_item_without_media_type_still_counts_as_image() {
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>t</dc:title>
            <meta name="cover" content="img1"/></metadata>
          <manifest>
            <item id="img1" href="images/cover.jpg" />
            <item id="c1" href="text/ch1.xhtml" />
          </manifest></package>"#;
        let doc = Document::parse(opf).unwrap();
        let (candidates, meta) = find_cover_candidates(&doc);
        assert_eq!(meta, Some(0));
        assert_eq!(candidates[0].0, "images/cover.jpg");
    }

    // ---- B13 封面选最大图（zip 集成）----

    fn write_test_epub(manifest_items: &[(&str, &str)], files: &[(&str, Vec<u8>)]) -> std::path::PathBuf {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("META-INF/container.xml", opts).unwrap();
            w.write_all(
                br#"<container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
            )
            .unwrap();
            let mut opf = String::from(
                r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">t</dc:title></metadata><manifest>"#,
            );
            for (id, href) in manifest_items {
                opf.push_str(&format!(
                    r#"<item id="{id}" href="{href}" media-type="image/png" properties="{}" />"#,
                    if *id == "cover-item" { "cover-image" } else { "" }
                ));
            }
            opf.push_str("</manifest></package>");
            w.start_file("content.opf", opts).unwrap();
            w.write_all(opf.as_bytes()).unwrap();
            for (name, bytes) in files {
                w.start_file(*name, opts).unwrap();
                w.write_all(bytes).unwrap();
            }
            w.finish().unwrap();
        }
        let path = std::env::temp_dir().join(format!(
            "bookreading-test-{}-{}.epub",
            std::process::id(),
            TEST_EPUB_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, &buf).unwrap();
        path
    }

    #[test]
    fn cover_picks_largest_image_over_small_meta_cover() {
        // 小 cover（元数据标注）+ 大普通图 → 取大图
        let path = write_test_epub(
            &[("cover-item", "cover.png"), ("big", "big.png")],
            &[
                ("cover.png", png_bytes(200, 300)),
                ("big.png", png_bytes(1200, 1800)),
            ],
        );
        let meta = extract_epub_metadata(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let bytes = meta.cover_bytes.expect("cover bytes");
        assert_eq!(image_dimensions(&bytes), Some((1200, 1800)));
        assert_eq!(meta.cover_ext.as_deref(), Some("png"));
    }

    #[test]
    fn cover_prefers_meta_cover_when_at_least_60_percent_of_largest() {
        // 元数据封面 1000x1600，最大图 1200x1800：面积比 ≈0.74 ≥ 0.6 → 保元数据语义
        let path = write_test_epub(
            &[("cover-item", "cover.png"), ("big", "big.png")],
            &[
                ("cover.png", png_bytes(1000, 1600)),
                ("big.png", png_bytes(1200, 1800)),
            ],
        );
        let meta = extract_epub_metadata(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let bytes = meta.cover_bytes.expect("cover bytes");
        assert_eq!(image_dimensions(&bytes), Some((1000, 1600)));
    }

    #[test]
    fn cover_falls_back_to_first_candidate_when_dimensions_unparsable() {
        // 全候选解析失败（非图片字节）→ 维持既有启发式：优先级第一个（cover-image 属性项）
        let path = write_test_epub(
            &[("cover-item", "cover.png"), ("junk", "junk.png")],
            &[
                ("cover.png", b"not-a-real-image".to_vec()),
                ("junk.png", b"neither-is-this".to_vec()),
            ],
        );
        let meta = extract_epub_metadata(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(meta.cover_bytes.is_some()); // 字节原样返回，尺寸交给前端解码
    }
}
