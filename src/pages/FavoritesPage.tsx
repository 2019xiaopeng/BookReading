import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { Book, FavoriteQuote } from "../tauri/invoke";
import { deleteFavoriteQuote, listBooks, listFavoriteBooks, listFavoriteQuotes, setBookFavorite } from "../tauri/invoke";
import { useCoverUrls } from "../library/useCoverUrls";
import AppShell from "../ui/AppShell";

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

  async function refreshBooks() {
    const [fav, all] = await Promise.all([listFavoriteBooks(), listBooks()]);
    setFavoriteBooks(fav);
    setAllBooks(all);
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
  }, []);

  useEffect(() => {
    if (tab !== "quotes") return;
    setLoading(true);
    refreshQuotes().finally(() => setLoading(false));
  }, [tab, filterBookId]);

  const filteredBooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return favoriteBooks;
    return favoriteBooks.filter((b) => `${b.title ?? ""} ${b.author ?? ""}`.toLowerCase().includes(q));
  }, [favoriteBooks, query]);

  return (
    <AppShell
      active="favorites"
      title="收藏"
      search={{ value: query, placeholder: tab === "books" ? "搜索书名 / 作者" : "搜索收藏句子", onChange: setQuery }}
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
      sidebarFooter={
        <>
          <button className="wr-small-btn" onClick={() => navigate("/")}>
            返回书架
          </button>
          <button
            className="wr-small-btn wr-primary"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              refreshBooks().finally(() => setLoading(false));
            }}
          >
            刷新
          </button>
        </>
      }
    >
      {tab === "books" ? (
        <div className="wr-book-grid">
          {filteredBooks.map((b) => (
            <div key={b.id} className="wr-book-card">
              <div className="wr-cover">
                {b.cover_path && coverUrls[b.cover_path] ? <img src={coverUrls[b.cover_path]} alt="" /> : null}
                {!b.cover_path || !coverUrls[b.cover_path] ? (
                  <div className="wr-cover-letter">{(b.title?.trim() || "未").slice(0, 1)}</div>
                ) : null}
              </div>
              <div className="wr-meta">
                <div className="wr-title">{b.title?.trim() || "未命名"}</div>
                <div className="wr-author">{b.author?.trim() || "未知作者"}</div>
                <div className="wr-chip-row">
                  <div className="wr-chip">
                    <span className="wr-chip-dot" />
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
                      setBookFavorite(b.id, false)
                        .then(() => refreshBooks())
                        .finally(() => setLoading(false));
                    }}
                    disabled={loading}
                  >
                    取消收藏
                  </button>
                </div>
              </div>
            </div>
          ))}

          {filteredBooks.length === 0 ? (
            <div className="muted" style={{ padding: 16 }}>
              暂无收藏书籍
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "quotes" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 18 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
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
          </div>

          {quotes.length === 0 ? (
            <div className="muted" style={{ padding: 16 }}>
              暂无收藏句子
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {quotes.map((q) => (
                <div key={q.id} className="wr-card" style={{ padding: 12 }}>
                  <div className="wr-muted" style={{ fontFamily: "var(--wr-mono)", fontSize: 12, marginBottom: 8 }}>
                    {bookIdToTitle.get(q.book_id) ?? q.book_id}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>{q.text}</div>
                  {q.note ? <div className="wr-muted" style={{ whiteSpace: "pre-wrap", marginBottom: 10 }}>{q.note}</div> : null}
                  <div className="wr-actions">
                    <button className="wr-btn wr-btn-primary" onClick={() => navigate(`/read/${q.book_id}?cfi=${encodeURIComponent(q.cfi_range)}`)}>
                      打开定位
                    </button>
                    <button
                      className="wr-btn"
                      onClick={() => {
                        setLoading(true);
                        deleteFavoriteQuote(q.id)
                          .then(() => refreshQuotes())
                          .finally(() => setLoading(false));
                      }}
                      disabled={loading}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </AppShell>
  );
}
