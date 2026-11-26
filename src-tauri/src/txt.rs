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

/// U+FFFE / U+FFFF 不是 XML 1.0 的合法字符（UTF-8 / UTF-16 都可能带进来），转 EPUB 后那一章会解析失败
fn strip_noncharacters(text: String) -> String {
    text.replace(['\u{FFFE}', '\u{FFFF}'], "")
}

/// 无 BOM 的 UTF-16 探测：UTF-8 / GBK 正文里不该有 0x00，有就看它落在偶数位（BE：高字节为 0）还是奇数位（LE）。
/// 只看前 4KB；两种位置都有（零星 NUL 的普通文本）不算。
fn sniff_utf16(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let n = bytes.len().min(4096) / 2 * 2;
    let (mut even, mut odd) = (0usize, 0usize);
    for (i, &b) in bytes[..n].iter().enumerate() {
        if b == 0 {
            if i % 2 == 0 {
                even += 1;
            } else {
                odd += 1;
            }
        }
    }
    if even + odd < 2 {
        return None;
    }
    if odd > even * 8 {
        Some(encoding_rs::UTF_16LE)
    } else if even > odd * 8 {
        Some(encoding_rs::UTF_16BE)
    } else {
        None
    }
}

/// UTF-8 错误序列个数（from_utf8 只报第一处，逐段往后数）
fn utf8_error_count(mut rest: &[u8]) -> usize {
    let mut n = 0;
    while let Err(e) = std::str::from_utf8(rest) {
        n += 1;
        let skip = e.valid_up_to() + e.error_len().unwrap_or(rest.len() - e.valid_up_to());
        rest = &rest[skip..];
    }
    n
}

fn decode_utf16(enc: &'static encoding_rs::Encoding, bytes: &[u8]) -> Result<String, String> {
    let (text, had_errors) = enc.decode_with_bom_removal(bytes);
    if had_errors {
        Err(DECODE_ERR.to_string())
    } else {
        Ok(text.into_owned())
    }
}

pub fn decode_txt(bytes: &[u8]) -> Result<String, String> {
    let text = if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]) {
        std::str::from_utf8(rest)
            .map(|s| s.to_string())
            .map_err(|_| DECODE_ERR.to_string())?
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        decode_utf16(encoding_rs::UTF_16LE, bytes)?
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        decode_utf16(encoding_rs::UTF_16BE, bytes)?
    } else if let Some(enc) = sniff_utf16(bytes) {
        decode_utf16(enc, bytes)?
    } else {
        match std::str::from_utf8(bytes) {
            Ok(s) => s.to_string(),
            // 个别坏字节的 UTF-8（坏序列 ≤ 千分之一）按 UTF-8 容错解码，坏处换成替换符；坏得多才当 GBK。
            // 原先只要有一个坏字节就整本落 GB18030，恰好合法时全书乱码
            Err(_) if utf8_error_count(bytes) * 1000 <= bytes.len() => String::from_utf8_lossy(bytes).into_owned(),
            Err(_) => {
                // WHATWG "gbk" label is the gb18030 decoder, a superset of GBK
                let (text, had_errors) = encoding_rs::GBK.decode_with_bom_removal(bytes);
                if had_errors {
                    return Err(DECODE_ERR.to_string());
                }
                text.into_owned()
            }
        }
    };
    Ok(strip_noncharacters(text))
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

fn content_opf(title_xml: &str, author_xml: Option<&str>, uuid: &str, modified: &str, chapter_count: usize) -> String {
    let mut manifest = String::new();
    let mut spine = String::new();
    for i in 1..=chapter_count {
        manifest.push_str(&format!(
            "    <item id=\"c{}\" href=\"text/ch{:04}.xhtml\" media-type=\"application/xhtml+xml\"/>\n",
            i, i
        ));
        spine.push_str(&format!("    <itemref idref=\"c{}\"/>\n", i));
    }
    // B2：作者可缺（无作者信息时不输出空 dc:creator）
    let creator = author_xml
        .map(|a| format!("    <dc:creator>{a}</dc:creator>\n"))
        .unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:{uuid}</dc:identifier>
    <dc:title>{title_xml}</dc:title>
{creator}    <dc:language>zh</dc:language>
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

pub fn txt_to_epub(title: &str, author: Option<&str>, text: &str) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() {
        return Err("TXT 内容为空".to_string());
    }
    let chapters = split_chapters(text);
    if chapters.is_empty() {
        return Err("TXT 内容为空".to_string());
    }

    let title_xml = escape_xml(title);
    let author_xml = author
        .filter(|a| !a.trim().is_empty())
        .map(escape_xml);
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
        &content_opf(&title_xml, author_xml.as_deref(), &uuid, &modified, chapters.len()),
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

    // R6：无 BOM 的 UTF-16——按 0x00 落在奇数位还是偶数位判字节序
    #[test]
    fn decode_txt_bomless_utf16_by_zero_distribution() {
        let s = "第一章 起点\n这是第一段。Chapter 1, line 2.\n第二行。";
        let (le, _, _) = encoding_rs::UTF_16LE.encode(s);
        let (be, _, _) = encoding_rs::UTF_16BE.encode(s);
        assert_eq!(decode_txt(le.as_ref()).unwrap(), s);
        assert_eq!(decode_txt(be.as_ref()).unwrap(), s);
        // 普通 UTF-8 / GBK 文本不带 0x00，不会被误判（各自的 round trip 用例已覆盖）
        assert_eq!(sniff_utf16(s.as_bytes()), None);
        assert_eq!(sniff_utf16(&encoding_rs::GBK.encode(s).0), None);
    }

    // R6：UTF-8 里零星几个坏字节——仍按 UTF-8 解，坏处换成替换符，而不是整本落 GBK
    #[test]
    fn decode_txt_tolerates_sparse_bad_bytes_in_utf8() {
        let mut bytes = "第一段正文。".repeat(200).into_bytes();
        bytes[5] = 0xFF;
        let text = decode_txt(&bytes).unwrap();
        assert!(text.contains("第一段正文。"), "{text}");
        assert!(text.contains('\u{FFFD}'), "坏字节应换成替换符：{text}");
        // 坏得多（真 GBK 被当成 UTF-8 时的坏序列量级）才走 GBK：GBK round trip 用例即此路径
    }

    // R6：U+FFFE / U+FFFF 不是 XML 合法字符，输出前剔掉
    #[test]
    fn decode_txt_strips_noncharacters() {
        let bytes = "正文\u{FFFE}中间\u{FFFF}结尾".as_bytes().to_vec();
        assert_eq!(decode_txt(&bytes).unwrap(), "正文中间结尾");
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
        let bytes = txt_to_epub("测试&书", None, text).unwrap();

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
        assert!(txt_to_epub("t", None, "  \n  ").is_err());
    }

    // ---- B2：内嵌标题/作者（import_book 传入清洗后的最终值） ----

    #[test]
    fn txt_to_epub_embeds_title_and_author() {
        let bytes = txt_to_epub("wenku8 清洗后书名", Some("作者&甲"), "第一章 开始\n段落。\n").unwrap();
        let mut zip = ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).unwrap();
        let mut opf = String::new();
        zip.by_name("OEBPS/content.opf")
            .unwrap()
            .read_to_string(&mut opf)
            .unwrap();
        assert!(opf.contains("<dc:title>wenku8 清洗后书名</dc:title>"));
        assert!(opf.contains("<dc:creator>作者&amp;甲</dc:creator>"));

        // 无作者：不输出空 dc:creator；空白作者等同无作者
        for author in [None, Some("   ")] {
            let bytes = txt_to_epub("无作者", author, "第一章 x\ny\n").unwrap();
            let mut zip = ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).unwrap();
            let mut opf = String::new();
            zip.by_name("OEBPS/content.opf")
                .unwrap()
                .read_to_string(&mut opf)
                .unwrap();
            assert!(opf.contains("<dc:title>无作者</dc:title>"));
            assert!(!opf.contains("dc:creator"), "{opf}");
        }
    }
}
