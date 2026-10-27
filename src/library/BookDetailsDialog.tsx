import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import type { Book, Shelf, Tag } from "../tauri/invoke";
import { computeBookStats, createTag, setBookCover, setBookTags, updateBookMetadata } from "../tauri/invoke";
import { showAlert } from "../ui/dialog";
import { invalidateCoverUrl, requestCoverUrl, useCoverUrls } from "./useCoverUrls";
import { DEFAULT_TAG_COLOR, formatFileSize, tagDotColor } from "./tags";
import { shelfPath } from "./shelves";

function formatLabel(book: Book): string {
  if (book.format === "images") {
    return book.library_path.toLowerCase().endsWith(".cbz") ? "漫画（CBZ）" : "漫画（文件夹）";
  }
  return "EPUB";
}

function progressText(percent: number | null): string {
  return typeof percent === "number" ? `${Math.round(percent * 100)}%` : "未读";
}

/** 书籍详情：左封面（可更换），右侧编辑元数据/标签 + 只读统计行 */
export default function BookDetailsDialog({
  book,
  tags,
  shelves,
  onClose,
  onChanged,
}: {
  book: Book;
  tags: Tag[];
  shelves: Shelf[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [b, setB] = useState<Book>(book);
  const [title, setTitle] = useState(book.title ?? "");
  const [author, setAuthor] = useState(book.author ?? "");
  const [description, setDescription] = useState(book.description ?? "");
  const [tagIds, setTagIds] = useState<Set<number>>(new Set(book.tags.map((t) => t.id)));
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const coverUrls = useCoverUrls([b]);

  // file_size 缺失时按需计算（写库并回填显示；epub 章节数/字数 v1 不算，显示 —）
  useEffect(() => {
    if (b.file_size != null) return;
    let cancelled = false;
    computeBookStats(b.id)
      .then((updated) => {
        if (!cancelled) setB((prev) => ({ ...prev, file_size: updated.file_size }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [b.id]);

  const onBook = tagIds.size === new Set(book.tags.map((t) => t.id)).size &&
    [...tagIds].every((id) => book.tags.some((t) => t.id === id));
  const dirty =
    !onBook ||
    title.trim() !== (book.title ?? "") ||
    author.trim() !== (book.author ?? "") ||
    description.trim() !== (book.description ?? "");

  const suggestions = useMemo(() => {
    const q = tagInput.trim().toLowerCase();
    return tags.filter((t) => !tagIds.has(t.id) && (!q || t.name.toLowerCase().includes(q))).slice(0, 8);
  }, [tags, tagIds, tagInput]);

  const chips = useMemo(
    () =>
      [...tagIds]
        .map((id) => tags.find((t) => t.id === id) ?? book.tags.find((t) => t.id === id))
        .filter((t): t is Tag => !!t),
    [tagIds, tags, book.tags],
  );

  function toggleTag(id: number) {
    setTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addOrCreateTag(raw: string) {
    const name = raw.trim();
    if (!name) return;
    const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      toggleTag(existing.id);
      setTagInput("");
      return;
    }
    try {
      const created = await createTag(name, DEFAULT_TAG_COLOR);
      onChanged(); // 刷新标签列表（计数）
      toggleTag(created.id);
      setTagInput("");
    } catch (e) {
      await showAlert("创建标签失败", String(e));
    }
  }

  async function onChangeCover() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const newPath = await setBookCover(b.id, picked);
      if (b.cover_path) invalidateCoverUrl(b.cover_path);
      requestCoverUrl(newPath);
      setB((prev) => ({ ...prev, cover_path: newPath }));
      onChanged();
    } catch (e) {
      await showAlert("设置封面失败", String(e));
    }
  }

  async function onSave() {
    const t = title.trim();
    if (!t) return;
    setSaving(true);
    try {
      // author/description 空串=清除（后端 note 语义）；标题空已被禁用
      await updateBookMetadata({ book_id: b.id, title: t, author: author.trim(), description: description.trim() });
      if (!onBook) await setBookTags(b.id, [...tagIds]);
      onChanged();
      onClose();
    } catch (e) {
      await showAlert("保存失败", String(e));
    } finally {
      setSaving(false);
    }
  }

  const pathNames = shelfPath(shelves, b.shelf_id).map((s) => s.name);
  const coverUrl = b.cover_path ? coverUrls[b.cover_path] : undefined;

  return (
    <div
      className="wr-prompt-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="wr-panel wr-prompt wr-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`书籍详情 ${b.title ?? ""}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="wr-prompt-title">书籍详情</div>
        <div className="wr-details">
          <div
            className="wr-details-cover"
            role="button"
            tabIndex={0}
            aria-label="更换封面"
            title="点击更换封面"
            onClick={() => void onChangeCover()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void onChangeCover();
              }
            }}
          >
            {coverUrl ? (
              <img src={coverUrl} alt="" />
            ) : (
              <>
                <div className="wr-cover-title">{b.title?.trim() || "未命名"}</div>
                <div className="wr-cover-author">{b.author?.trim() || "未知作者"}</div>
              </>
            )}
          </div>

          <div className="wr-details-main">
            <label className="wr-details-label" htmlFor="detail-title">标题</label>
            <input id="detail-title" className="wr-input" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
            <label className="wr-details-label" htmlFor="detail-author">作者</label>
            <input
              id="detail-author"
              className="wr-input"
              value={author}
              placeholder="未知作者"
              onChange={(e) => setAuthor(e.currentTarget.value)}
            />
            <label className="wr-details-label" htmlFor="detail-desc">简介（留空清除）</label>
            <textarea
              id="detail-desc"
              className="wr-input wr-details-desc"
              value={description}
              rows={3}
              onChange={(e) => setDescription(e.currentTarget.value)}
            />

            <div className="wr-details-label">标签</div>
            <div className="wr-details-tags">
              {chips.map((t) => (
                <span key={t.id} className="wr-tag-chip">
                  <span className="wr-tag-dot" style={{ background: tagDotColor(t.color) }} aria-hidden="true" />
                  {t.name}
                  <button
                    type="button"
                    aria-label={`移除标签 ${t.name}`}
                    onClick={() => toggleTag(t.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div style={{ position: "relative" }}>
              <input
                className="wr-input"
                value={tagInput}
                placeholder="输入标签名：Enter 新建或选中"
                aria-label="添加标签"
                onChange={(e) => setTagInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addOrCreateTag(tagInput);
                  }
                }}
              />
              {tagInput.trim() ? (
                <div className="wr-tag-pop wr-tag-pop-inline">
                  {suggestions.length > 0 ? (
                    suggestions.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className="wr-tag-item"
                        onClick={() => {
                          toggleTag(t.id);
                          setTagInput("");
                        }}
                      >
                        <span className="wr-tag-dot" style={{ background: tagDotColor(t.color) }} aria-hidden="true" />
                        <span className="wr-tag-item-name">{t.name}</span>
                      </button>
                    ))
                  ) : null}
                  {!tags.some((t) => t.name.toLowerCase() === tagInput.trim().toLowerCase()) ? (
                    <button type="button" className="wr-tag-item" onClick={() => void addOrCreateTag(tagInput)}>
                      <span className="wr-tag-item-name">新建“{tagInput.trim()}”</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="wr-details-stats">
              <span>格式</span>
              <span>{formatLabel(b)}</span>
              <span>文件</span>
              <span className="wr-details-ellipsis" title={b.library_path}>
                {b.library_path.split(/[\\/]/).pop() ?? b.library_path}
              </span>
              <span>大小</span>
              <span>{formatFileSize(b.file_size)}</span>
              <span>页数</span>
              <span>{b.page_count != null ? `${b.page_count} 页` : "—"}</span>
              <span>字数</span>
              <span>{b.content_chars != null ? b.content_chars.toLocaleString() : "—"}</span>
              <span>导入时间</span>
              <span>{new Date(b.added_at * 1000).toLocaleString()}</span>
              <span>进度</span>
              <span>{progressText(b.reading_percent)}</span>
              <span>书架</span>
              <span className="wr-details-ellipsis" title={pathNames.join(" / ")}>
                {pathNames.length > 0 ? pathNames.join(" / ") : "未分组"}
              </span>
            </div>
          </div>
        </div>

        <div className="wr-prompt-actions">
          <button className="wr-btn" onClick={onClose}>
            取消
          </button>
          <button className="wr-btn wr-btn-primary" disabled={saving || !title.trim() || !dirty} onClick={() => void onSave()}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
