import { useEffect, useMemo, useRef, useState } from "react";
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
import { createReader, type ReaderController, type SearchResult, type SelectionRect, type TocItem } from "../reader/epub/reader";
import { tocLabelFor } from "../reader/epub/tocLabel";
import BookmarksPanel from "../reader/components/BookmarksPanel";
import HighlightsPanel from "../reader/components/HighlightsPanel";
import SearchPanel from "../reader/components/SearchPanel";
import SettingsPanel from "../reader/components/SettingsPanel";
import SelectionToolbar from "../reader/components/SelectionToolbar";
import ImageReader, { type ImageReaderApi } from "../reader/image/ImageReader";
import ImageSettingsPanel from "../reader/image/ImageSettingsPanel";
import PagesPanel from "../reader/image/PagesPanel";
import {
  defaultImageReaderSettings,
  imageCfi,
  normalizeImageReaderSettings,
  pagePercent,
  turnKeyDirection,
  type ImageReaderSettings,
} from "../reader/image/layout";
import { defaultSettings, HIGHLIGHT_COLOR } from "../reader/settings/defaults";
import type { ReaderSettings } from "../reader/settings/types";
import { normalizeLayoutMode, resolveSpreadMode } from "../reader/settings/layoutMode";
import {
  normalizeLineHeight,
  normalizePageAnimation,
  normalizeReaderBackground,
  normalizeReadingMode,
  normalizeTheme,
} from "../reader/settings/normalize";
import { calcPaperStage } from "../reader/ui/paperStage";
import { logFrontend } from "../tauri/frontendLog";
import { extToMime, readAppDataBlobUrl, revokeObjectUrl } from "../tauri/appDataPaths";
import Drawer from "../ui/Drawer";
import { useElementSize } from "../ui/useElementSize";
import {
  IconBookmark,
  IconChevronLeft,
  IconChevronRight,
  IconHighlight,
  IconImage,
  IconList,
  IconMoon,
  IconQuote,
  IconSearch,
  IconSettings,
} from "../ui/icons";

// single-slot blob URL cache for the custom reader background (revoked on swap or unmount)
let readerBgCache: { path: string; url: string } | null = null;

export default function ReaderPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { bookId } = useParams();
  const [book, setBook] = useState<Book | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [tocLoading, setTocLoading] = useState(true);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [errorCopied, setErrorCopied] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [annotationsLoaded, setAnnotationsLoaded] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(() => ({
    ...defaultSettings,
    theme: normalizeTheme(localStorage.getItem("wr-theme")),
  }));
  const [imageSettings, setImageSettings] = useState<ImageReaderSettings>(defaultImageReaderSettings);
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [imagePage, setImagePage] = useState<{ page: number; pageCount: number } | null>(null);
  const [sideTab, setSideTab] = useState<"toc" | "bookmarks" | "highlights" | "favorites" | "search" | "settings" | "pages">("toc");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [favoriteQuotes, setFavoriteQuotes] = useState<FavoriteQuote[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [isImmersive, setIsImmersive] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selection, setSelection] = useState<{ cfiRange: string; text: string; rect: SelectionRect | null } | null>(null);
  const [noteDraft, setNoteDraft] = useState<{ cfiRange: string; text: string } | null>(null);
  const [noteText, setNoteText] = useState("");
  const [immersiveHudVisible, setImmersiveHudVisible] = useState(false);
  const [pagerHover, setPagerHover] = useState<"left" | "right" | null>(null);
  const [locationsReady, setLocationsReady] = useState(false);
  const [dragPct, setDragPct] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const viewerSize = useElementSize(viewerRef);
  const controllerRef = useRef<ReaderController | null>(null);
  const settingsRef = useRef<ReaderSettings>(settings);
  const spreadModeRef = useRef<"none" | "always">("none");
  const locationSearchRef = useRef(location.search);
  const showImmersiveHudRef = useRef<(holdMs?: number) => void>(() => {});
  const persistTimerRef = useRef<number | null>(null);
  const lastCfiRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  const chapterRef = useRef("");
  const settingsTouchedRef = useRef(false);
  const searchSeqRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const wheelCooldownRef = useRef(0);
  const wheelAccumRef = useRef(0);
  const immersiveHudTimerRef = useRef<number | null>(null);
  const imageApiRef = useRef<ImageReaderApi | null>(null);
  const imageCtxRef = useRef({ active: false, rtl: false, webtoon: false });
  const progressRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const books = await listBooks();
      if (cancelled) return;
      const found = books.find((b) => b.id === bookId) ?? null;
      setBook(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const viewerWidth = viewerSize.width || window.innerWidth;
  const viewerHeight = viewerSize.height || window.innerHeight;
  const spreadMode = resolveSpreadMode(settings.layoutMode, viewerWidth);
  const edgeRatio = viewerWidth >= 1400 ? 0.2 : viewerWidth >= 1100 ? 0.18 : 0.16;
  const stage = calcPaperStage({ viewerWidth, viewerHeight, margin: 18, edgeRatio });
  const isImageBook = book?.format === "images";
  const imageEdgeSwap = isImageBook && imageSettings.rtl;
  const pagerEnabled =
    !drawerOpen &&
    !readerError &&
    !selection &&
    !noteDraft &&
    (isImageBook || settings.readingMode === "paginated") &&
    !(isImageBook && imageSettings.mode === "webtoon");

  const flatToc = useMemo(() => {
    const out: TocItem[] = [];
    const walk = (xs: TocItem[]) => {
      for (const x of xs) {
        out.push(x);
        if (x.subitems?.length) walk(x.subitems);
      }
    };
    walk(toc);
    return out;
  }, [toc]);

  const chapterLabel = () => tocLabelFor(flatToc, chapterRef.current);

  const searchRows = useMemo(
    () => searchResults.map((r) => ({ ...r, chapter: tocLabelFor(flatToc, r.sectionHref) ?? "正文" })),
    [searchResults, flatToc],
  );

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    localStorage.setItem("wr-theme", settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    spreadModeRef.current = spreadMode;
  }, [spreadMode]);

  useEffect(() => {
    imageCtxRef.current = { active: isImageBook, rtl: imageSettings.rtl, webtoon: imageSettings.mode === "webtoon" };
  }, [isImageBook, imageSettings]);

  useEffect(() => {
    locationSearchRef.current = location.search;
  }, [location.search]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map = await getSettings();
      if (cancelled) return;
      if (settingsTouchedRef.current) return;
      const theme = normalizeTheme(map.theme);
      const fontSizePercent = Number(map.fontSizePercent ?? defaultSettings.fontSizePercent);
      const pageAnimation = normalizePageAnimation(map.pageAnimation);
      const layoutMode = normalizeLayoutMode(map.layoutMode);
      const lineHeight = normalizeLineHeight(map.lineHeight);
      setSettings({
        theme,
        fontSizePercent: Number.isFinite(fontSizePercent)
          ? Math.min(200, Math.max(80, fontSizePercent))
          : defaultSettings.fontSizePercent,
        pageAnimation,
        layoutMode,
        lineHeight,
        readingMode: normalizeReadingMode(map.readingMode),
        reader_bg: normalizeReaderBackground(map.reader_bg),
      });
      setImageSettings(normalizeImageReaderSettings(map.image_reader_settings));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!book) return;
      if (book.format === "images") {
        setImagePage(null);
        setTocLoading(false);
        return;
      }
      if (!containerRef.current) return;

      const container = containerRef.current;
      container.innerHTML = "";
      setReaderError(null);
      setLocationsReady(false);
      setDragPct(null);
      restoredRef.current = false;
      setAnnotationsLoaded(false);
      setToc([]);
      setTocLoading(true);

      const onRelocated = ({ cfi, percent, href }: { cfi: string; percent: number | null; href: string }) => {
        if (cancelled) return;
        lastCfiRef.current = cfi;
        chapterRef.current = href;
        if (typeof percent === "number") setPercent(percent);
        setDragPct(null);
        setSelection(null);
        if (!restoredRef.current) return;

        if (persistTimerRef.current) {
          window.clearTimeout(persistTimerRef.current);
        }
        persistTimerRef.current = window.setTimeout(() => {
          const lastCfi = lastCfiRef.current;
          if (!lastCfi) return;
          void upsertReadingState(book.id, lastCfi, typeof percent === "number" ? percent : null);
        }, 1500);
      };

      const onTocLoaded = (toc: TocItem[]) => {
        if (cancelled) return;
        setToc(toc);
        setTocLoading(false);
      };

      const onError = (msg: string) => {
        logFrontend(`reader: onError ${book.id} ${msg}`);
        if (cancelled) return;
        setReaderError(msg);
        setTocLoading(false);
      };

      const onSelected = ({ cfiRange, text, rect }: { cfiRange: string; text: string; rect: SelectionRect | null }) => {
        if (cancelled) return;
        if (!text.trim()) {
          setSelection(null);
          return;
        }
        setSelection({ cfiRange, text, rect });
      };

      let ctrl: ReaderController | null = null;
      try {
        logFrontend(`reader: create ${book.id} ${book.library_path}`);
        ctrl = await createReader({
          container,
          libraryPath: book.library_path,
          spreadMode: spreadModeRef.current,
          readingMode: settingsRef.current.readingMode,
          onRelocated,
          onTocLoaded,
          onSelected,
          onLocationsReady: () => {
            if (!cancelled) setLocationsReady(true);
          },
          // iframe 内按下（含开始新选区）即收起旧气泡
          onContentsPress: () => setSelection(null),
          onError,
        });
      } catch (e) {
        logFrontend(`reader: create failed ${book.id} ${String(e)}`);
        if (cancelled) return;
        setReaderError(String(e));
        setTocLoading(false);
        return;
      }

      if (cancelled) {
        ctrl.destroy();
        return;
      }

      controllerRef.current = ctrl;
      ctrl.setTheme(settingsRef.current.theme);
      ctrl.setFontSizePercent(settingsRef.current.fontSizePercent);
      ctrl.setLineHeight(settingsRef.current.lineHeight);
      if (settingsRef.current.readingMode !== "scrolled") ctrl.setSpreadMode(spreadModeRef.current);

      try {
        const [bm, hl, fav] = await Promise.all([
          listBookmarks(book.id),
          listHighlights(book.id),
          listFavoriteQuotes({ bookId: book.id }),
        ]);
        if (cancelled) return;
        setBookmarks(bm);
        setHighlights(hl);
        setFavoriteQuotes(fav);
        for (const h of hl) {
          ctrl.addHighlight(h.cfi_range);
        }
      } catch (e) {
        logFrontend(`reader: annotations load failed ${book.id} ${String(e)}`);
      }
      setAnnotationsLoaded(true);

      const cfiFromUrl = new URLSearchParams(locationSearchRef.current).get("cfi");
      if (cfiFromUrl) {
        await ctrl.display(cfiFromUrl);
        restoredRef.current = true;
        return;
      }
      const state = await getReadingState(book.id);
      if (cancelled) return;
      if (state?.cfi) {
        await ctrl.display(state.cfi);
        if (typeof state.percent === "number") setPercent(state.percent);
      }
      restoredRef.current = true;
    })();

    return () => {
      cancelled = true;
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [book?.id, retryKey]);

  useEffect(() => {
    if (!book) return;
    const flush = () => {
      const cfi = lastCfiRef.current;
      if (!cfi) return;
      void upsertReadingState(book.id, cfi, null);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [book?.id]);

  useEffect(() => {
    if (!controllerRef.current) return;
    controllerRef.current.setTheme(settings.theme);
    controllerRef.current.setFontSizePercent(settings.fontSizePercent);
    controllerRef.current.setLineHeight(settings.lineHeight);
    // scrolled 模式下分栏失效，跳过 spread 以免与 epubjs scrolled 冲突
    if (settings.readingMode !== "scrolled") controllerRef.current.setSpreadMode(spreadMode);
  }, [settings.theme, settings.fontSizePercent, settings.lineHeight, settings.layoutMode, spreadMode, settings.readingMode]);

  useEffect(() => {
    controllerRef.current?.setReadingMode(settings.readingMode);
  }, [settings.readingMode]);

  useEffect(() => {
    const bg = settings.reader_bg;
    if (isImageBook || bg.type !== "image") {
      setBgUrl(null);
      return;
    }
    if (readerBgCache?.path === bg.path) {
      setBgUrl(readerBgCache.url);
      return;
    }
    let cancelled = false;
    const ext = bg.path.split(".").pop() ?? "";
    void readAppDataBlobUrl(bg.path, extToMime(ext))
      .then((url) => {
        if (cancelled) {
          revokeObjectUrl(url);
          return;
        }
        if (readerBgCache) revokeObjectUrl(readerBgCache.url);
        readerBgCache = { path: bg.path, url };
        setBgUrl(url);
      })
      .catch((e) => {
        logFrontend(`reader: bg load failed ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [settings.reader_bg, isImageBook]);

  useEffect(() => {
    return () => {
      revokeObjectUrl(readerBgCache?.url ?? null);
      readerBgCache = null;
    };
  }, []);

  useEffect(() => {
    if (isImmersive) setDrawerOpen(false);
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

      if (e.ctrlKey && e.key.toLowerCase() === "f" && !imageCtxRef.current.active) {
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

      if (e.ctrlKey && e.key.toLowerCase() === "b" && !imageCtxRef.current.active) {
        e.preventDefault();
        const cfi = lastCfiRef.current;
        if (!book || !cfi) return;
        void (async () => {
          const bm = await addBookmark(book.id, cfi, chapterLabel());
          setBookmarks((prev) => (prev.some((x) => x.cfi === bm.cfi) ? prev : [bm, ...prev]));
          setSideTab("bookmarks");
        })();
        return;
      }

      if (isTyping) return;

      if (imageCtxRef.current.active) {
        const imageDir = turnKeyDirection(e.key, imageCtxRef.current.rtl);
        if (imageDir) {
          e.preventDefault();
          void animateTurn(imageDir);
          return;
        }
      } else if (
        !imageCtxRef.current.active &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "PageUp" || e.key === "PageDown")
      ) {
        // 分页=翻页；滚动模式由 animateTurn 内部分流为章节导航
        e.preventDefault();
        void animateTurn(e.key === "ArrowLeft" || e.key === "PageUp" ? "prev" : "next");
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
  }, [book, drawerOpen, isImmersive, settings.pageAnimation, settings.readingMode, toc]);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (drawerOpen) return;
      // epub 滚动模式下 wheel 交给 iframe 原生滚动
      if (!imageCtxRef.current.active && settingsRef.current.readingMode !== "paginated") return;
      if (imageCtxRef.current.active && imageCtxRef.current.webtoon) return;
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
  }, [drawerOpen, settings.pageAnimation]);

  async function persistSettings(next: ReaderSettings) {
    settingsTouchedRef.current = true;
    await setSetting("theme", next.theme);
    await setSetting("fontSizePercent", String(next.fontSizePercent));
    await setSetting("pageAnimation", next.pageAnimation);
    await setSetting("layoutMode", next.layoutMode);
    await setSetting("lineHeight", String(next.lineHeight));
    await setSetting("readingMode", next.readingMode);
    await setSetting("reader_bg", JSON.stringify(next.reader_bg));
  }

  function handleImageRelocated(page: number, pageCount: number) {
    if (!book) return;
    const cfi = imageCfi(page);
    const pct = pagePercent(page, pageCount);
    lastCfiRef.current = cfi;
    setPercent(pct);
    setImagePage({ page, pageCount });
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      void upsertReadingState(book.id, cfi, pct);
    }, 1500);
  }

  async function animateTurn(direction: "next" | "prev") {
    setSelection(null);
    setNoteDraft(null);
    if (imageCtxRef.current.active) {
      imageApiRef.current?.turn(direction);
      return;
    }
    // epub 滚动模式无分页语义：footer/HUD/键盘的 上一页/下一页 统一改为上一章/下一章（wheel 仍留给 iframe 原生滚动）
    if (settingsRef.current.readingMode !== "paginated") {
      controllerRef.current?.chapterNav(direction === "next" ? 1 : -1);
      return;
    }
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

    if (
      !el ||
      settings.pageAnimation === "none" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
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

  function locate(target?: string) {
    setSelection(null);
    setNoteDraft(null);
    void controllerRef.current?.display(target);
  }

  // locations 就绪后进度条可拖/可点（点击=零位移拖动，同一路径）
  const sliderReady = locationsReady && !isImageBook && !readerError;
  const scrolledNav = !isImageBook && settings.readingMode === "scrolled";

  function pctFromClientX(clientX: number): number | null {
    const el = progressRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return Math.min(0.999, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function seekTo(p: number) {
    const cfi = controllerRef.current?.progressCfi(p);
    if (cfi) locate(cfi);
  }

  function onProgressKeyDown(e: React.KeyboardEvent) {
    if (!sliderReady) return;
    const base = dragPct ?? percent ?? 0;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      seekTo(Math.max(0, base - 0.01));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      seekTo(Math.min(0.999, base + 0.01));
    }
  }

  function onProgressPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!sliderReady) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    const p = pctFromClientX(e.clientX);
    if (p !== null) setDragPct(p);
  }

  function onProgressPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const p = pctFromClientX(e.clientX);
    if (p !== null) setDragPct(p);
  }

  function onProgressPointerEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const p = pctFromClientX(e.clientX);
    // 松手才 display（拖动仅更新视觉，避免高频 display 抖动）；跳转触发的 relocated 恢复持久化
    if (p !== null) seekTo(p);
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
              : sideTab === "pages"
                ? "页面"
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
          {!isImageBook ? (
            <>
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
            </>
          ) : null}
          {isImageBook ? (
            <button className="wr-btn wr-icon-btn" onClick={() => openDrawer("pages")}>
              <IconImage />
              页面
            </button>
          ) : null}
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
            {sideTab === "settings" && isImageBook ? (
              <ImageSettingsPanel
                theme={settings.theme}
                onThemeChange={(t) => {
                  setSettings((prev) => ({ ...prev, theme: t }));
                  settingsTouchedRef.current = true;
                  void setSetting("theme", t);
                }}
                value={imageSettings}
                onChange={(next) => {
                  setImageSettings(next);
                  settingsTouchedRef.current = true;
                  void setSetting("image_reader_settings", JSON.stringify(next));
                }}
              />
            ) : null}

            {sideTab === "settings" && !isImageBook ? (
              <SettingsPanel
                value={settings}
                bgUrl={bgUrl}
                onChange={(next) => {
                  setSettings(next);
                  void persistSettings(next);
                }}
              />
            ) : null}

            {sideTab === "pages" && isImageBook && book && imagePage ? (
              <PagesPanel
                bookId={book.id}
                pageCount={imagePage.pageCount}
                currentPage={imagePage.page}
                goTo={(p) => imageApiRef.current?.goToPage(p)}
                getResidentUrl={(p) => imageApiRef.current?.getPageUrl(p)}
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
                      <button key={item.href} className="wr-toc-item" onClick={() => locate(item.href)}>
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
                loaded={annotationsLoaded}
                onAdd={() => {
                  const cfi = lastCfiRef.current;
                  if (!book || !cfi) return;
                  void (async () => {
                    const bm = await addBookmark(book.id, cfi, chapterLabel());
                    setBookmarks((prev) => (prev.some((x) => x.cfi === bm.cfi) ? prev : [bm, ...prev]));
                  })();
                }}
                onOpen={(cfi) => locate(cfi)}
                onDelete={(id) => {
                  if (!window.confirm("确定删除该书签吗？")) return;
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
                loaded={annotationsLoaded}
                onOpen={(cfiRange) => locate(cfiRange)}
                onDelete={(id) => {
                  if (!window.confirm("确定删除该标注吗？笔记将一并删除")) return;
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
                {!annotationsLoaded ? (
                  <div className="wr-muted">加载中…</div>
                ) : favoriteQuotes.length === 0 ? (
                  <div className="wr-muted">还没有收藏，选中正文一段文字试试</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {favoriteQuotes.map((q) => (
                      <div key={q.id} className="wr-card" style={{ padding: 10 }}>
                        <div style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>{q.text}</div>
                        {q.note ? <div className="wr-muted" style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>{q.note}</div> : null}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="wr-btn" onClick={() => locate(q.cfi_range)}>
                            打开定位
                          </button>
                          <button
                            className="wr-btn"
                            onClick={() => {
                              if (!window.confirm("确定删除这条收藏吗？")) return;
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
                searched={searched}
                results={searchRows}
                onSearch={() => {
                  void (async () => {
                    const ctrl = controllerRef.current;
                    if (!ctrl) return;
                    const seq = ++searchSeqRef.current;
                    setSearchLoading(true);
                    setSearched(true);
                    try {
                      const res = await ctrl.search(searchQuery);
                      if (searchSeqRef.current !== seq) return;
                      setSearchResults(res);
                    } finally {
                      if (searchSeqRef.current === seq) setSearchLoading(false);
                    }
                  })();
                }}
                onOpen={(cfi) => locate(cfi)}
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
                        const h = await addHighlight(book.id, d.cfiRange, HIGHLIGHT_COLOR, noteText.trim() ? noteText : null);
                        setHighlights((prev) => (prev.some((x) => x.cfi_range === h.cfi_range) ? prev : [h, ...prev]));
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

          <div className={isImageBook ? "wr-reader-paper-wrap wr-paper-image" : "wr-reader-paper-wrap"}>
            {isImageBook && book ? (
              <ImageReader
                key={book.id}
                book={book}
                settings={imageSettings}
                theme={settings.theme}
                onRelocated={handleImageRelocated}
                onApi={(api) => {
                  imageApiRef.current = api;
                }}
              />
            ) : (
              <>
                {!readerError && (!book || tocLoading) ? (
                  <div className="wr-muted" style={{ padding: 16, margin: "auto" }}>
                    加载中…
                  </div>
                ) : null}
                <div
                  className={
                    settings.readingMode === "paginated" && spreadMode === "always"
                      ? "wr-reader-paper wr-reader-paper--wide"
                      : "wr-reader-paper"
                  }
                  style={
                    bgUrl
                      ? { backgroundImage: `url("${bgUrl}")`, backgroundSize: "cover", backgroundPosition: "center" }
                      : undefined
                  }
                >
                  {bgUrl ? <div className="wr-reader-bg-veil" aria-hidden="true" /> : null}
                  <div ref={containerRef} style={{ height: "100%", position: "relative" }} />
                </div>
              </>
            )}
          </div>

          {pagerEnabled ? (
            <div style={{ position: "absolute", inset: 18, zIndex: "var(--wr-z-pager)", pointerEvents: "none", borderRadius: 22 }}>
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
                  void animateTurn(imageEdgeSwap ? "next" : "prev");
                }}
                onMouseEnter={() => setPagerHover("left")}
                onMouseLeave={() => setPagerHover(null)}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: stage.leftEdgeWidth,
                  cursor: "pointer",
                  pointerEvents: "auto",
                }}
              />
              <div
                onClick={() => {
                  void animateTurn(imageEdgeSwap ? "prev" : "next");
                }}
                onMouseEnter={() => setPagerHover("right")}
                onMouseLeave={() => setPagerHover(null)}
                style={{
                  position: "absolute",
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: stage.rightEdgeWidth,
                  cursor: "pointer",
                  pointerEvents: "auto",
                }}
              />
            </div>
          ) : null}
          <SelectionToolbar
            open={!!selection && !drawerOpen && !readerError}
            rect={selection?.rect ?? null}
            onHighlight={() => {
              const s = selection;
              if (!book || !s) return;
              void (async () => {
                const h = await addHighlight(book.id, s.cfiRange, HIGHLIGHT_COLOR, s.text);
                setHighlights((prev) => (prev.some((x) => x.cfi_range === h.cfi_range) ? prev : [h, ...prev]));
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
                zIndex: "var(--wr-z-overlay)",
              }}
            >
              <div role="alert" style={{ maxWidth: 720, width: "100%", border: "1px solid var(--border)", borderRadius: "var(--wr-radius-lg)", padding: 14, background: "var(--panel-solid)", boxShadow: "var(--shadow-sm)" }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>加载失败</div>
                <div style={{ whiteSpace: "pre-wrap", color: "var(--text-muted)", marginBottom: 12 }}>{readerError}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => {
                      navigator.clipboard
                        ?.writeText(readerError)
                        .then(() => {
                          setErrorCopied(true);
                          window.setTimeout(() => setErrorCopied(false), 1500);
                        })
                        .catch(() => {});
                    }}
                    className="wr-btn wr-btn-primary"
                  >
                    {errorCopied ? "已复制" : "复制错误"}
                  </button>
                  <button
                    onClick={() => {
                      setReaderError(null);
                      setTocLoading(true);
                      setRetryKey((k) => k + 1);
                    }}
                    className="wr-btn wr-btn-primary"
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
            {scrolledNav ? "上一章" : "上一页"}
          </button>
          <button className="wr-btn wr-icon-btn" onClick={() => void animateTurn("next")}>
            <IconChevronRight />
            {scrolledNav ? "下一章" : "下一页"}
          </button>
          <div
            ref={progressRef}
            className="wr-progress"
            role={sliderReady ? "slider" : undefined}
            aria-hidden={sliderReady ? undefined : "true"}
            aria-label={sliderReady ? "阅读进度" : undefined}
            aria-valuemin={sliderReady ? 0 : undefined}
            aria-valuemax={sliderReady ? 100 : undefined}
            aria-valuenow={sliderReady ? Math.round((dragPct ?? percent ?? 0) * 100) : undefined}
            tabIndex={sliderReady ? 0 : undefined}
            data-dragging={dragPct !== null ? "" : undefined}
            onKeyDown={onProgressKeyDown}
            onPointerDown={onProgressPointerDown}
            onPointerMove={onProgressPointerMove}
            onPointerUp={onProgressPointerEnd}
            onPointerCancel={onProgressPointerEnd}
            style={sliderReady ? { cursor: "pointer", touchAction: "none", position: "relative" } : undefined}
          >
            <div style={{ width: `${Math.round((dragPct ?? percent ?? 0) * 100)}%` }} />
            {sliderReady ? (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top: "50%",
                  // 收进 [5px, 100%-5px]，避免轨道 overflow:hidden 在两端裁掉把手半圆
                  left: `calc(5px + (100% - 10px) * ${dragPct ?? percent ?? 0})`,
                  transform: "translate(-50%, -50%)",
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: "var(--wr-accent)",
                }}
              />
            ) : null}
          </div>
          <div className="wr-muted" style={{ fontVariantNumeric: "tabular-nums" }}>
            {isImageBook && imagePage !== null
              ? `${imagePage.page + 1} / ${imagePage.pageCount}`
              : typeof percent === "number"
                ? `${Math.round(percent * 100)}%`
                : ""}
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
            visibility: immersiveHudVisible ? "visible" : "hidden",
          }}
        >
          <div className="wr-immersive-hud-card">
            <div className="wr-muted" style={{ fontSize: 12, padding: "0 6px" }}>
              Esc 退出 · 移到顶部唤出
            </div>
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
              {!isImageBook ? (
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
              ) : null}
              <button
                className="wr-btn wr-icon-btn"
                onClick={() => {
                  showImmersiveHudRef.current();
                  void animateTurn("prev");
                }}
              >
                <IconChevronLeft />
                {scrolledNav ? "上一章" : "上一页"}
              </button>
              <button
                className="wr-btn wr-icon-btn"
                onClick={() => {
                  showImmersiveHudRef.current();
                  void animateTurn("next");
                }}
              >
                <IconChevronRight />
                {scrolledNav ? "下一章" : "下一页"}
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
