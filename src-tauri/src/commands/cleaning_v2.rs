//! v3.1 批次2 D-1（U-4 清洗 v2）新命令：全库抽样报告 + 单本还原。
//! 命令待主控在 lib.rs `generate_handler!` 接线（接线前前端不可调用）；核心逻辑走 `pub(crate) fn`，测试不依赖接线。

use rusqlite::{params, Connection};

use crate::commands::metadata_clean::{clean_title, has_group_feature, is_cjk_char, is_cjk_short_group};
use crate::db;

// ---- 抽样报告（纯分析，不写库）----

/// 残留检测：清洗结果里仍可疑的片段。
/// 覆盖：括号内 2-8 字纯中日文短组（未剥净的组名/括号注）、全角｜、HTML 实体、连续空白。
fn scan_residue(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    // 括号短组（嵌套不处理：书名里实际不存在）
    let mut rest = s;
    while let Some(open) = rest.find(['[', '(']) {
        let close_ch = if rest[open..].starts_with('[') { ']' } else { ')' };
        let Some(rel) = rest[open..].find(close_ch) else { break };
        let close = open + rel;
        if is_cjk_short_group(&rest[open + 1..close]) {
            out.push(rest[open..close + close_ch.len_utf8()].to_string());
        }
        rest = &rest[close + close_ch.len_utf8()..];
    }
    if s.contains('｜') {
        out.push("｜".to_string());
    }
    out.extend(scan_entities(s));
    out.extend(scan_ws_runs(s));
    out
}

/// HTML 实体残留：`&name;` / `&#123;`（管线的固定词表解码不到的数字实体是主要漏网形态）
fn scan_entities(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(pos) = s[i..].find('&') {
        let start = i + pos;
        let tail = &s[start..];
        let Some(end) = tail.find(';') else { break };
        if end <= 12 {
            let body = &tail[1..end];
            let digits = body[1..].bytes().all(|b| b.is_ascii_digit());
            let hex = body.len() > 2
                && (body[1..].starts_with('x') || body[1..].starts_with('X'))
                && body[2..].bytes().all(|b| b.is_ascii_hexdigit());
            let numeric = body.len() > 1 && body.starts_with('#') && (digits || hex);
            let named = body.len() >= 2 && body.bytes().all(|b| b.is_ascii_alphanumeric());
            if numeric || named {
                out.push(tail[..=end].to_string());
            }
        }
        i = start + end + 1;
    }
    out
}

/// 连续空白（≥2，含全角空格/制表）——normalize_ws 之后不应出现，防御性上报
fn scan_ws_runs(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut run = String::new();
    for c in s.chars() {
        if matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{3000}') {
            run.push(c);
        } else {
            if run.chars().count() >= 2 {
                out.push(run.clone());
            }
            run.clear();
        }
    }
    if run.chars().count() >= 2 {
        out.push(run);
    }
    out
}

/// 误伤嫌疑：被剥入 source_tags 的纯中日文组，含版次/卷话类词且无组名特征——多半是标题本体被吞。
/// 纯提示不改数据，供按 D-1 报告调规则用。
fn is_suspect_tag(tag: &str) -> bool {
    let inner = tag.trim_start_matches(['[', '(', '【']).trim_end_matches([']', ')', '】']).trim();
    if inner.is_empty() || !inner.chars().all(is_cjk_char) {
        return false;
    }
    const EDITION: &[&str] = &["版", "巻", "卷", "話", "话", "章", "篇", "特典", "番外", "特装", "完整"];
    !has_group_feature(inner) && EDITION.iter().any(|w| inner.contains(w))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleReportItem {
    pub book_id: String,
    /// 当前库内标题（多为已清洗形态）
    pub title: String,
    /// 现行管线再清洗的展示形态（title｜subtitle）
    pub cleaned: String,
    pub residue: Vec<String>,
    pub suspect_tags: Vec<String>,
}

pub(crate) fn sample_report_core(conn: &Connection) -> Result<Vec<SampleReportItem>, String> {
    // manual 书也读：报告是分析不是改写，手改标题的残留同样值得看
    let rows: Vec<(String, Option<String>)> = conn
        .prepare("SELECT id, title FROM books WHERE deleted_at IS NULL")
        .map_err(|e| format!("failed to list books: {e}"))?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| format!("failed to query books: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to read books: {e}"))?;

    let mut out = Vec::new();
    for (id, title) in rows {
        let raw = title.unwrap_or_default();
        let cleaned = clean_title(&raw);
        let cleaned_disp = if cleaned.subtitle.is_empty() {
            cleaned.title.clone()
        } else {
            format!("{}｜{}", cleaned.title, cleaned.subtitle)
        };
        let residue = scan_residue(&cleaned_disp);
        let suspect_tags = cleaned
            .source_tags
            .iter()
            .filter(|t| is_suspect_tag(t))
            .cloned()
            .collect::<Vec<_>>();
        if !residue.is_empty() || !suspect_tags.is_empty() {
            out.push(SampleReportItem {
                book_id: id,
                title: raw,
                cleaned: cleaned_disp,
                residue,
                suspect_tags,
            });
        }
    }
    Ok(out)
}

// ---- 单本还原（D-1.3）----

/// 恢复 clean_apply 首次清洗前快照的 title/subtitle/source_tags 并清标记。
/// 返回 false = 无快照（从未批量清洗过）或书不存在/已删。
pub(crate) fn revert_title_core(conn: &Connection, book_id: &str) -> Result<bool, String> {
    conn.execute(
        "UPDATE books SET
            title = original_title,
            subtitle = original_subtitle,
            source_tags = original_source_tags,
            original_title = NULL, original_subtitle = NULL, original_source_tags = NULL
         WHERE id = ?1 AND deleted_at IS NULL AND original_title IS NOT NULL",
        params![book_id],
    )
    .map_err(|e| format!("failed to revert title for book {book_id}: {e}"))
    .map(|n| n > 0)
}

#[tauri::command(async)]
pub fn clean_sample_report(app: tauri::AppHandle) -> Result<Vec<SampleReportItem>, String> {
    let conn = db::open_db(&app)?;
    sample_report_core(&conn)
}

#[tauri::command(async)]
pub fn revert_title(app: tauri::AppHandle, book_id: String) -> Result<bool, String> {
    let conn = db::open_db(&app)?;
    revert_title_core(&conn, &book_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::metadata_clean::{clean_apply, CleanApplyUpdate};

    fn seed() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA_SQL).unwrap();
        let ins = |id: &str, title: &str| {
            conn.execute(
                "INSERT INTO books (id, title, library_path, added_at) VALUES (?1, ?2, ?3, 1)",
                params![id, title, format!("library/books/{id}.epub")],
            )
            .unwrap();
        };
        ins("r1", "白書&#8212;残"); // 数字实体：管线词表解码不到 → 实体残留
        ins("r2", "タイトル (新装版)"); // 括号纯中日文短组存留（保护性保留，报告提示人工复核）
        ins("r3", "書名 [合集版]"); // 词表「合集」命中剥入 tags，但含「版」→ 误伤嫌疑
        ins("r4", "三体"); // 干净 → 不出报告
        ins("r5", "削除本 [DL版]"); // 软删 → 不读
        conn.execute("UPDATE books SET deleted_at = 9 WHERE id = 'r5'", []).unwrap();
        ins("r6", "手改 (新装版)"); // manual 也出报告：分析视角不含改写语义
        conn.execute("UPDATE books SET title_source = 'manual' WHERE id = 'r6'", []).unwrap();
        conn
    }

    #[test]
    fn residue_detectors_find_the_four_shapes() {
        // 括号短组 / 全角｜ / 实体 / 连续空白（全角空格）
        assert_eq!(scan_residue("標題 (新装版)"), vec!["(新装版)"]);
        assert_eq!(scan_residue("A｜B"), vec!["｜"]);
        assert_eq!(scan_residue("白書&#8212;残"), vec!["&#8212;"]);
        assert_eq!(scan_residue("白書&#x4e2d;残"), vec!["&#x4e2d;"]);
        assert_eq!(scan_residue("A  B"), vec!["  "]);
        assert!(scan_residue("A & B").is_empty()); // 裸 & 不是实体
        assert!(scan_residue("三体 [DL版]").is_empty()); // 已剥净 + 非 CJK 短组
    }

    #[test]
    fn suspect_tag_needs_edition_word_without_group_feature() {
        assert!(is_suspect_tag("(中文版)"));
        assert!(is_suspect_tag("[特典版]"));
        assert!(!is_suspect_tag("[神風字幕]")); // 有组名特征：正常剥离
        assert!(!is_suspect_tag("[DL版]")); // 非纯中日文：DL 版是发布标签
        assert!(!is_suspect_tag("[汉化]")); // 组名特征命中
    }

    #[test]
    fn sample_report_clusters_residue_and_suspects() {
        let conn = seed();
        let items = sample_report_core(&conn).unwrap();
        let by = |id: &str| items.iter().find(|i| i.book_id == id).unwrap();
        assert_eq!(items.len(), 4, "{items:?}");
        assert_eq!(by("r1").residue, vec!["&#8212;".to_string()]);
        assert_eq!(by("r2").residue, vec!["(新装版)".to_string()]);
        assert_eq!(by("r3").suspect_tags, vec!["[合集版]".to_string()]);
        assert_eq!(by("r6").residue, vec!["(新装版)".to_string()]); // manual 同样上报
        assert_eq!(by("r3").residue.len(), 0); // 剥净后无括号残留
        // 干净书/软删书不在报告里
        assert!(items.iter().all(|i| i.book_id != "r4" && i.book_id != "r5"));
    }

    #[test]
    fn revert_restores_first_snapshot_and_clears_marker() {
        let conn = seed();
        // v7：批洗前已有 subtitle/source_tags（导入时清洗落的）——快照必须存这一整组
        conn.execute(
            "INSERT INTO books (id, title, subtitle, source_tags, library_path, added_at)
             VALUES ('v7', '人妻超人&#124;飛機杯教室 [DL版]', '飛機杯教室', '[\"[DL版]\"]', 'library/books/v7.epub', 1)",
            [],
        )
        .unwrap();
        let upd = |title: &str| CleanApplyUpdate {
            book_id: "v7".to_string(),
            title: title.to_string(),
            subtitle: String::new(),
            author: String::new(),
            source_tags: Vec::new(),
        };
        assert_eq!(clean_apply(&conn, &[upd("人妻超人")]).unwrap(), 1);
        // 第二次清洗（title 又变）：快照不覆盖——还原回到最初原文
        assert_eq!(clean_apply(&conn, &[upd("人妻")]).unwrap(), 1);
        let snap: (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT original_title, original_subtitle, original_source_tags FROM books WHERE id = 'v7'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(snap.0.as_deref(), Some("人妻超人&#124;飛機杯教室 [DL版]"));
        assert_eq!(snap.1.as_deref(), Some("飛機杯教室"));
        assert_eq!(snap.2.as_deref(), Some("[\"[DL版]\"]"));

        assert!(revert_title_core(&conn, "v7").unwrap());
        let row: (String, Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT title, subtitle, source_tags, original_title FROM books WHERE id = 'v7'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(row.0, "人妻超人&#124;飛機杯教室 [DL版]");
        assert_eq!(row.1.as_deref(), Some("飛機杯教室"));
        assert_eq!(row.2.as_deref(), Some("[\"[DL版]\"]"));
        assert_eq!(row.3, None); // 标记已清：再还原无据可依
        assert!(!revert_title_core(&conn, "v7").unwrap());
        // 从未清洗过 / 已软删：无快照不可还原
        assert!(!revert_title_core(&conn, "r4").unwrap());
        assert!(!revert_title_core(&conn, "r5").unwrap());
    }
}
