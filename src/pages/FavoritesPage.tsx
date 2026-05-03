import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { appDataDir } from "@tauri-apps/api/path";
import { BaseDirectory, readFile } from "@tauri-apps/plugin-fs";

import type { Book, FavoriteQuote } from "../tauri/invoke";
import { deleteFavoriteQuote, listBooks, listFavoriteBooks, listFavoriteQuotes, setBookFavorite } from "../tauri/invoke";

function extToMime(ext: string | null): string {
  const e = (ext ?? "").toLowerCase();
  if (e === "png") return "image/png";
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "webp") return "image/webp";
  return "application/octet-stream";
}

export default function FavoritesPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"books" | "quotes">("books");
  const [favoriteBooks, setFavoriteBooks] = useState<Book[]>([]);
  const [allBooks, setAllBooks] = useState<Book[]>([]);
  const [quotes, setQuotes] = useState<FavoriteQuote[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filterBookId, setFilterBookId] = useState<string | "all">("all");
  const [appDataBase, setAppDataBase] = useState<string | null>(null);
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});

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
    appDataDir().then((p) => setAppDataBase(p)).catch(() => {});
  }, []);

  function appDataRelativePath(absPath: string): string | null {
    if (!appDataBase) return null;
    const baseNorm = appDataBase.split("/").join("\\").replace(/\\+$/, "");
    const absNorm = absPath.split("/").join("\\");
    if (!absNorm.toLowerCase().startsWith(baseNorm.toLowerCase())) return null;
    return absNorm.slice(baseNorm.length).replace(/^\\+/, "");
  }

  useEffect(() => {
    if (!appDataBase) return;
    const abort = new AbortController();
    const pending: Promise<void>[] = [];

    for (const b of favoriteBooks) {
      if (!b.cover_path) continue;
      if (coverUrls[b.cover_path]) continue;
      const rel = appDataRelativePath(b.cover_path);
      if (!rel) continue;

      pending.push(
        (async () => {
          try {
            const bytes = await readFile(rel, { baseDir: BaseDirectory.AppData });
            if (abort.signal.aborted) return;
            const ext = b.cover_path?.split(".").pop() ?? null;
            const url = URL.createObjectURL(new Blob([bytes], { type: extToMime(ext) }));
            setCoverUrls((prev) => ({ ...prev, [b.cover_path as string]: url }));
          } catch {
          }
        })(),
      );
    }

    return () => {
      abort.abort();
      void Promise.allSettled(pending);
    };
  }, [favoriteBooks, appDataBase]);

  useEffect(() => {
    if (tab !== "quotes") return;
    setLoading(true);
    refreshQuotes().finally(() => setLoading(false));
  }, [tab, filterBookId]);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={() => navigate("/")}>返回书库</button>
        <div style={{ fontSize: 18, fontWeight: 600 }}>收藏</div>
        <div style={{ flex: 1 }} />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setTab("books")} disabled={tab === "books"}>
          收藏书籍
        </button>
        <button onClick={() => setTab("quotes")} disabled={tab === "quotes"}>
          收藏句子
        </button>
      </div>

      {tab === "books" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
          {favoriteBooks.map((b) => (
            <div
              key={b.id}
              style={{
                border: "1px solid rgba(0,0,0,0.12)",
                borderRadius: 10,
                padding: 12,
                display: "flex",
                gap: 12,
                background: "white",
              }}
            >
              <div
                style={{
                  width: 64,
                  height: 96,
                  borderRadius: 6,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "rgba(0,0,0,0.04)",
                  overflow: "hidden",
                  flexShrink: 0,
                }}
              >
                {b.cover_path && coverUrls[b.cover_path] ? (
                  <img
                    src={coverUrls[b.cover_path]}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : null}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {b.title?.trim() || "未命名"}
                </div>
                <div style={{ color: "rgba(0,0,0,0.65)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {b.author?.trim() || "未知作者"}
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
                  <button onClick={() => navigate(`/read/${b.id}`)} disabled={loading}>
                    打开
                  </button>
                  <button
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

          {favoriteBooks.length === 0 ? (
            <div style={{ color: "rgba(0,0,0,0.6)", padding: 16 }}>暂无收藏书籍</div>
          ) : null}
        </div>
      ) : null}

      {tab === "quotes" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="搜索收藏句子"
              style={{ flex: 1 }}
            />
            <select value={filterBookId} onChange={(e) => setFilterBookId(e.currentTarget.value as any)}>
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
            >
              搜索
            </button>
          </div>

          {quotes.length === 0 ? (
            <div style={{ color: "rgba(0,0,0,0.6)", padding: 16 }}>暂无收藏句子</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {quotes.map((q) => (
                <div
                  key={q.id}
                  style={{ border: "1px solid rgba(0,0,0,0.12)", borderRadius: 10, padding: 12, background: "white" }}
                >
                  <div style={{ color: "rgba(0,0,0,0.7)", fontSize: 12, marginBottom: 8 }}>
                    {bookIdToTitle.get(q.book_id) ?? q.book_id}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", color: "rgba(0,0,0,0.9)", marginBottom: 8 }}>
                    {q.text}
                  </div>
                  {q.note ? <div style={{ whiteSpace: "pre-wrap", color: "rgba(0,0,0,0.7)", marginBottom: 8 }}>{q.note}</div> : null}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => navigate(`/read/${q.book_id}?cfi=${encodeURIComponent(q.cfi_range)}`)}>
                      打开定位
                    </button>
                    <button
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
    </div>
  );
}
