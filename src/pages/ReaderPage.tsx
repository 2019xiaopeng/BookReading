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
import SelectionToolbar from "../reader/components/SelectionToolbar";
import { defaultSettings } from "../reader/settings/defaults";
import type { ReaderSettings, Theme } from "../reader/settings/types";
import { normalizeLayoutMode, resolveSpreadMode } from "../reader/settings/layoutMode";
import { calcPaperStage } from "../reader/ui/paperStage";
import { logFrontend } from "../tauri/frontendLog";
import Drawer from "../ui/Drawer";
import {
  IconBookmark,
  IconChevronLeft,
  IconChevronRight,
  IconHighlight,
  IconList,
  IconMoon,
  IconQuote,
  IconSearch,
  IconSettings,
} from "../ui/icons";

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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selection, setSelection] = useState<{ cfiRange: string; text: string } | null>(null);
  const [noteDraft, setNoteDraft] = useState<{ cfiRange: string; text: string } | null>(null);
  const [noteText, setNoteText] = useState("");
  const [immersiveHudVisible, setImmersiveHudVisible] = useState(false);
  const [viewerWidth, setViewerWidth] = useState<number>(() => window.innerWidth);
  const [viewerHeight, setViewerHeight] = useState<number>(() => window.innerHeight);
  const [pagerHover, setPagerHover] = useState<"left" | "right" | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ReaderController | null>(null);
  const settingsRef = useRef<ReaderSettings>(settings);
  const spreadModeRef = useRef<"none" | "both">("none");
  const locationSearchRef = useRef(location.search);
  const readerCreateCountRef = useRef(0);
  const lastUrlCfiRef = useRef<string | null>(null);
  const showImmersiveHudRef = useRef<(holdMs?: number) => void>(() => {});
  const persistTimerRef = useRef<number | null>(null);
  const lastCfiRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const wheelCooldownRef = useRef(0);
  const wheelAccumRef = useRef(0);
  const immersiveHudTimerRef = useRef<number | null>(null);

  useEffect(() => {
    (async () => {
      const books = await listBooks();
      const found = books.find((b) => b.id === bookId) ?? null;
      setBook(found);
    })();
  }, [bookId]);

  useEffect(() => {
    const update = () => {
      setViewerWidth(viewerRef.current?.clientWidth ?? window.innerWidth);
      setViewerHeight(viewerRef.current?.clientHeight ?? window.innerHeight);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const spreadMode = resolveSpreadMode(settings.layoutMode, viewerWidth);
  const edgeRatio = viewerWidth >= 1400 ? 0.2 : viewerWidth >= 1100 ? 0.18 : 0.16;
  const stage = calcPaperStage({ viewerWidth, viewerHeight, margin: 18, edgeRatio });
  const pagerEnabled = !drawerOpen && !readerError && !selection && !noteDraft;

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    spreadModeRef.current = spreadMode;
  }, [spreadMode]);

  useEffect(() => {
    locationSearchRef.current = location.search;
  }, [location.search]);

  useEffect(() => {
    (async () => {
      const map = await getSettings();
      const theme = (map.theme as Theme | undefined) ?? defaultSettings.theme;
      const fontSizePercent = Number(map.fontSizePercent ?? defaultSettings.fontSizePercent);
      const pageAnimation = (map.pageAnimation as any) ?? defaultSettings.pageAnimation;
      const layoutMode = normalizeLayoutMode(map.layoutMode);
      setSettings({
        theme,
        fontSizePercent: Number.isFinite(fontSizePercent) ? fontSizePercent : defaultSettings.fontSizePercent,
        pageAnimation,
        layoutMode,
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
        readerCreateCountRef.current += 1;
        logFrontend(`reader: create ${book.id} ${book.library_path} count=${readerCreateCountRef.current}`);
        controllerRef.current = await createReader({
          container: containerRef.current,
          libraryPath: book.library_path,
          spreadMode: spreadModeRef.current,
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
            logFrontend(`reader: onError ${book.id} ${msg}`);
            setReaderError(msg);
            setTocLoading(false);
          },
          onSelected: ({ cfiRange, text }) => {
            setSelection({ cfiRange, text: text.trim() ? text : "" });
          },
        });
      } catch (e) {
        logFrontend(`reader: create failed ${book.id} ${String(e)}`);
        setReaderError(String(e));
        setTocLoading(false);
        return;
      }

      controllerRef.current.setTheme(settingsRef.current.theme);
      controllerRef.current.setFontSizePercent(settingsRef.current.fontSizePercent);
      controllerRef.current.setSpreadMode(spreadModeRef.current);

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

      const cfiFromUrl = new URLSearchParams(locationSearchRef.current).get("cfi");
      if (!cfiFromUrl) {
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
  }, [book?.id]);

  useEffect(() => {
    const cfi = new URLSearchParams(location.search).get("cfi");
    if (!book || !cfi) return;
    if (!controllerRef.current) return;
    if (lastUrlCfiRef.current === cfi) return;
    lastUrlCfiRef.current = cfi;
    void controllerRef.current.display(cfi);
  }, [book?.id, location.search]);

  useEffect(() => {
    if (!controllerRef.current) return;
    controllerRef.current.setTheme(settings.theme);
    controllerRef.current.setFontSizePercent(settings.fontSizePercent);
    controllerRef.current.setSpreadMode(spreadMode);
  }, [settings.theme, settings.fontSizePercent, settings.layoutMode, spreadMode]);

  useEffect(() => {
    if (!isImmersive) {
      showImmersiveHudRef.current = () => {};
      setImmersiveHudVisible(false);
      if (immersiveHudTimerRef.current) {
        window.clearTimeout(immersiveHudTimerRef.current);
        immersiveHudTimerRef.current = null;
      }
      return;
    }

    const showHud = (holdMs = 2500) => {
      setImmersiveHudVisible(true);
      if (immersiveHudTimerRef.current) window.clearTimeout(immersiveHudTimerRef.current);
      immersiveHudTimerRef.current = window.setTimeout(() => {
        setImmersiveHudVisible(false);
        immersiveHudTimerRef.current = null;
      }, holdMs);
    };
    showImmersiveHudRef.current = showHud;

    const onMouseMove = (e: MouseEvent) => {
      if (e.clientY <= 56) showHud();
    };

    window.addEventListener("mousemove", onMouseMove);
    showHud();
    return () => {
      showImmersiveHudRef.current = () => {};
      window.removeEventListener("mousemove", onMouseMove);
      if (immersiveHudTimerRef.current) {
        window.clearTimeout(immersiveHudTimerRef.current);
        immersiveHudTimerRef.current = null;
      }
    };
  }, [isImmersive]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName?.toLowerCase();
      const isTyping = tag === "input" || tag === "textarea" || active?.isContentEditable;

      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setIsImmersive(false);
        setSideTab("search");
        setDrawerOpen(true);
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
        if (drawerOpen) {
          e.preventDefault();
          setDrawerOpen(false);
          return;
        }
        if (isImmersive) {
          e.preventDefault();
          setIsImmersive(false);
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [book, drawerOpen, isImmersive, settings.pageAnimation]);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const now = Date.now();
      if (now - wheelCooldownRef.current < 300) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX) * 1.2) return;
      if (Math.abs(e.deltaY) < 10) return;
      e.preventDefault();
      const d = e.deltaY;
      if ((wheelAccumRef.current > 0 && d < 0) || (wheelAccumRef.current < 0 && d > 0)) {
        wheelAccumRef.current = 0;
      }
      wheelAccumRef.current += d;
      if (Math.abs(wheelAccumRef.current) < 60) return;
      wheelCooldownRef.current = now;
      const dir = wheelAccumRef.current > 0 ? "next" : "prev";
      wheelAccumRef.current = 0;
      void animateTurn(dir);
    };

    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [settings.pageAnimation]);

  async function persistSettings(next: ReaderSettings) {
    await setSetting("theme", next.theme);
    await setSetting("fontSizePercent", String(next.fontSizePercent));
    await setSetting("pageAnimation", next.pageAnimation);
    await setSetting("layoutMode", next.layoutMode);
  }

  async function animateTurn(direction: "next" | "prev") {
    setSelection(null);
    setNoteDraft(null);
    const ctrl = controllerRef.current;
    const el = viewerRef.current;
    if (!ctrl) return;
    const run = async () => {
      try {
        await (direction === "next" ? ctrl.next() : ctrl.prev());
      } catch (e) {
        logFrontend(`reader: turn failed ${direction} ${String(e)}`);
      }
    };

    if (!el || settings.pageAnimation === "none") {
      await run();
      return;
    }

    if (settings.pageAnimation === "fade") {
      el.style.transition = "opacity 180ms ease";
      el.style.opacity = "0.35";
      await run();
      requestAnimationFrame(() => {
        el.style.opacity = "1";
      });
      return;
    }

    if (settings.pageAnimation === "slide") {
      el.style.transition = "transform 180ms ease";
      el.style.transform = direction === "next" ? "translateX(-2%)" : "translateX(2%)";
      await run();
      requestAnimationFrame(() => {
        el.style.transform = "translateX(0)";
      });
      return;
    }

    await run();
  }

  function openDrawer(tab: typeof sideTab) {
    setSideTab(tab);
    setIsImmersive(false);
    setDrawerOpen(true);
    if (tab === "search") requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  const drawerTitle =
    sideTab === "toc"
      ? "目录"
      : sideTab === "bookmarks"
        ? "书签"
        : sideTab === "highlights"
          ? "标注"
          : sideTab === "favorites"
            ? "收藏句子"
            : sideTab === "search"
              ? "搜索"
              : "阅读设置";

  return (
    <div
      data-theme={settings.theme}
      className="wr-reader-root"
    >
      {!isImmersive ? (
        <div className="wr-topbar wr-reader-topbar">
          <button className="wr-btn" onClick={() => navigate("/")}>
            返回书库
          </button>
          <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {book?.title ?? "阅读"}
          </div>
          <div style={{ flex: 1 }} />
          <button className="wr-btn wr-icon-btn" onClick={() => openDrawer("toc")}>
            <IconList />
            目录
          </button>
          <button className="wr-btn wr-icon-btn" onClick={() => openDrawer("bookmarks")}>
            <IconBookmark />
            书签
          </button>
          <button className="wr-btn wr-icon-btn" onClick={() => openDrawer("highlights")}>
            <IconHighlight />
            标注
          </button>
          <button className="wr-btn wr-icon-btn" onClick={() => openDrawer("favorites")}>
            <IconQuote />
            收藏
          </button>
          <button className="wr-btn wr-icon-btn" onClick={() => openDrawer("search")}>
            <IconSearch />
            搜索
          </button>
          <button className="wr-btn wr-icon-btn" onClick={() => openDrawer("settings")}>
            <IconSettings />
            设置
          </button>
          <button className="wr-btn wr-icon-btn" onClick={() => setIsImmersive(true)}>
            <IconMoon />
            沉浸
          </button>
          <div className="wr-muted" style={{ fontVariantNumeric: "tabular-nums" }}>
            {typeof percent === "number" ? `${Math.round(percent * 100)}%` : ""}
          </div>
        </div>
      ) : (
        <div style={{ height: 8 }} />
      )}

      <div className="wr-reader-stage">
        <div
          ref={viewerRef}
          className="wr-reader-viewer"
        >
          <Drawer
            open={drawerOpen && !isImmersive}
            title={drawerTitle}
            onClose={() => {
              setDrawerOpen(false);
            }}
          >
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
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {tocLoading ? (
                  <div className="wr-muted">加载中…</div>
                ) : toc.length === 0 ? (
                  <div className="wr-muted">暂无目录</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {toc.map((item) => (
                      <button
                        key={item.href}
                        className="wr-card"
                        style={{ textAlign: "left", cursor: "pointer" }}
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
                  void (async () => {
                    const bm = await addBookmark(book.id, cfi, null);
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
                {favoriteQuotes.length === 0 ? (
                  <div className="wr-muted">暂无收藏</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {favoriteQuotes.map((q) => (
                      <div key={q.id} className="wr-card" style={{ padding: 10 }}>
                        <div style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>{q.text}</div>
                        {q.note ? <div className="wr-muted" style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>{q.note}</div> : null}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="wr-btn" onClick={() => controllerRef.current?.display(q.cfi_range)}>
                            打开定位
                          </button>
                          <button
                            className="wr-btn"
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

            {sideTab === "highlights" && noteDraft ? (
              <div className="wr-card" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontWeight: 700 }}>添加笔记</div>
                <div className="wr-muted" style={{ whiteSpace: "pre-wrap" }}>
                  {noteDraft.text}
                </div>
                <textarea
                  className="wr-textarea"
                  value={noteText}
                  onChange={(e) => setNoteText(e.currentTarget.value)}
                  placeholder="写下你的想法（可空）"
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="wr-btn wr-btn-primary"
                    onClick={() => {
                      const d = noteDraft;
                      if (!book || !d) return;
                      void (async () => {
                        const h = await addHighlight(book.id, d.cfiRange, "#ffe600", noteText.trim() ? noteText : null);
                        setHighlights((prev) => [h, ...prev]);
                        controllerRef.current?.addHighlight(d.cfiRange);
                        setNoteDraft(null);
                        setNoteText("");
                        setSelection(null);
                      })();
                    }}
                  >
                    保存
                  </button>
                  <button
                    className="wr-btn"
                    onClick={() => {
                      setNoteDraft(null);
                      setNoteText("");
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}
          </Drawer>

          <div className="wr-reader-paper-wrap">
            <div
              ref={containerRef}
              className="wr-reader-paper"
            />
          </div>

          {pagerEnabled ? (
            <div style={{ position: "absolute", inset: 18, zIndex: 15, pointerEvents: "none", borderRadius: 22 }}>
              {pagerHover ? (
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: pagerHover === "left" ? 0 : "auto",
                    right: pagerHover === "right" ? 0 : "auto",
                    width: pagerHover === "left" ? stage.leftEdgeWidth : stage.rightEdgeWidth,
                    pointerEvents: "none",
                    background:
                      pagerHover === "left"
                        ? "linear-gradient(90deg, rgba(0,0,0,0.06), rgba(0,0,0,0))"
                        : "linear-gradient(270deg, rgba(0,0,0,0.06), rgba(0,0,0,0))",
                  }}
                />
              ) : null}
              <div
                onClick={() => {
                  void animateTurn("prev");
                }}
                onMouseEnter={() => setPagerHover("left")}
                onMouseLeave={() => setPagerHover(null)}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: stage.leftEdgeWidth,
                  cursor: "w-resize",
                  pointerEvents: "auto",
                }}
              />
              <div
                onClick={() => {
                  void animateTurn("next");
                }}
                onMouseEnter={() => setPagerHover("right")}
                onMouseLeave={() => setPagerHover(null)}
                style={{
                  position: "absolute",
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: stage.rightEdgeWidth,
                  cursor: "e-resize",
                  pointerEvents: "auto",
                }}
              />
            </div>
          ) : null}
          <SelectionToolbar
            open={!!selection && !drawerOpen && !readerError}
            text={selection?.text ?? ""}
            onHighlight={() => {
              const s = selection;
              if (!book || !s) return;
              void (async () => {
                const h = await addHighlight(book.id, s.cfiRange, "#ffe600", null);
                setHighlights((prev) => [h, ...prev]);
                controllerRef.current?.addHighlight(s.cfiRange);
                setSelection(null);
                openDrawer("highlights");
              })();
            }}
            onFavorite={() => {
              const s = selection;
              if (!book || !s) return;
              void (async () => {
                const q = await addFavoriteQuote(book.id, s.cfiRange, s.text, null);
                setFavoriteQuotes((prev) => [q, ...prev]);
                setSelection(null);
                openDrawer("favorites");
              })();
            }}
            onNote={() => {
              const s = selection;
              if (!s) return;
              setNoteDraft(s);
              setNoteText("");
              openDrawer("highlights");
            }}
            onClose={() => setSelection(null)}
          />
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
        </div>
      </div>

      {!isImmersive ? (
        <div
          className="wr-reader-footer"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 10,
            borderTop: "1px solid var(--wr-hairline)",
          }}
        >
          <button className="wr-btn wr-icon-btn" onClick={() => void animateTurn("prev")}>
            <IconChevronLeft />
            上一页
          </button>
          <button className="wr-btn wr-icon-btn" onClick={() => void animateTurn("next")}>
            <IconChevronRight />
            下一页
          </button>
          <div style={{ flex: 1 }} />
          <div className="wr-muted" style={{ fontVariantNumeric: "tabular-nums" }}>
            {typeof percent === "number" ? `${Math.round(percent * 100)}%` : ""}
          </div>
        </div>
      ) : null}

      {isImmersive ? (
        <div
          onMouseEnter={() => showImmersiveHudRef.current(10_000)}
          onMouseLeave={() => showImmersiveHudRef.current(900)}
          className="wr-immersive-hud"
          style={{
            pointerEvents: immersiveHudVisible ? "auto" : "none",
            opacity: immersiveHudVisible ? 1 : 0,
            transform: immersiveHudVisible ? "translateY(0)" : "translateY(-6px)",
          }}
        >
          <div className="wr-immersive-hud-card">
            <button
              className="wr-btn"
              onClick={() => {
                showImmersiveHudRef.current();
                setIsImmersive(false);
              }}
            >
              退出沉浸
            </button>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="wr-btn wr-icon-btn"
                onClick={() => {
                  showImmersiveHudRef.current();
                  openDrawer("toc");
                }}
              >
                <IconList />
                目录
              </button>
              <button
                className="wr-btn wr-icon-btn"
                onClick={() => {
                  showImmersiveHudRef.current();
                  void animateTurn("prev");
                }}
              >
                <IconChevronLeft />
                上一页
              </button>
              <button
                className="wr-btn wr-icon-btn"
                onClick={() => {
                  showImmersiveHudRef.current();
                  void animateTurn("next");
                }}
              >
                <IconChevronRight />
                下一页
              </button>
            </div>
            <div className="wr-muted" style={{ fontVariantNumeric: "tabular-nums", paddingRight: 6 }}>
              {typeof percent === "number" ? `${Math.round(percent * 100)}%` : ""}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
