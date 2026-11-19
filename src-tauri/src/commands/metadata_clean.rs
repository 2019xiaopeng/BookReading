use rusqlite::{params, Connection};

use crate::db;

// ---- N-1 词表（规格 §一·三，8 步清洗）----

/// 第 3 步发布标签词表：`[...]` 内命中即剥离。全小写存储；
/// ASCII 词按整词边界匹配（防 AI 命中 AIDA/maid），非 ASCII 词子串匹配。
const RELEASE_WORDS: &[&str] = &[
    "汉化", "翻訳", "翻译", "中文", "中国", "無修正", "无修正", "疏碼", "疏码", "dl版",
    "个人汉化", "個人漢化", "汉化组", "机翻", "機翻", "ai-generated", "ai", "kkb", "合集",
    "整合", "uncensored", "digital", "电子", "exclusive",
];

/// 第 4 步水印前缀额外词（与发布词表叠加，`【...】` 开头命中即剥离）
const WATERMARK_EXTRA: &[&str] = &["韭菜盒子", "禁转载", "禁轉載", "仅供个人学习"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanedTitle {
    /// 清洗后主标题（日文/原文段）
    pub title: String,
    /// 中文段（双语拆分），无则空
    pub subtitle: String,
    /// 剥离的发布标签/水印/出处（原样保留，含括号）
    pub source_tags: Vec<String>,
}

// 第 1 步：实体解码。&amp; 最后解，防 `&amp;#124;` 双重解码。
fn decode_entities(s: &str) -> String {
    s.replace("&#124;", "｜")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

// 第 2 步：双语拆分（全角 ｜ 或 " | "）
fn split_bilingual(s: &str) -> Vec<String> {
    s.replace(" | ", "｜").split('｜').map(str::to_string).collect()
}

fn word_match(hay_lower: &str, word: &str) -> bool {
    if !word.is_ascii() {
        return hay_lower.contains(word);
    }
    let mut from = 0;
    while let Some(pos) = hay_lower[from..].find(word) {
        let start = from + pos;
        let end = start + word.len();
        let before = hay_lower[..start]
            .chars()
            .next_back()
            .map_or(true, |c| !c.is_ascii_alphanumeric());
        let after = hay_lower[end..]
            .chars()
            .next()
            .map_or(true, |c| !c.is_ascii_alphanumeric());
        if before && after {
            return true;
        }
        from = end;
    }
    false
}

fn matches_words(inner: &str, extra: &[&str]) -> bool {
    let lower = inner.to_lowercase();
    RELEASE_WORDS.iter().chain(extra.iter()).any(|w| word_match(&lower, w))
}

// 第 3 步：`[...]` 发布标签逐个剥离（未命中词表的方括号保留）
fn strip_square_brackets(s: &str, tags: &mut Vec<String>) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(open) = rest.find('[') {
        let close = match rest[open..].find(']') {
            Some(c) => open + c + 1,
            None => break, // 未闭合的 '[' 原样保留
        };
        out.push_str(&rest[..open]);
        if matches_words(&rest[open + 1..close - 1], &[]) {
            tags.push(rest[open..close].to_string());
        } else {
            out.push_str(&rest[open..close]);
        }
        rest = &rest[close..];
    }
    out.push_str(rest);
    out
}

// 第 4 步：`【...】` 开头水印前缀（连续多个都剥，非命中或不在开头则保留）
fn strip_watermark_prefix(s: &str, tags: &mut Vec<String>) -> String {
    let mut rest = s.trim_start();
    while rest.starts_with('【') {
        let close = match rest.find('】') {
            Some(c) => c,
            None => break,
        };
        let end = close + '】'.len_utf8();
        if matches_words(&rest['【'.len_utf8()..close], WATERMARK_EXTRA) {
            tags.push(rest[..end].to_string());
            rest = rest[end..].trim_start();
        } else {
            break;
        }
    }
    rest.to_string()
}

// 通用 `(...)` 组剥离：matched(inner) 为真才剥（并收入 tags），否则原样保留
fn strip_paren_groups<F: Fn(&str) -> bool>(s: &str, tags: &mut Vec<String>, matched: F) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(open) = rest.find('(') {
        let close = match rest[open..].find(')') {
            Some(c) => open + c + 1,
            None => break,
        };
        out.push_str(&rest[..open]);
        if matched(&rest[open + 1..close - 1]) {
            tags.push(rest[open..close].to_string());
        } else {
            out.push_str(&rest[open..close]);
        }
        rest = &rest[close..];
    }
    out.push_str(rest);
    out
}

// 第 5 步出处特征：COMIC / C数字# / 艦隊 / 艦これ / 東方
fn is_source_marker(inner: &str) -> bool {
    let lower = inner.to_lowercase();
    lower.contains("comic")
        || lower.contains("艦隊")
        || lower.contains("艦これ")
        || lower.contains("東方")
        || has_c_digits_hash(&lower)
}

fn has_c_digits_hash(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'c' {
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && j < b.len() && b[j] == b'#' {
                return true;
            }
        }
        i += 1;
    }
    false
}

// 第 6 步：空白归一（全角→半角、连续压一、去首尾）
fn normalize_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending = false;
    for c in s.chars() {
        if matches!(c, ' ' | '\u{3000}' | '\t' | '\r' | '\n') {
            pending = true;
        } else {
            if pending && !out.is_empty() {
                out.push(' ');
            }
            pending = false;
            out.push(c);
        }
    }
    out
}

/// 标题智能清洗（纯函数，无 IO，对空串/纯标签串安全）。
/// 8 步规格见 docs/开发计划-v2.9.0.md §一·三 N-1。
pub fn clean_title(raw: &str) -> CleanedTitle {
    let segments = split_bilingual(&decode_entities(raw));
    let mut tags = Vec::new();
    let cleaned: Vec<String> = segments
        .iter()
        .map(|seg| {
            let s = strip_square_brackets(seg, &mut tags);
            let s = strip_watermark_prefix(&s, &mut tags);
            let s = strip_paren_groups(&s, &mut tags, is_source_marker);
            normalize_ws(&s)
        })
        .collect();

    let mut title = cleaned.first().cloned().unwrap_or_default();
    let subtitle = if cleaned.len() >= 2 {
        cleaned[1..]
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        String::new()
    };

    // 第 8 步兜底：主段被剥空时先让位副标题，仍空则回退原始 raw
    if title.is_empty() {
        if !subtitle.is_empty() {
            title = subtitle.clone();
            return CleanedTitle { title, subtitle: String::new(), source_tags: tags };
        }
        title = raw.trim().to_string();
    }
    CleanedTitle { title, subtitle, source_tags: tags }
}

/// 作者清洗（第 7 步）：去 `(...)` 括号注、空白归一；空进空出。
pub fn clean_author(raw: &str) -> String {
    let mut junk = Vec::new();
    normalize_ws(&strip_paren_groups(&decode_entities(raw), &mut junk, |_| true))
}

/// N-1 导入即清洗：import_book / import_image_folder（folder+cbz）共用。
/// 空结果落 NULL（列可空）；title 清洗为空（即输入为空）保留原 Option。
pub(crate) fn clean_import_meta(
    title: Option<String>,
    author: Option<String>,
) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let cleaned = clean_title(title.as_deref().unwrap_or(""));
    let title = if cleaned.title.is_empty() { title } else { Some(cleaned.title) };
    let subtitle = (!cleaned.subtitle.is_empty()).then_some(cleaned.subtitle);
    let source_tags = (!cleaned.source_tags.is_empty())
        .then(|| serde_json::to_string(&cleaned.source_tags).unwrap_or_default());
    let author = clean_author(author.as_deref().unwrap_or(""));
    (title, subtitle, source_tags, (!author.is_empty()).then_some(author))
}

// ---- R-2 命令 ----

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanPreviewItem {
    pub book_id: String,
    pub title_old: Option<String>,
    pub title_new: String,
    pub subtitle: String,
    pub author_old: Option<String>,
    pub author_new: String,
    pub source_tags: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanApplyUpdate {
    pub book_id: String,
    pub title: String,
    pub subtitle: String,
    pub author: String,
    pub source_tags: Vec<String>,
}

// core takes conn so tests run against an in-memory db
fn clean_preview(conn: &Connection) -> Result<Vec<CleanPreviewItem>, String> {
    let rows: Vec<(String, Option<String>, Option<String>, Option<String>)> = conn
        .prepare("SELECT id, title, author, title_source FROM books WHERE deleted_at IS NULL")
        .map_err(|e| format!("failed to list books: {e}"))?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|e| format!("failed to query books: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to read books: {e}"))?;

    let mut out = Vec::new();
    for (id, title, author, title_source) in rows {
        // 手动改过标题的书永不覆盖（第 8 步）
        if title_source.as_deref() == Some("manual") {
            continue;
        }
        let raw_title = title.clone().unwrap_or_default();
        let cleaned = clean_title(&raw_title);
        let author_new = clean_author(author.as_deref().unwrap_or(""));
        if cleaned.title == raw_title && author_new == author.clone().unwrap_or_default() {
            continue; // 无实际变化不出预览
        }
        out.push(CleanPreviewItem {
            book_id: id,
            title_old: title,
            title_new: cleaned.title,
            subtitle: cleaned.subtitle,
            author_old: author,
            author_new,
            source_tags: cleaned.source_tags,
        });
    }
    Ok(out)
}

// core takes conn so tests run against an in-memory db
fn clean_apply(conn: &Connection, updates: &[CleanApplyUpdate]) -> Result<u32, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("failed to begin clean apply: {e}"))?;
    let mut n = 0u32;
    for u in updates {
        let subtitle = if u.subtitle.trim().is_empty() { None } else { Some(u.subtitle.clone()) };
        let author = if u.author.is_empty() { None } else { Some(u.author.clone()) };
        let tags_json = serde_json::to_string(&u.source_tags).ok().filter(|s| s != "[]");
        n += tx
            .execute(
                "UPDATE books SET title = ?2, subtitle = ?3, author = ?4, source_tags = ?5
                 WHERE id = ?1 AND deleted_at IS NULL
                   AND (title_source IS NULL OR title_source <> 'manual')",
                params![u.book_id, u.title, subtitle, author, tags_json],
            )
            .map_err(|e| format!("failed to update book {}: {e}", u.book_id))? as u32;
    }
    tx.commit()
        .map_err(|e| format!("failed to commit clean apply: {e}"))?;
    Ok(n)
}

#[tauri::command(async)]
pub fn clean_title_preview(app: tauri::AppHandle) -> Result<Vec<CleanPreviewItem>, String> {
    let conn = db::open_db(&app)?;
    clean_preview(&conn)
}

#[tauri::command(async)]
pub fn clean_title_apply(
    app: tauri::AppHandle,
    updates: Vec<CleanApplyUpdate>,
) -> Result<u32, String> {
    let conn = db::open_db(&app)?;
    clean_apply(&conn, &updates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_entity_and_splits_bilingual() {
        let c = clean_title("人妻超人&#124;飛機杯教室");
        assert_eq!(c.title, "人妻超人");
        assert_eq!(c.subtitle, "飛機杯教室");
        assert!(c.source_tags.is_empty());
    }

    #[test]
    fn splits_on_half_width_pipe_with_spaces() {
        let c = clean_title("オナホ教室 | 飛機杯教室");
        assert_eq!(c.title, "オナホ教室");
        assert_eq!(c.subtitle, "飛機杯教室");
    }

    #[test]
    fn extra_segments_merge_into_subtitle() {
        let c = clean_title("あ｜い｜う");
        assert_eq!(c.title, "あ");
        assert_eq!(c.subtitle, "い う");
    }

    #[test]
    fn strips_release_tags_and_keeps_non_tag_brackets() {
        let c = clean_title("石化アクメの女 [DL版] [机翻中文]");
        assert_eq!(c.title, "石化アクメの女");
        assert_eq!(c.source_tags, vec!["[DL版]".to_string(), "[机翻中文]".to_string()]);
        // 词表未命中的方括号是标题本体，保留
        let keep = clean_title("[Oh, My Sexy Aliens!] 公式");
        assert_eq!(keep.title, "[Oh, My Sexy Aliens!] 公式");
        assert!(keep.source_tags.is_empty());
    }

    #[test]
    fn strips_watermark_prefix() {
        let c = clean_title("【韭菜盒子kkb】王大屌的日常");
        assert_eq!(c.title, "王大屌的日常");
        assert_eq!(c.source_tags, vec!["【韭菜盒子kkb】".to_string()]);
        // 非词表水印前缀不剥
        let keep = clean_title("【非水印】标题");
        assert_eq!(keep.title, "【非水印】标题");
    }

    #[test]
    fn strips_source_suffix() {
        let c = clean_title("妹系的価値観 (COMIC X-EROS#125)");
        assert_eq!(c.title, "妹系的価値観");
        assert_eq!(c.source_tags, vec!["(COMIC X-EROS#125)".to_string()]);
        // 普通括号注不是出处，保留
        let keep = clean_title("タイトル (新装版)");
        assert_eq!(keep.title, "タイトル (新装版)");
        assert!(keep.source_tags.is_empty());
    }

    #[test]
    fn cleans_each_bilingual_segment() {
        let c = clean_title("石化アクメ [DL版]｜石化高潮 [机翻中文]");
        assert_eq!(c.title, "石化アクメ");
        assert_eq!(c.subtitle, "石化高潮");
        assert_eq!(c.source_tags, vec!["[DL版]".to_string(), "[机翻中文]".to_string()]);
    }

    #[test]
    fn author_paren_note_removed() {
        assert_eq!(clean_author("舞影 (美影)"), "舞影");
        assert_eq!(clean_author("  抹茶ねじ  "), "抹茶ねじ");
        assert_eq!(clean_author("A (1) (2)"), "A");
    }

    #[test]
    fn empty_after_clean_falls_back_to_raw() {
        let c = clean_title("  [DL版]  ");
        assert_eq!(c.title, "[DL版]");
        assert_eq!(c.source_tags, vec!["[DL版]".to_string()]);
    }

    #[test]
    fn all_tag_string_falls_back_and_collects_all() {
        let c = clean_title("[汉化][DL版]");
        assert_eq!(c.title, "[汉化][DL版]");
        assert_eq!(c.source_tags, vec!["[汉化]".to_string(), "[DL版]".to_string()]);
    }

    #[test]
    fn empty_inputs_are_safe() {
        let c = clean_title("");
        assert_eq!(c, CleanedTitle { title: String::new(), subtitle: String::new(), source_tags: Vec::new() });
        assert_eq!(clean_title("   ").title, "");
        assert_eq!(clean_author(""), "");
        assert_eq!(clean_author("   "), "");
    }

    #[test]
    fn empty_main_segment_promotes_subtitle() {
        let c = clean_title("[DL版]｜飛機杯教室");
        assert_eq!(c.title, "飛機杯教室");
        assert_eq!(c.subtitle, "");
        assert_eq!(c.source_tags, vec!["[DL版]".to_string()]);
    }

    #[test]
    fn ai_matches_whole_word_only() {
        // AIDA 不是 AI：不剥
        let keep = clean_title("AIDA in Wonderland [AIDA]");
        assert_eq!(keep.title, "AIDA in Wonderland [AIDA]");
        // 整词 AI / AI-generated 短语：剥
        let c = clean_title("本音 [AI]");
        assert_eq!(c.title, "本音");
        assert_eq!(c.source_tags, vec!["[AI]".to_string()]);
        let c2 = clean_title("本音 [AI-generated]");
        assert_eq!(c2.title, "本音");
        assert_eq!(c2.source_tags, vec!["[AI-generated]".to_string()]);
    }

    #[test]
    fn ampersand_entity_not_double_decoded() {
        let c = clean_title("A&amp;#124;B");
        assert_eq!(c.title, "A&#124;B");
    }

    #[test]
    fn other_entities_decode() {
        let c = clean_title("A&amp;B &lt;C&gt; &quot;d&quot; &#39;e&#39; f&nbsp;g");
        assert_eq!(c.title, "A&B <C> \"d\" 'e' f g");
    }

    // ---- R-2/R-3 preview 与 apply（内存库 + seed）----

    fn seed_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA_SQL).unwrap();
        let ins = |id: &str, title: &str, author: &str| {
            conn.execute(
                "INSERT INTO books (id, title, author, library_path, added_at) VALUES (?1,?2,?3,?4,1)",
                params![id, title, author, format!("library/books/{id}.epub")],
            )
            .unwrap();
        };
        ins("b1", "人妻超人&#124;飛機杯教室 [DL版]", "舞影 (美影)");
        ins("b2", "【韭菜盒子kkb】王大屌的日常", "某人"); // 手动改过 → 跳过
        conn.execute("UPDATE books SET title_source = 'manual' WHERE id = 'b2'", []).unwrap();
        ins("b3", "三体", "刘慈欣"); // 干净 → 无变化不出预览
        ins("b4", "[汉化][DL版]", "x"); // 已软删 → 不读
        conn.execute("UPDATE books SET deleted_at = 9 WHERE id = 'b4'", []).unwrap();
        conn
    }

    #[test]
    fn preview_lists_only_changed_non_manual_live_books() {
        let conn = seed_db();
        let items = clean_preview(&conn).unwrap();
        assert_eq!(items.len(), 1, "{items:?}");
        let it = &items[0];
        assert_eq!(it.book_id, "b1");
        assert_eq!(it.title_old.as_deref(), Some("人妻超人&#124;飛機杯教室 [DL版]"));
        assert_eq!(it.title_new, "人妻超人");
        assert_eq!(it.subtitle, "飛機杯教室");
        assert_eq!(it.author_old.as_deref(), Some("舞影 (美影)"));
        assert_eq!(it.author_new, "舞影");
        assert_eq!(it.source_tags, vec!["[DL版]".to_string()]);
    }

    #[test]
    fn apply_persists_and_guards_manual_and_deleted() {
        let conn = seed_db();
        let n = clean_apply(
            &conn,
            &[CleanApplyUpdate {
                book_id: "b1".to_string(),
                title: "人妻超人".to_string(),
                subtitle: "飛機杯教室".to_string(),
                author: "舞影".to_string(),
                source_tags: vec!["[DL版]".to_string()],
            }],
        )
        .unwrap();
        assert_eq!(n, 1);
        let row: (Option<String>, Option<String>, Option<String>, Option<String>) = conn
            .query_row("SELECT title, subtitle, author, source_tags FROM books WHERE id = 'b1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        assert_eq!(row.0.as_deref(), Some("人妻超人"));
        assert_eq!(row.1.as_deref(), Some("飛機杯教室"));
        assert_eq!(row.2.as_deref(), Some("舞影"));
        assert_eq!(row.3.as_deref(), Some("[\"[DL版]\"]"));

        // manual / 已删书：guard 拦下，计数 0、数据不动
        let n2 = clean_apply(
            &conn,
            &[
                CleanApplyUpdate {
                    book_id: "b2".to_string(),
                    title: "x".to_string(),
                    subtitle: String::new(),
                    author: String::new(),
                    source_tags: Vec::new(),
                },
                CleanApplyUpdate {
                    book_id: "b4".to_string(),
                    title: "y".to_string(),
                    subtitle: String::new(),
                    author: String::new(),
                    source_tags: Vec::new(),
                },
            ],
        )
        .unwrap();
        assert_eq!(n2, 0);
        let b2: Option<String> = conn
            .query_row("SELECT title FROM books WHERE id = 'b2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(b2.as_deref(), Some("【韭菜盒子kkb】王大屌的日常"));

        // 空副标题/空作者/空标签 → 存 NULL
        clean_apply(
            &conn,
            &[CleanApplyUpdate {
                book_id: "b3".to_string(),
                title: "三体".to_string(),
                subtitle: String::new(),
                author: String::new(),
                source_tags: Vec::new(),
            }],
        )
        .unwrap();
        let row: (Option<String>, Option<String>, Option<String>) = conn
            .query_row("SELECT subtitle, author, source_tags FROM books WHERE id = 'b3'", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(row, (None, None, None));
    }
}
