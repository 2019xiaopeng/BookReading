import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import type { Book } from "../tauri/invoke";
import {
  addBookmark,
  addFavoriteQuote,
  addHighlight,
  deleteBookmark,
  deleteFavoriteQuote,
  deleteHighlight,
  getReadingState,
  getSettings,
  listBooks,
  listBookmarks,
  listFavoriteQuotes,
  listHighlights,
  setSetting,
  upsertReadingState,
  type Bookmark,
  type FavoriteQuote,
  type Highlight,
} from "../tauri/invoke";
import { createReader, type ReaderController, type TocItem } from "../reader/epub/reader";
import BookmarksPanel from "../reader/components/BookmarksPanel";
import HighlightsPanel from "../reader/components/HighlightsPanel";
import SearchPanel from "../reader/components/SearchPanel";
import SettingsPanel from "../reader/components/SettingsPanel";
import { defaultSettings } from "../reader/settings/defaults";
import type { ReaderSettings, Theme } from "../reader/settings/types";

export default function ReaderPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { bookId } = useParams();
  const [book, setBook] = useState<Book | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [tocLoading, setTocLoading] = useState(true);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(defaultSettings);
  const [sideTab, setSideTab] = useState<"toc" | "bookmarks" | "highlights" | "favorites" | "search" | "settings">("toc");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [favoriteQuotes, setFavoriteQuotes] = useState<FavoriteQuote[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<{ cfi: string; excerpt: string }[]>([]);
  const [isImmersive, setIsImmersive] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ReaderController | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const lastCfiRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const wheelCooldownRef = useRef(0);

  useEffect(() => {
    (async () => {
      const books = await listBooks();
      const found = books.find((b) => b.id === bookId) ?? null;
      setBook(found);
    })();
  }, [bookId]);

  useEffect(() => {
    (async () => {
      const map = await getSettings();
      const theme = (map.theme as Theme | undefined) ?? defaultSettings.theme;
      const fontSizePercent = Number(map.fontSizePercent ?? defaultSettings.fontSizePercent);
      const pageAnimation = (map.pageAnimation as any) ?? defaultSettings.pageAnimation;
      setSettings({
        theme,
        fontSizePercent: Number.isFinite(fontSizePercent) ? fontSizePercent : defaultSettings.fontSizePercent,
        pageAnimation,
      });
    })();
  }, []);

  useEffect(() => {
    (async () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
      if (!book) return;
      if (!containerRef.current) return;

      containerRef.current.innerHTML = "";
      setReaderError(null);
      setToc([]);
      setTocLoading(true);

      try {
        controllerRef.current = await createReader({
          container: containerRef.current,
          libraryPath: book.library_path,
          onRelocated: ({ cfi, percent }) => {
            lastCfiRef.current = cfi;
            if (typeof percent === "number") setPercent(percent);

            if (persistTimerRef.current) {
              window.clearTimeout(persistTimerRef.current);
            }
            persistTimerRef.current = window.setTimeout(() => {
              const lastCfi = lastCfiRef.current;
              if (!lastCfi) return;
              void upsertReadingState(book.id, lastCfi, typeof percent === "number" ? percent : null);
            }, 1500);
          },
          onTocLoaded: (toc) => {
            setToc(toc);
            setTocLoading(false);
          },
          onError: (msg) => {
            setReaderError(msg);
            setTocLoading(false);
          },
          onSelected: ({ cfiRange, text }) => {
            void (async () => {
              const useFavorite = window.confirm("是否将选中文本加入收藏？\n确定=收藏句子，取消=高亮标注");
              if (useFavorite) {
                const note = window.prompt("收藏备注（可空）", "");
                if (note === null) return;
                const q = await addFavoriteQuote(
                  book.id,
                  cfiRange,
                  text.trim() ? text : "",
                  note.trim() ? note : null,
                );
                setFavoriteQuotes((prev) => [q, ...prev]);
                setSideTab("favorites");
              } else {
                const note = window.prompt("添加笔记（可空）", "");
                if (note === null) return;
                const h = await addHighlight(book.id, cfiRange, "#ffe600", note.trim() ? note : null);
                setHighlights((prev) => [h, ...prev]);
                controllerRef.current?.addHighlight(cfiRange);
                setSideTab("highlights");
              }
            })();
          },
        });
      } catch (e) {
        setReaderError(String(e));
        setTocLoading(false);
        return;
      }

      controllerRef.current.setTheme(settings.theme);
      controllerRef.current.setFontSizePercent(settings.fontSizePercent);

      const [bm, hl, fav] = await Promise.all([
        listBookmarks(book.id),
        listHighlights(book.id),
        listFavoriteQuotes({ bookId: book.id }),
      ]);
      setBookmarks(bm);
      setHighlights(hl);
      setFavoriteQuotes(fav);
      for (const h of hl) {
        controllerRef.current.addHighlight(h.cfi_range);
      }

      const cfiFromUrl = new URLSearchParams(location.search).get("cfi");
      if (cfiFromUrl) {
        await controllerRef.current.display(cfiFromUrl);
      } else {
        const state = await getReadingState(book.id);
        if (state?.cfi) {
          await controllerRef.current.display(state.cfi);
          if (typeof state.percent === "number") setPercent(state.percent);
        }
      }
    })();

    return () => {
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [book, settings.theme, settings.fontSizePercent, location.search]);

  useEffect(() => {
    if (!controllerRef.current) return;
    controllerRef.current.setTheme(settings.theme);
    controllerRef.current.setFontSizePercent(settings.fontSizePercent);
  }, [settings.theme, settings.fontSizePercent]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName?.toLowerCase();
      const isTyping = tag === "input" || tag === "textarea" || active?.isContentEditable;

      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setIsImmersive(false);
        setSideTab("search");
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }

      if (e.ctrlKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setIsImmersive((v) => !v);
        return;
      }

      if (e.ctrlKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        const cfi = lastCfiRef.current;
        if (!book || !cfi) return;
        void (async () => {
          const bm = await addBookmark(book.id, cfi, null);
          setBookmarks((prev) => [bm, ...prev]);
          setSideTab("bookmarks");
        })();
        return;
      }

      if (isTyping) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        void animateTurn("prev");
        return;
      }

      if (e.key === "ArrowRight") {
        e.preventDefault();
        void animateTurn("next");
        return;
      }

      if (e.key === "Escape") {
        if (isImmersive) {
          e.preventDefault();
          setIsImmersive(false);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [book, isImmersive, settings.pageAnimation]);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const now = Date.now();
      if (now - wheelCooldownRef.current < 300) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      wheelCooldownRef.current = now;
      void animateTurn(e.deltaY > 0 ? "next" : "prev");
    };

    const onDblClick = () => {
      setIsImmersive((v) => !v);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("dblclick", onDblClick);

    return () => {
      el.removeEventListener("wheel", onWheel as any);
      el.removeEventListener("dblclick", onDblClick);
    };
  }, [settings.pageAnimation]);

  async function persistSettings(next: ReaderSettings) {
    await setSetting("theme", next.theme);
    await setSetting("fontSizePercent", String(next.fontSizePercent));
    await setSetting("pageAnimation", next.pageAnimation);
  }

  async function animateTurn(direction: "next" | "prev") {
    const ctrl = controllerRef.current;
    const el = viewerRef.current;
    if (!ctrl) return;
    if (!el || settings.pageAnimation === "none") {
      await (direction === "next" ? ctrl.next() : ctrl.prev());
      return;
    }

    if (settings.pageAnimation === "fade") {
      el.style.transition = "opacity 180ms ease";
      el.style.opacity = "0.35";
      await (direction === "next" ? ctrl.next() : ctrl.prev());
      requestAnimationFrame(() => {
        el.style.opacity = "1";
      });
      return;
    }

    if (settings.pageAnimation === "slide") {
      el.style.transition = "transform 180ms ease";
      el.style.transform = direction === "next" ? "translateX(-2%)" : "translateX(2%)";
      await (direction === "next" ? ctrl.next() : ctrl.prev());
      requestAnimationFrame(() => {
        el.style.transform = "translateX(0)";
      });
      return;
    }

    await (direction === "next" ? ctrl.next() : ctrl.prev());
  }

  return (
    <div data-theme={settings.theme} style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {!isImmersive ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, borderBottom: "1px solid var(--border)" }}>
          <button onClick={() => navigate("/")}>返回书库</button>
          <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {book?.title ?? "阅读"}
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => {
              setSideTab("bookmarks");
            }}
          >
            书签
          </button>
          <button
            onClick={() => {
              setSideTab("highlights");
            }}
          >
            标注
          </button>
          <button
            onClick={() => {
              setSideTab("favorites");
            }}
          >
            收藏
          </button>
          <button
            onClick={() => {
              setSideTab("search");
            }}
          >
            搜索
          </button>
          <button
            onClick={() => {
              setSideTab("settings");
            }}
          >
            设置
          </button>
          <button onClick={() => setIsImmersive(true)}>沉浸</button>
          <div style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
            {typeof percent === "number" ? `${Math.round(percent * 100)}%` : ""}
          </div>
        </div>
      ) : (
        <div style={{ height: 8 }} />
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {!isImmersive ? (
          <div style={{ width: 300, borderRight: "1px solid var(--border)", padding: 12, overflow: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setSideTab("toc")} disabled={sideTab === "toc"}>
                目录
              </button>
              <button onClick={() => setSideTab("bookmarks")} disabled={sideTab === "bookmarks"}>
                书签
              </button>
              <button onClick={() => setSideTab("highlights")} disabled={sideTab === "highlights"}>
                标注
              </button>
              <button onClick={() => setSideTab("favorites")} disabled={sideTab === "favorites"}>
                收藏
              </button>
              <button onClick={() => setSideTab("search")} disabled={sideTab === "search"}>
                搜索
              </button>
              <button onClick={() => setSideTab("settings")} disabled={sideTab === "settings"}>
                设置
              </button>
            </div>

            {sideTab === "settings" ? (
              <SettingsPanel
                value={settings}
                onChange={(next) => {
                  setSettings(next);
                  void persistSettings(next);
                }}
              />
            ) : null}

            {sideTab === "toc" ? (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>目录</div>
                {tocLoading ? (
                  <div style={{ color: "var(--text-muted)" }}>加载中…</div>
                ) : toc.length === 0 ? (
                  <div style={{ color: "var(--text-muted)" }}>暂无目录</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {toc.map((item) => (
                      <button
                        key={item.href}
                        style={{ textAlign: "left" }}
                        onClick={() => controllerRef.current?.display(item.href)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {sideTab === "bookmarks" ? (
              <BookmarksPanel
                items={bookmarks}
                onAdd={() => {
                  const cfi = lastCfiRef.current;
                  if (!book || !cfi) return;
                  const label = window.prompt("书签名称（可空）", "") ;
                  if (label === null) return;
                  void (async () => {
                    const bm = await addBookmark(book.id, cfi, label.trim() ? label : null);
                    setBookmarks((prev) => [bm, ...prev]);
                  })();
                }}
                onOpen={(cfi) => controllerRef.current?.display(cfi)}
                onDelete={(id) => {
                  void (async () => {
                    await deleteBookmark(id);
                    setBookmarks((prev) => prev.filter((b) => b.id !== id));
                  })();
                }}
              />
            ) : null}

            {sideTab === "highlights" ? (
              <HighlightsPanel
                items={highlights}
                onOpen={(cfiRange) => controllerRef.current?.display(cfiRange)}
                onDelete={(id) => {
                  const h = highlights.find((x) => x.id === id);
                  void (async () => {
                    await deleteHighlight(id);
                    setHighlights((prev) => prev.filter((x) => x.id !== id));
                    if (h) controllerRef.current?.removeHighlight(h.cfi_range);
                  })();
                }}
              />
            ) : null}

            {sideTab === "favorites" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontWeight: 600 }}>收藏句子</div>
                {favoriteQuotes.length === 0 ? (
                  <div style={{ color: "rgba(0,0,0,0.6)" }}>暂无收藏</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {favoriteQuotes.map((q) => (
                      <div
                        key={q.id}
                        style={{
                          border: "1px solid rgba(0,0,0,0.12)",
                          borderRadius: 10,
                          padding: 10,
                          background: "white",
                        }}
                      >
                        <div style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>{q.text}</div>
                        {q.note ? <div style={{ whiteSpace: "pre-wrap", color: "rgba(0,0,0,0.7)", marginBottom: 8 }}>{q.note}</div> : null}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button onClick={() => controllerRef.current?.display(q.cfi_range)}>打开定位</button>
                          <button
                            onClick={() => {
                              void (async () => {
                                await deleteFavoriteQuote(q.id);
                                setFavoriteQuotes((prev) => prev.filter((x) => x.id !== q.id));
                              })();
                            }}
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

            {sideTab === "search" ? (
              <SearchPanel
                inputRef={searchInputRef}
                query={searchQuery}
                onQueryChange={setSearchQuery}
                loading={searchLoading}
                results={searchResults}
                onSearch={() => {
                  void (async () => {
                    const ctrl = controllerRef.current;
                    if (!ctrl) return;
                    setSearchLoading(true);
                    try {
                      const res = await ctrl.search(searchQuery);
                      setSearchResults(res);
                    } finally {
                      setSearchLoading(false);
                    }
                  })();
                }}
                onOpen={(cfi) => controllerRef.current?.display(cfi)}
              />
            ) : null}
          </div>
        ) : null}

        <div ref={viewerRef} style={{ position: "relative", flex: 1, minWidth: 0, background: "var(--panel-solid)" }}>
          <div ref={containerRef} style={{ height: "100%", width: "100%", background: "transparent" }} />
          {readerError ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
                background: "rgba(0,0,0,0.45)",
                zIndex: 10,
              }}
            >
              <div style={{ maxWidth: 720, width: "100%", border: "1px solid var(--border)", borderRadius: 14, padding: 14, background: "var(--panel-solid)", boxShadow: "var(--shadow-sm)" }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>加载失败</div>
                <div style={{ whiteSpace: "pre-wrap", color: "var(--text-muted)", marginBottom: 12 }}>{readerError}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => {
                      void navigator.clipboard?.writeText(readerError);
                    }}
                    className="btn-primary"
                  >
                    复制错误
                  </button>
                  <button
                    onClick={() => {
                      setReaderError(null);
                      setTocLoading(true);
                      controllerRef.current?.display();
                    }}
                    className="btn-primary"
                  >
                    重试
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          <div
            style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "1fr 1fr" }}
          >
            <div
              onClick={() => {
                if (isImmersive) setIsImmersive(false);
                void animateTurn("prev");
              }}
              style={{ cursor: "w-resize" }}
            />
            <div
              onClick={() => {
                if (isImmersive) setIsImmersive(false);
                void animateTurn("next");
              }}
              style={{ cursor: "e-resize" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
