import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { save } from "@tauri-apps/plugin-dialog";

import type { Book, FavoriteQuote } from "../tauri/invoke";
import {
  deleteFavoriteQuote,
  exportAnnotations,
  listBooks,
  listFavoriteBooks,
  listFavoriteQuotes,
  setBookFavorite,
} from "../tauri/invoke";
import { useCoverUrls } from "../library/useCoverUrls";
import AppShell from "../ui/AppShell";
import { showAlert, showConfirm } from "../ui/dialog";
import { IconBook, IconHeart, IconQuote, IconStar, IconTrash } from "../ui/icons";

export default function FavoritesPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"books" | "quotes">("books");
  const [favoriteBooks, setFavoriteBooks] = useState<Book[]>([]);
  const [allBooks, setAllBooks] = useState<Book[]>([]);
  const [quotes, setQuotes] = useState<FavoriteQuote[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filterBookId, setFilterBookId] = useState<string | "all">("all");
  const coverUrls = useCoverUrls(favoriteBooks);

  const bookIdToTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of allBooks) {
      map.set(b.id, b.title?.trim() || "未命名");
    }
    return map;
  }, [allBooks]);

  // E10：收藏书 tab 不再全量 listBooks（书名卡片自身就有 title）；allBooks 只服务摘录 tab（筛选下拉/书名映射），由 refreshQuotes 拉取
  async function refreshBooks() {
    setFavoriteBooks(await listFavoriteBooks());
  }

  async function refreshQuotes() {
    const all = await listBooks();
    setAllBooks(all);
    const list = await listFavoriteQuotes({
      bookId: filterBookId === "all" ? null : filterBookId,
      query: query.trim() ? query.trim() : null,
    });
    setQuotes(list);
  }

  useEffect(() => {
    setLoading(true);
    refreshBooks().finally(() => setLoading(false));
    // 刊头统计「摘录 N」首拉（进 quotes tab 时 refreshQuotes 会再刷新）
    void listFavoriteQuotes({ bookId: null, query: null }).then(setQuotes).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab !== "quotes") return;
    setLoading(true);
    refreshQuotes().finally(() => setLoading(false));
  }, [tab, filterBookId]);

  // silent refresh on window focus: returning to this page keeps data fresh (no manual refresh button)
  useEffect(() => {
    const onFocus = () => {
      if (tab === "books") void refreshBooks();
      else void refreshQuotes();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [tab, filterBookId, query]);

  const filteredBooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return favoriteBooks;
    return favoriteBooks.filter((b) => `${b.title ?? ""} ${b.author ?? ""}`.toLowerCase().includes(q));
  }, [favoriteBooks, query]);

  return (
    <AppShell
      active="favorites"
      title="收藏"
      search={{
        value: query,
        placeholder: tab === "books" ? "搜索书名 / 作者" : "搜索收藏句子",
        onChange: setQuery,
        onSubmit:
          tab === "quotes"
            ? () => {
                setLoading(true);
                refreshQuotes().finally(() => setLoading(false));
              }
            : undefined,
      }}
      seg={{
        items: [
          { key: "books", label: "收藏书籍" },
          { key: "quotes", label: "收藏句子" },
        ],
        active: tab,
        onChange: (k) => {
          if (k === "books" || k === "quotes") setTab(k);
        },
      }}
    >
      {/* M2 U5：小型刊头（书架刊头 60% 缩档）+ 统计列 */}
      <div className="wr-masthead wr-masthead--sm">
        <h1 className="wr-masthead-name">收 藏</h1>
        <div className="wr-masthead-stats">
          收藏 {favoriteBooks.length} · 摘录 {quotes.length}
        </div>
      </div>

      {tab === "books" ? (
        <div className="wr-book-grid">
          {filteredBooks.map((b) => (
            <div
              key={b.id}
              className="wr-book-card"
              role="button"
              tabIndex={0}
              onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; navigate(`/read/${b.id}`); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(`/read/${b.id}`);
                }
              }}
            >
              <div className="wr-cover">
                {b.cover_path && coverUrls[b.cover_path] ? <img src={coverUrls[b.cover_path]} alt="" /> : null}
                {!b.cover_path || !coverUrls[b.cover_path] ? (
                  <div className="wr-cover-text">
                    <div className="wr-cover-title">{b.title?.trim() || "未命名"}</div>
                    <div className="wr-cover-author">{b.author?.trim() || "未知作者"}</div>
                  </div>
                ) : null}
              </div>
              <div className="wr-meta">
                <div className="wr-title">{b.title?.trim() || "未命名"}</div>
                <div className="wr-author">{b.author?.trim() || "未知作者"}</div>
                <div className="wr-chip-row">
                  <div className="wr-chip">
                    <span>收藏</span>
                  </div>
                </div>
                <div className="wr-actions">
                  <button className="wr-btn wr-btn-primary" onClick={() => navigate(`/read/${b.id}`)} disabled={loading}>
                    打开
                  </button>
                  <button
                    className="wr-btn"
                    onClick={() => {
                      setLoading(true);
                      setBookFavorite(b.id, !b.is_favorite)
                        .then(() => refreshBooks())
                        .finally(() => setLoading(false));
                    }}
                    disabled={loading}
                  >
                    <IconHeart fill={b.is_favorite ? "currentColor" : "none"} aria-hidden />
                    <span>{b.is_favorite ? "已收藏" : "收藏"}</span>
                  </button>
                </div>
              </div>
            </div>
          ))}

          {filteredBooks.length === 0 ? (
            <div className="wr-state" style={{ gridColumn: "1 / -1" }}>
              <span className="wr-state-icon" aria-hidden="true">
                <IconStar />
              </span>
              {query.trim() ? (
                <>
                  <div className="wr-state-title">没有匹配的收藏</div>
                  <div className="wr-state-sub">换个书名或作者试试</div>
                </>
              ) : (
                <>
                  <div className="wr-state-title">还没有收藏书籍</div>
                  <div className="wr-state-sub">去书架点一本书的“收藏”试试</div>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "quotes" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 18 }}>
          <div className="wr-toolbar-row" style={{ padding: 0 }}>
            <select
              aria-label="按书籍筛选"
              className="wr-select"
              value={filterBookId}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setFilterBookId(v === "all" ? "all" : v);
              }}
            >
              <option value="all">全部书籍</option>
              {allBooks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title?.trim() || "未命名"}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                setLoading(true);
                refreshQuotes().finally(() => setLoading(false));
              }}
              disabled={loading}
              className="wr-btn wr-btn-primary"
            >
              搜索
            </button>
            {/* E4 导出全部标注/收藏（bookId=null 全书库） */}
            <button
              onClick={() => {
                void (async () => {
                  const dest = await save({
                    defaultPath: "收藏摘录.md",
                    filters: [{ name: "Markdown", extensions: ["md"] }],
                  });
                  if (typeof dest !== "string") return;
                  try {
                    const written = await exportAnnotations(null, dest);
                    await showAlert("导出成功", written);
                  } catch (e) {
                    await showAlert("导出失败", String(e));
                  }
                })();
              }}
              disabled={loading}
              className="wr-btn"
            >
              导出全部
            </button>
          </div>

          {quotes.length === 0 ? (
            <div className="wr-state">
              <span className="wr-state-icon" aria-hidden="true">
                <IconQuote />
              </span>
              {query.trim() || filterBookId !== "all" ? (
                <>
                  <div className="wr-state-title">没有匹配的收藏句子</div>
                  <div className="wr-state-sub">调整筛选或搜索词再试</div>
                </>
              ) : (
                <>
                  <div className="wr-state-title">还没有收藏句子</div>
                  <div className="wr-state-sub">阅读时选中一段文字试试</div>
                </>
              )}
            </div>
          ) : (
            <div className="wr-quote-list">
              {quotes.map((q) => {
                const src = bookIdToTitle.get(q.book_id) ?? q.book_id;
                return (
                  <div key={q.id} className="wr-card wr-quote-card">
                    <div className="wr-quote-text" title={q.text}>{q.text}</div>
                    {q.note ? <div className="wr-quote-note wr-muted" title={q.note}>{q.note}</div> : null}
                    <div className="wr-quote-foot">
                      <span className="wr-quote-src" title={src}>{src}</span>
                      <button
                        className="wr-mini-btn"
                        aria-label="打开定位"
                        title="打开定位"
                        onClick={() => navigate(`/read/${q.book_id}?cfi=${encodeURIComponent(q.cfi_range)}`)}
                      >
                        <IconBook width={16} height={16} />
                      </button>
                      <button
                        className="wr-mini-btn"
                        data-danger="true"
                        aria-label="删除收藏"
                        title="删除收藏"
                        disabled={loading}
                        onClick={async () => {
                          const ok = await showConfirm("删除收藏", "确定删除这条收藏吗？", { danger: true, confirmText: "删除" });
                          if (!ok) return;
                          setLoading(true);
                          deleteFavoriteQuote(q.id)
                            .then(() => refreshQuotes())
                            .finally(() => setLoading(false));
                        }}
                      >
                        <IconTrash width={16} height={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </AppShell>
  );
}
