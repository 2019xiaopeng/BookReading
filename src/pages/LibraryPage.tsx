import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";

import type { Book, UpdateBookMetadataRequest } from "../tauri/invoke";
import {
  deleteBook,
  importBook,
  listBooks,
  repairBookMetadata,
  setBookFavorite,
  updateBookMetadata,
} from "../tauri/invoke";
import { needsMetadataRepair } from "../library/metadataRepair";
import { useCoverUrls } from "../library/useCoverUrls";
import { logFrontend } from "../tauri/frontendLog";
import AppShell from "../ui/AppShell";

function formatTitle(book: Book): string {
  return book.title?.trim() || "未命名";
}

function formatAuthor(book: Book): string {
  return book.author?.trim() || "未知作者";
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("全部");
  const [sortBy, setSortBy] = useState<"recent" | "title">("recent");
  const repairingRef = useRef<Set<string>>(new Set());
  const attemptedRef = useRef<Set<string>>(new Set());
  const coverUrls = useCoverUrls(books);

  const groups = useMemo(
    () =>
      [...new Set(books.map((b) => b.group_name).filter((g): g is string => !!g))].sort((a, b) =>
        a.localeCompare(b, "zh"),
      ),
    [books],
  );

  const booksFiltered = useMemo(() => {
    let list = groupFilter === "全部" ? books : books.filter((b) => b.group_name === groupFilter);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((b) => `${formatTitle(b)} ${formatAuthor(b)}`.toLowerCase().includes(q));
    }
    if (sortBy === "title") {
      list = [...list].sort(
        (a, b) =>
          Number(!!b.pinned_at) - Number(!!a.pinned_at) || formatTitle(a).localeCompare(formatTitle(b), "zh"),
      );
    }
    return list;
  }, [books, query, groupFilter, sortBy]);

  async function refresh() {
    const list = await listBooks();
    setBooks(list);
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const pending: Promise<void>[] = [];
    for (const b of books) {
      if (!needsMetadataRepair(b)) continue;
      if (attemptedRef.current.has(b.id)) continue;
      if (repairingRef.current.has(b.id)) continue;
      repairingRef.current.add(b.id);
      attemptedRef.current.add(b.id);
      pending.push(
        (async () => {
          try {
            await repairBookMetadata(b.id);
            await refresh();
          } catch (e) {
            logFrontend(`meta: repair failed ${b.id} ${String(e)}`);
          } finally {
            repairingRef.current.delete(b.id);
          }
        })(),
      );
    }
    return () => {
      void Promise.allSettled(pending);
    };
  }, [books]);

  async function onImport() {
    if (loading) return;
    setLoading(true);
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "EPUB / TXT", extensions: ["epub", "txt"] }],
      });
      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      const failed: string[] = [];
      for (const path of paths) {
        try {
          await importBook({
            source_path: path,
            title: null,
            author: null,
            cover_bytes_base64: null,
            cover_ext: null,
          });
        } catch (e) {
          failed.push(path);
          logFrontend(`ui: import failed ${path} ${String(e)}`);
        }
      }

      if (failed.length) {
        window.alert(`部分文件导入失败（${failed.length} 个）：\n${failed.join("\n")}\n仅支持 EPUB 与 UTF-8/GBK 编码的 TXT`);
      }

      await refresh();
    } finally {
      setLoading(false);
    }
  }

  async function onDelete(book: Book) {
    if (loading) return;
    const ok = window.confirm(`确定删除《${formatTitle(book)}》吗？阅读进度、书签与标注将一并删除，且不可恢复。`);
    if (!ok) return;

    setLoading(true);
    try {
      await deleteBook(book.id);
      await refresh();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onChipUpdate(req: UpdateBookMetadataRequest) {
    if (loading) return;
    setLoading(true);
    try {
      await updateBookMetadata(req);
      await refresh();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell
      active="library"
      title="书架"
      search={{ value: query, placeholder: "搜索书名 / 作者", onChange: setQuery }}
      sidebarFooter={
        <>
          <button className="wr-small-btn" disabled={loading} onClick={() => void refresh()}>
            刷新
          </button>
          <button className="wr-small-btn wr-primary" onClick={onImport} disabled={loading}>
            {loading ? "导入中…" : "导入图书"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", gap: 8, padding: "16px 18px 0", alignItems: "center" }}>
        <div className="wr-seg" role="group" aria-label="排序方式">
          <button className="wr-seg-btn" data-active={sortBy === "recent"} onClick={() => setSortBy("recent")}>
            最近
          </button>
          <button className="wr-seg-btn" data-active={sortBy === "title"} onClick={() => setSortBy("title")}>
            书名
          </button>
        </div>
        {groups.length > 0 ? (
          <select
            className="wr-select"
            aria-label="按分组筛选"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.currentTarget.value)}
            style={{ marginLeft: "auto", width: "auto" }}
          >
            <option value="全部">全部分组</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="wr-book-grid">
        {booksFiltered.map((b) => (
          <div key={b.id} className="wr-book-card" onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; navigate(`/read/${b.id}`); }}>
            <div className="wr-cover">
              {b.cover_path && coverUrls[b.cover_path] ? <img src={coverUrls[b.cover_path]} alt="" /> : null}
              {!b.cover_path || !coverUrls[b.cover_path] ? (
                <div className="wr-cover-text">
                  <div className="wr-cover-title">{formatTitle(b)}</div>
                  <div className="wr-cover-author">{formatAuthor(b)}</div>
                </div>
              ) : null}
            </div>

            <div className="wr-meta">
              <div className="wr-title">{formatTitle(b)}</div>
              <div className="wr-author">{formatAuthor(b)}</div>
              {b.note ? <div className="wr-note">{b.note}</div> : null}

              <div className="wr-chip-row">
                <div className="wr-chip">
                  <span className="wr-chip-dot" />
                  <span>{b.is_favorite ? "收藏" : "本地"}</span>
                </div>
                <div className="wr-chip" style={{ fontFamily: "var(--wr-mono)" }}>
                  {new Date(b.added_at * 1000).toLocaleDateString()}
                </div>
                {typeof b.reading_percent === "number" ? (
                  <div className="wr-chip">
                    <span className="wr-chip-dot" />
                    <span>读到 {Math.round(b.reading_percent * 100)}%</span>
                  </div>
                ) : null}
                <button
                  className="wr-chip wr-chip-btn"
                  aria-pressed={!!b.pinned_at}
                  data-pinned={!!b.pinned_at}
                  disabled={loading}
                  onClick={() => void onChipUpdate({ book_id: b.id, pinned: !b.pinned_at })}
                >
                  {b.pinned_at ? "已置顶" : "置顶"}
                </button>
                <button
                  className="wr-chip wr-chip-btn"
                  disabled={loading}
                  onClick={() => {
                    const v = window.prompt("分组名称（留空清除）", b.group_name ?? "");
                    if (v === null) return;
                    void onChipUpdate({ book_id: b.id, group_name: v });
                  }}
                >
                  {b.group_name || "分组"}
                </button>
                <button
                  className="wr-chip wr-chip-btn"
                  disabled={loading}
                  onClick={() => {
                    const v = window.prompt("备注（留空清除）", b.note ?? "");
                    if (v === null) return;
                    void onChipUpdate({ book_id: b.id, note: v });
                  }}
                >
                  {b.note ? "有备注" : "备注"}
                </button>
              </div>

              <div className="wr-actions">
                <button
                  className="wr-btn wr-btn-primary"
                  disabled={loading}
                  onClick={() => {
                    logFrontend(`ui: open book ${b.id}`);
                    navigate(`/read/${b.id}`);
                  }}
                >
                  打开
                </button>
                <button
                  className="wr-btn"
                  disabled={loading}
                  onClick={() => {
                    setLoading(true);
                    setBookFavorite(b.id, !b.is_favorite)
                      .then(() => refresh())
                      .finally(() => setLoading(false));
                  }}
                >
                  {b.is_favorite ? "取消收藏" : "收藏"}
                </button>
                <button className="wr-btn" disabled={loading} onClick={() => onDelete(b)}>
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {booksFiltered.length === 0 ? (
        <div className="wr-muted" style={{ padding: 16, gridColumn: "1 / -1" }}>
          {query.trim() ? "没有匹配的书籍" : "书架还是空的，从左下角导入第一本 EPUB 或 TXT 试试"}
        </div>
      ) : null}
    </AppShell>
  );
}
