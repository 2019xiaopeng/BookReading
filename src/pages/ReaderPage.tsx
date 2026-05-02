import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { Book } from "../tauri/invoke";
import {
  addBookmark,
  addHighlight,
  deleteBookmark,
  deleteHighlight,
  getReadingState,
  getSettings,
  listBooks,
  listBookmarks,
  listHighlights,
  setSetting,
  upsertReadingState,
  type Bookmark,
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
  const { bookId } = useParams();
  const [book, setBook] = useState<Book | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [percent, setPercent] = useState<number | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(defaultSettings);
  const [sideTab, setSideTab] = useState<"toc" | "bookmarks" | "highlights" | "search" | "settings">("toc");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<{ cfi: string; excerpt: string }[]>([]);
  const [isImmersive, setIsImmersive] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ReaderController | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const lastCfiRef = useRef<string | null>(null);

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
        onTocLoaded: (toc) => setToc(toc),
        onSelected: (cfiRange) => {
          void (async () => {
            const note = window.prompt("添加笔记（可空）", "") ;
            if (note === null) return;
            const h = await addHighlight(book.id, cfiRange, "#ffe600", note.trim() ? note : null);
            setHighlights((prev) => [h, ...prev]);
            controllerRef.current?.addHighlight(cfiRange);
          })();
        },
      });

      controllerRef.current.setTheme(settings.theme);
      controllerRef.current.setFontSizePercent(settings.fontSizePercent);

      const state = await getReadingState(book.id);
      if (state?.cfi) {
        await controllerRef.current.display(state.cfi);
        if (typeof state.percent === "number") setPercent(state.percent);
      }

      const [bm, hl] = await Promise.all([listBookmarks(book.id), listHighlights(book.id)]);
      setBookmarks(bm);
      setHighlights(hl);
      for (const h of hl) {
        controllerRef.current.addHighlight(h.cfi_range);
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
  }, [book, settings.theme, settings.fontSizePercent]);

  useEffect(() => {
    if (!controllerRef.current) return;
    controllerRef.current.setTheme(settings.theme);
    controllerRef.current.setFontSizePercent(settings.fontSizePercent);
  }, [settings.theme, settings.fontSizePercent]);

  async function persistSettings(next: ReaderSettings) {
    await setSetting("theme", next.theme);
    await setSetting("fontSizePercent", String(next.fontSizePercent));
    await setSetting("pageAnimation", next.pageAnimation);
  }

  function themeColors(theme: Theme): { bg: string; border: string; text: string; subText: string } {
    if (theme === "dark") {
      return { bg: "#0f1115", border: "rgba(255,255,255,0.12)", text: "#e8eaf0", subText: "rgba(232,234,240,0.7)" };
    }
    if (theme === "sepia") {
      return { bg: "#f7f1e1", border: "rgba(0,0,0,0.12)", text: "#2b2620", subText: "rgba(43,38,32,0.65)" };
    }
    return { bg: "#ffffff", border: "rgba(0,0,0,0.12)", text: "#111111", subText: "rgba(0,0,0,0.6)" };
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
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: themeColors(settings.theme).bg, color: themeColors(settings.theme).text }}>
      {!isImmersive ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, borderBottom: `1px solid ${themeColors(settings.theme).border}` }}>
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
          <div style={{ color: themeColors(settings.theme).subText, fontVariantNumeric: "tabular-nums" }}>
            {typeof percent === "number" ? `${Math.round(percent * 100)}%` : ""}
          </div>
        </div>
      ) : (
        <div style={{ height: 8 }} />
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {!isImmersive ? (
          <div style={{ width: 300, borderRight: `1px solid ${themeColors(settings.theme).border}`, padding: 12, overflow: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
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
                {toc.length === 0 ? (
                  <div style={{ color: themeColors(settings.theme).subText }}>加载中…</div>
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

            {sideTab === "search" ? (
              <SearchPanel
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

        <div ref={viewerRef} style={{ position: "relative", flex: 1, minWidth: 0, background: "white" }}>
          <div ref={containerRef} style={{ height: "100%", width: "100%", background: "transparent" }} />
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
