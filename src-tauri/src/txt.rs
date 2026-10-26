use std::io::{Seek, Write};
use std::sync::OnceLock;

// shortcut: EPUB output and tests below are statically reviewed only (builds forbidden); verify epub.js opens a generated book on first real TXT import.

use regex::Regex;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

const DECODE_ERR: &str = "TXT 解码失败：仅支持 UTF-8 / GBK(GB18030) 编码";
const FALLBACK_CHAPTER_CHARS: usize = 10_240;
const MAX_CHAPTER_CHARS: usize = 100_000;

const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#;

pub fn decode_txt(bytes: &[u8]) -> Result<String, String> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]) {
        return std::str::from_utf8(rest)
            .map(|s| s.to_string())
            .map_err(|_| DECODE_ERR.to_string());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, had_errors) = encoding_rs::UTF_16LE.decode_with_bom_removal(bytes);
        return if had_errors {
            Err(DECODE_ERR.to_string())
        } else {
            Ok(text.into_owned())
        };
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, had_errors) = encoding_rs::UTF_16BE.decode_with_bom_removal(bytes);
        return if had_errors {
            Err(DECODE_ERR.to_string())
        } else {
            Ok(text.into_owned())
        };
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(text.to_string());
    }
    // WHATWG "gbk" label is the gb18030 decoder, a superset of GBK
    let (text, _, had_errors) = encoding_rs::GBK.decode_with_bom_removal(bytes);
    if had_errors {
        Err(DECODE_ERR.to_string())
    } else {
        Ok(text.into_owned())
    }
}

pub struct Chapter {
    pub title: String,
    pub paragraphs: Vec<String>,
}

fn heading_line(line: &str) -> Option<String> {
    static R1: OnceLock<Regex> = OnceLock::new();
    static R2: OnceLock<Regex> = OnceLock::new();
    static R3: OnceLock<Regex> = OnceLock::new();
    static R4: OnceLock<Regex> = OnceLock::new();
    static R5: OnceLock<Regex> = OnceLock::new();

    let t = line.trim();
    if t.is_empty() {
        return None;
    }

    // regex has no lookaround: continuation words checked on the captured tail
    let r1 = R1.get_or_init(|| {
        Regex::new(
            r"^\s{0,4}第\s{0,4}[\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,12}\s{0,4}(章|节|卷|回|部|集|篇)(.{0,30})$",
        )
        .unwrap()
    });
    if let Some(caps) = r1.captures(t) {
        let unit = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let tail = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let rejected = match unit {
            "节" => tail.starts_with('课'),
            "部" => tail.starts_with('分') || tail.starts_with('赛') || tail.starts_with('游'),
            "集" => tail.starts_with('合') || tail.starts_with('和'),
            "篇" => tail.starts_with('张'),
            _ => false,
        };
        if !rejected {
            return Some(t.to_string());
        }
    }

    let r2 = R2.get_or_init(|| {
        Regex::new(r"^\s{0,4}(序章|序言|楔子|引子|正文|终章|尾声|后记|番外|结局)(.{0,20})$").unwrap()
    });
    if let Some(caps) = r2.captures(t) {
        let kw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let tail = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let rejected = kw == "正文" && (tail.starts_with('完') || tail.starts_with('结'));
        if !rejected {
            return Some(t.to_string());
        }
    }

    let r3 = R3
        .get_or_init(|| Regex::new(r"^\s{0,4}(?i)(chapter|part|section|vol\.?|no\.?)\s*\d{1,4}(.{0,40})$").unwrap());
    let r4 = R4
        .get_or_init(|| Regex::new(r"^\s{0,4}\d{1,4}[、.．:：]\s*\S{0,20}$").unwrap());
    let r5 = R5.get_or_init(|| Regex::new(r"^\s{0,4}\d{1,4}$").unwrap());
    if r3.is_match(t) || r4.is_match(t) || r5.is_match(t) {
        return Some(t.to_string());
    }

    None
}

fn flush_chapter(title: Option<String>, paragraphs: &mut Vec<String>, out: &mut Vec<Chapter>) {
    if !paragraphs.is_empty() {
        out.push(Chapter {
            title: title.unwrap_or_else(|| "开头".to_string()),
            paragraphs: std::mem::take(paragraphs),
        });
    }
}

fn chunk_fallback(paragraphs: Vec<String>) -> Vec<Chapter> {
    let mut out = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut count = 0usize;
    let mut n = 0usize;
    for p in paragraphs {
        count += p.chars().count();
        current.push(p);
        if count >= FALLBACK_CHAPTER_CHARS {
            n += 1;
            out.push(Chapter {
                title: format!("第{}章", n),
                paragraphs: std::mem::take(&mut current),
            });
            count = 0;
        }
    }
    if !current.is_empty() {
        n += 1;
        out.push(Chapter {
            title: format!("第{}章", n),
            paragraphs: current,
        });
    }
    out
}

fn split_oversized(ch: Chapter) -> Vec<Chapter> {
    let total: usize = ch.paragraphs.iter().map(|p| p.chars().count()).sum();
    if total <= MAX_CHAPTER_CHARS {
        return vec![ch];
    }
    let mut out = Vec::new();
    let mut part: Vec<String> = Vec::new();
    let mut count = 0usize;
    let mut n = 0usize;
    for p in ch.paragraphs {
        count += p.chars().count();
        part.push(p);
        if count >= MAX_CHAPTER_CHARS {
            n += 1;
            out.push(Chapter {
                title: format!("{}({})", ch.title, n),
                paragraphs: std::mem::take(&mut part),
            });
            count = 0;
        }
    }
    if !part.is_empty() {
        n += 1;
        out.push(Chapter {
            title: format!("{}({})", ch.title, n),
            paragraphs: part,
        });
    }
    out
}

pub fn split_chapters(text: &str) -> Vec<Chapter> {
    let mut out: Vec<Chapter> = Vec::new();
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current: Option<String> = None;
    let mut heading_count = 0usize;

    for line in text.split('\n') {
        if let Some(title) = heading_line(line) {
            flush_chapter(current.take(), &mut paragraphs, &mut out);
            current = Some(title);
            heading_count += 1;
            continue;
        }
        let line = line.trim();
        if !line.is_empty() {
            paragraphs.push(line.to_string());
        }
    }
    flush_chapter(current.take(), &mut paragraphs, &mut out);

    if heading_count == 0 {
        let all: Vec<String> = out.into_iter().flat_map(|c| c.paragraphs).collect();
        return chunk_fallback(all);
    }

    out.into_iter().flat_map(split_oversized).collect()
}

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            // XML 1.0 illegal control characters are dropped
            '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' => {}
            _ => out.push(ch),
        }
    }
    out
}

fn chapter_xhtml(title: &str, paragraphs: &[String]) -> String {
    let title = escape_xml(title);
    let mut body = String::new();
    body.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\">\n<head>\n  <meta charset=\"utf-8\"/>\n  <title>");
    body.push_str(&title);
    body.push_str("</title>\n</head>\n<body>\n  <section>\n    <h1>");
    body.push_str(&title);
    body.push_str("</h1>\n");
    for p in paragraphs {
        body.push_str("    <p>");
        body.push_str(&escape_xml(p));
        body.push_str("</p>\n");
    }
    body.push_str("  </section>\n</body>\n</html>\n");
    body
}

fn content_opf(title_xml: &str, uuid: &str, modified: &str, chapter_count: usize) -> String {
    let mut manifest = String::new();
    let mut spine = String::new();
    for i in 1..=chapter_count {
        manifest.push_str(&format!(
            "    <item id=\"c{}\" href=\"text/ch{:04}.xhtml\" media-type=\"application/xhtml+xml\"/>\n",
            i, i
        ));
        spine.push_str(&format!("    <itemref idref=\"c{}\"/>\n", i));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:{uuid}</dc:identifier>
    <dc:title>{title_xml}</dc:title>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">{modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
{manifest}  </manifest>
  <spine>
{spine}  </spine>
</package>
"#
    )
}

fn nav_xhtml(title_xml: &str, chapters: &[Chapter]) -> String {
    let mut lis = String::new();
    for (i, ch) in chapters.iter().enumerate() {
        lis.push_str(&format!(
            "      <li><a href=\"text/ch{:04}.xhtml\">{}</a></li>\n",
            i + 1,
            escape_xml(&ch.title)
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="utf-8"/>
  <title>{title_xml}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
{lis}    </ol>
  </nav>
</body>
</html>
"#
    )
}

fn add_entry<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    name: &str,
    opts: SimpleFileOptions,
    content: &str,
) -> Result<(), String> {
    zip.start_file(name, opts)
        .map_err(|e| format!("failed to add {name}: {e}"))?;
    zip.write_all(content.as_bytes())
        .map_err(|e| format!("failed to write {name}: {e}"))?;
    Ok(())
}

pub fn txt_to_epub(title: &str, text: &str) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() {
        return Err("TXT 内容为空".to_string());
    }
    let chapters = split_chapters(text);
    if chapters.is_empty() {
        return Err("TXT 内容为空".to_string());
    }

    let title_xml = escape_xml(title);
    let uuid = Uuid::new_v4().to_string();
    let modified = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());

    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // OCF: mimetype must be the first entry, stored uncompressed
    add_entry(&mut zip, "mimetype", stored, "application/epub+zip")?;
    add_entry(&mut zip, "META-INF/container.xml", deflated, CONTAINER_XML)?;
    add_entry(
        &mut zip,
        "OEBPS/content.opf",
        deflated,
        &content_opf(&title_xml, &uuid, &modified, chapters.len()),
    )?;
    add_entry(&mut zip, "OEBPS/nav.xhtml", deflated, &nav_xhtml(&title_xml, &chapters))?;
    for (i, ch) in chapters.iter().enumerate() {
        add_entry(
            &mut zip,
            &format!("OEBPS/text/ch{:04}.xhtml", i + 1),
            deflated,
            &chapter_xhtml(&ch.title, &ch.paragraphs),
        )?;
    }

    zip.finish()
        .map_err(|e| format!("failed to finish epub zip: {e}"))
        .map(|cursor| cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use zip::ZipArchive;

    #[test]
    fn decode_txt_gbk_round_trip() {
        let s = "中文测试内容，包含标点符号。";
        let (bytes, _, _) = encoding_rs::GBK.encode(s);
        assert_eq!(decode_txt(bytes.as_ref()).unwrap(), s);
    }

    #[test]
    fn decode_txt_strips_utf8_bom() {
        let mut bytes = b"\xEF\xBB\xBF".to_vec();
        bytes.extend_from_slice("你好".as_bytes());
        assert_eq!(decode_txt(&bytes).unwrap(), "你好");
    }

    #[test]
    fn decode_txt_rejects_invalid_bytes() {
        assert!(decode_txt(b"\xFF").is_err());
    }

    #[test]
    fn split_chapters_matches_heading_rules() {
        let text = "楔子\n梦的开始。\n第一章 起点\n这是第一段。\n第3节课 体育\n第二节课 数学\n第二章 终点\n临近结束。\n1、大纲\n大纲内容。";
        let chs = split_chapters(text);
        let titles: Vec<&str> = chs.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, vec!["楔子", "第一章 起点", "第二章 终点", "1、大纲"]);
        assert_eq!(
            chs[1].paragraphs,
            vec!["这是第一段。".to_string(), "第3节课 体育".to_string(), "第二节课 数学".to_string()]
        );
    }

    #[test]
    fn split_chapters_fallback_chunks() {
        let para = "这是一段用来测试自动分章的正文内容，不包含任何标题形式。".repeat(4);
        let text = vec![para; 160].join("\n\n");
        let chs = split_chapters(&text);
        assert_eq!(chs.len(), 2);
        assert_eq!(chs[0].title, "第1章");
        assert_eq!(chs[1].title, "第2章");
    }

    #[test]
    fn split_chapters_splits_oversized() {
        let para = "很长的段落内容。".repeat(20);
        let mut text = String::from("第一章 巨章\n");
        for _ in 0..700 {
            text.push_str(&para);
            text.push('\n');
        }
        let chs = split_chapters(&text);
        assert_eq!(chs.len(), 2);
        assert!(chs[0].title.ends_with("(1)"));
        assert!(chs[1].title.ends_with("(2)"));
    }

    #[test]
    fn escape_xml_escapes_and_strips_controls() {
        assert_eq!(escape_xml("a<b>&c"), "a&lt;b&gt;&amp;c");
        assert_eq!(escape_xml("x\u{0}y\u{8}z"), "xyz");
        assert_eq!(escape_xml("保留\t制表"), "保留\t制表");
    }

    #[test]
    fn txt_to_epub_builds_valid_zip() {
        let text = "第一章 开始\n段落甲。\n第二章 继续\n段落乙。\n";
        let bytes = txt_to_epub("测试&书", text).unwrap();

        let mut zip = ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).unwrap();
        let mut first = zip.by_index(0).unwrap();
        assert_eq!(first.name(), "mimetype");
        assert_eq!(first.compression(), zip::CompressionMethod::Stored);
        let mut mime = String::new();
        first.read_to_string(&mut mime).unwrap();
        assert_eq!(mime, "application/epub+zip");
        drop(first);

        let mut opf = String::new();
        zip.by_name("OEBPS/content.opf")
            .unwrap()
            .read_to_string(&mut opf)
            .unwrap();
        assert!(opf.contains("<dc:title>测试&amp;书</dc:title>"));
        assert!(opf.contains("properties=\"nav\""));

        assert!(zip.by_name("META-INF/container.xml").is_ok());
        let mut nav = String::new();
        zip.by_name("OEBPS/nav.xhtml")
            .unwrap()
            .read_to_string(&mut nav)
            .unwrap();
        assert!(nav.contains("第一章 开始"));
        assert!(zip.by_name("OEBPS/text/ch0001.xhtml").is_ok());
        assert!(zip.by_name("OEBPS/text/ch0002.xhtml").is_ok());
    }

    #[test]
    fn txt_to_epub_rejects_empty() {
        assert!(txt_to_epub("t", "  \n  ").is_err());
    }
}
