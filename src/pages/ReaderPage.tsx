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
  setBookFavorite,
  setSetting,
  upsertReadingState,
  type Bookmark,
  type FavoriteQuote,
  type Highlight,
} from "../tauri/invoke";
import {
  cfiRangesOverlap,
  createReader,
  type ReaderController,
  type RelocatedPayload,
  type SearchResult,
  type SelectionRect,
  type TocItem,
} from "../reader/epub/reader";
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
  parseImageCfi,
  turnKeyDirection,
  type ImageReaderSettings,
} from "../reader/image/layout";
import { defaultSettings, HIGHLIGHT_COLOR } from "../reader/settings/defaults";
import type { ReaderSettings } from "../reader/settings/types";
import { normalizeLayoutMode, resolveSpreadMode } from "../reader/settings/layoutMode";
import {
  normalizeFontFamily,
  normalizeLineHeight,
  normalizePageAnimation,
  normalizeReaderBackground,
  normalizeReadingMode,
} from "../reader/settings/normalize";
import { calcPaperStage } from "../reader/ui/paperStage";
import { logFrontend } from "../tauri/frontendLog";
import Drawer from "../ui/Drawer";
import { useElementSize } from "../ui/useElementSize";
import { useImmersiveChrome } from "../ui/useImmersiveChrome";
import { getBackgroundUrl } from "../ui/appBackground";
import { applyPersistedTheme, getTheme, useTheme } from "../ui/theme";
import {
  IconBookmark,
  IconChevronLeft,
  IconChevronRight,
  IconHeart,
  IconHighlight,
  IconImage,
  IconList,
  IconLock,
  IconLockOpen,
  IconQuote,
  IconSearch,
  IconSettings,
} from "../ui/icons";

export default function ReaderPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { bookId } = useParams();
  const theme = useTheme();
  const [book, setBook] = useState<Book | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [tocLoading, setTocLoading] = useState(true);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [errorCopied, setErrorCopied] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [annotationsLoaded, setAnnotationsLoaded] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(defaultSettings);
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selection, setSelection] = useState<{ cfiRange: string; text: string; rect: SelectionRect | null } | null>(null);
  const [noteDraft, setNoteDraft] = useState<{ cfiRange: string; text: string } | null>(null);
  const [noteText, setNoteText] = useState("");
  const [chapterHref, setChapterHref] = useState("");
  const [pageBadge, setPageBadge] = useState<{ left: { page: number; total: number } | null; right: { page: number; total: number } | null }>({ left: null, right: null });
  const [lockToast, setLockToast] = useState(false);
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
  const persistTimerRef = useRef<number | null>(null);
  const lastCfiRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  const settingsTouchedRef = useRef(false);
  const searchSeqRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const wheelCooldownRef = useRef(0);
  const wheelAccumRef = useRef(0);
  const turningRef = useRef(false);
  const imageApiRef = useRef<ImageReaderApi | null>(null);
  const imageCtxRef = useRef({ active: false, rtl: false, webtoon: false });
  const progressRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  // 沉浸 chrome（B6 热区版）：默认净屏，鼠标进顶/底热区或栏内浮现，离开 2.5s 淡出；锁定=全藏+热区禁用；抽屉开/加载失败/选区气泡开强制可见
  const chrome = useImmersiveChrome({ disabled: drawerOpen || !!readerError || !!selection || !!noteDraft });

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

  // 章名随 relocated 更新；toc 晚到时 memo 重算自动补上
  const chapterTitle = useMemo(() => tocLabelFor(flatToc, chapterHref) ?? "正文", [flatToc, chapterHref]);

  const searchRows = useMemo(
    () => searchResults.map((r) => ({ ...r, chapter: tocLabelFor(flatToc, r.sectionHref) ?? "正文" })),
    [searchResults, flatToc],
  );

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

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
      applyPersistedTheme(map.theme);
      const fontSizePercent = Number(map.fontSizePercent ?? defaultSettings.fontSizePercent);
      const pageAnimation = normalizePageAnimation(map.pageAnimation);
      const layoutMode = normalizeLayoutMode(map.layoutMode);
      const lineHeight = normalizeLineHeight(map.lineHeight);
      const fontFamily = normalizeFontFamily(map.fontFamily);
      setSettings({
        fontSizePercent: Number.isFinite(fontSizePercent)
          ? Math.min(200, Math.max(80, fontSizePercent))
          : defaultSettings.fontSizePercent,
        pageAnimation,
        layoutMode,
        lineHeight,
        fontFamily,
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
        lastCfiRef.current = null; // 换书后旧 CFI 不得进 img 书签/进度
        setTocLoading(false);
        // B4: 漫画书签复用 BookmarksPanel，加载 img:N 书签并放行 loaded 态
        try {
          const bm = await listBookmarks(book.id);
          if (cancelled) return;
          setBookmarks(bm);
        } catch (e) {
          logFrontend(`reader: bookmarks load failed ${book.id} ${String(e)}`);
        }
        setAnnotationsLoaded(true);
        return;
      }
      if (!containerRef.current) return;

      const container = containerRef.current;
      container.innerHTML = "";
      setReaderError(null);
      setLocationsReady(false);
      setDragPct(null);
      setPageBadge({ left: null, right: null });
      setChapterHref("");
      restoredRef.current = false;
      setAnnotationsLoaded(false);
      setToc([]);
      setTocLoading(true);

      const onRelocated = (payload: RelocatedPayload) => {
        if (cancelled) return;
        const { cfi, percent, href } = payload;
        lastCfiRef.current = cfi;
        setChapterHref(href);
        if (typeof percent === "number") setPercent(percent);
        setDragPct(null);
        setSelection(null);
        // 视觉页码徽标（epub paginated 专属；scrolled 无分页语义，image 书不走此回调）
        if (settingsRef.current.readingMode === "paginated") {
          const left = payload.pageStart;
          const right =
            payload.pageEnd && (payload.endSectionIndex !== payload.sectionIndex || payload.pageEnd.page !== left?.page) ? payload.pageEnd : null;
          setPageBadge({ left, right });
        } else {
          setPageBadge({ left: null, right: null });
        }
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
          fontFamily: settingsRef.current.fontFamily,
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
      ctrl.setTheme(getTheme());
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
    controllerRef.current.setTheme(theme);
    controllerRef.current.setFontSizePercent(settings.fontSizePercent);
    controllerRef.current.setLineHeight(settings.lineHeight);
    controllerRef.current.setFontFamily(settings.fontFamily);
    // scrolled 模式下分栏失效，跳过 spread 以免与 epubjs scrolled 冲突
    if (settings.readingMode !== "scrolled") controllerRef.current.setSpreadMode(spreadMode);
  }, [theme, settings.fontSizePercent, settings.lineHeight, settings.fontFamily, settings.layoutMode, spreadMode, settings.readingMode]);

  // 字号/行距变化后重排：章内页码（displayed.total）随新分页更新
  useEffect(() => {
    controllerRef.current?.resize();
  }, [settings.fontSizePercent, settings.lineHeight]);

  useEffect(() => {
    controllerRef.current?.setReadingMode(settings.readingMode);
  }, [settings.readingMode]);

  // 阅读纸面叠加全局背景（单槽缓存与壳共用）；preset 时缓存一并释放
  useEffect(() => {
    if (isImageBook) {
      setBgUrl(null);
      return;
    }
    let cancelled = false;
    getBackgroundUrl(settings.reader_bg)
      .then((url) => {
        if (!cancelled) setBgUrl(url);
      })
      .catch((e) => {
        logFrontend(`reader: bg load failed ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [settings.reader_bg, isImageBook]);

  // B6：栏改为 overlay 后纸面高度恒定，锁定切换不再需要 resize 联动（原底部空白根因已消除）

  useEffect(() => {
    if (!chrome.locked) return;
    setLockToast(true);
    const t = window.setTimeout(() => setLockToast(false), 2500);
    return () => window.clearTimeout(t);
  }, [chrome.locked]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName?.toLowerCase();
      const isTyping = tag === "input" || tag === "textarea" || active?.isContentEditable;

      if (e.ctrlKey && e.key.toLowerCase() === "f" && !imageCtxRef.current.active) {
        e.preventDefault();
        setSideTab("search");
        setDrawerOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }

      if (e.ctrlKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        chrome.setLocked(!chrome.locked);
        return;
      }

      if (e.ctrlKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        addBookmarkHere();
        setSideTab("bookmarks");
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
        // Esc 顺序语义：关抽屉 > 解除锁定 > 唤醒栏 > 无操作
        if (drawerOpen) {
          e.preventDefault();
          setDrawerOpen(false);
          return;
        }
        if (chrome.locked) {
          e.preventDefault();
          chrome.setLocked(false);
          return;
        }
        if (!chrome.visible) {
          e.preventDefault();
          chrome.wake();
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [book, drawerOpen, chrome.locked, chrome.visible, chrome.wake, chrome.setLocked, chapterTitle, settings.pageAnimation, settings.readingMode]);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;

    // 热区条盖住的顶/底 48px 带内，iframe/内嵌滚动收不到 wheel——接力给实际滚动容器
    const forwardHotzoneWheel = (e: WheelEvent, host: HTMLElement) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".wr-chrome-hotzone")) return;
      const scroller =
        containerRef.current?.querySelector<HTMLElement>(".epub-container") ??
        host.querySelector<HTMLElement>(".wr-image-webtoon");
      if (scroller) scroller.scrollTop += e.deltaY;
    };

    const onWheel = (e: WheelEvent) => {
      if (drawerOpen) return;
      // epub 滚动模式下 wheel 交给 iframe 原生滚动
      if (!imageCtxRef.current.active && settingsRef.current.readingMode !== "paginated") {
        forwardHotzoneWheel(e, el);
        return;
      }
      // 条漫原生滚动；B6 缩放态滚轮=平移（ImageReader 内部处理）；键盘/热区翻页走 turn 内先复位
      if (imageCtxRef.current.active && (imageCtxRef.current.webtoon || imageApiRef.current?.zoomed?.())) {
        forwardHotzoneWheel(e, el);
        return;
      }
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
    await setSetting("fontSizePercent", String(next.fontSizePercent));
    await setSetting("pageAnimation", next.pageAnimation);
    await setSetting("layoutMode", next.layoutMode);
    await setSetting("lineHeight", String(next.lineHeight));
    await setSetting("fontFamily", next.fontFamily);
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
      // B6：翻页不再被缩放阻塞——ImageReader.turn 内部先复位缩放再翻
      imageApiRef.current?.turn(direction);
      return;
    }
    // epub 滚动模式无分页语义：键盘/滚轮/热区统一改为上一章/下一章（wheel 仍留给 iframe 原生滚动）
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
      // 整页平移：动画节点为 epub 渲染容器（纸框/背景纱不动，内容整页滑出+滑入）
      const paper = containerRef.current;
      if (!paper) {
        await run();
        return;
      }
      // 快速连翻：动画进行中直接瞬时跳页，不排队、永不卡死
      if (turningRef.current) {
        await run();
        return;
      }
      turningRef.current = true;
      try {
        const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
        paper.style.transition = "transform 150ms ease-in";
        paper.style.transform = `translateX(${direction === "next" ? "-100%" : "100%"})`;
        await wait(150); // 旧页整幅滑出屏外后再换内容
        await run();
        paper.style.transition = "none";
        paper.style.transform = `translateX(${direction === "next" ? "100%" : "-100%"})`;
        void paper.offsetHeight; // 强制 reflow 提交入场起点
        paper.style.transition = "transform 240ms cubic-bezier(0.2, 0, 0, 1)";
        paper.style.transform = "translateX(0)";
        await wait(260); // 兜底等待，不依赖 transitionend
        paper.style.transition = "";
        paper.style.transform = "";
      } finally {
        turningRef.current = false;
      }
      return;
    }

    await run();
  }

  /** footer 上一章/下一章（epub 两模式统一；image 书 footer 仍是页翻，走 animateTurn） */
  function navChapter(direction: "next" | "prev") {
    setSelection(null);
    setNoteDraft(null);
    controllerRef.current?.chapterNav(direction === "next" ? 1 : -1);
  }

  function openDrawer(tab: typeof sideTab) {
    setSideTab(tab);
    setDrawerOpen(true);
    if (tab === "search") requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  // B4: 书签统一入口——image 书记 img:N + “第N页”，epub 记 CFI + 章名
  function addBookmarkHere() {
    const cfi = lastCfiRef.current;
    if (!book || !cfi) return;
    const imgPage = imageCtxRef.current.active ? parseImageCfi(cfi) : null;
    void (async () => {
      const bm = await addBookmark(book.id, cfi, imgPage !== null ? `第${imgPage + 1}页` : chapterTitle);
      setBookmarks((prev) => (prev.some((x) => x.cfi === bm.cfi) ? prev : [bm, ...prev]));
    })();
  }

  function locate(target?: string) {
    setSelection(null);
    setNoteDraft(null);
    // B4: img:N 书签在漫画模式分流到 goToPage（此时无 epub controller）
    const imgPage = imageCtxRef.current.active ? parseImageCfi(target) : null;
    if (imgPage !== null) {
      imageApiRef.current?.goToPage(imgPage);
      return;
    }
    void controllerRef.current?.display(target);
  }

  // locations 就绪后进度条可拖/可点（点击=零位移拖动，同一路径）
  const sliderReady = locationsReady && !isImageBook && !readerError;
  // 选区与现有高亮相交 → 气泡高亮钮切换为"取消高亮"
  const overlappingHighlights = selection ? highlights.filter((h) => cfiRangesOverlap(h.cfi_range, selection.cfiRange)) : [];

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

  // 栏淡出/淡入：仅 opacity+transform（栏已是 absolute overlay，不占布局，纸面恒定不 resize）
  const chromeBarStyle = (dy: number): React.CSSProperties => ({
    transition: "opacity 200ms ease, transform 200ms ease",
    ...(chrome.visible ? null : { opacity: 0, transform: `translateY(${dy}px)`, pointerEvents: "none" as const }),
  });

  const pageBadgeStyle = (side: "left" | "right"): React.CSSProperties => ({
    position: "absolute",
    bottom: 6,
    ...(side === "left" ? { left: 10 } : { right: 10 }),
    fontSize: 11,
    color: "var(--wr-muted)",
    fontVariantNumeric: "tabular-nums",
  });

  return (
    <div
      data-theme={theme}
      className="wr-reader-root"
    >
      {!chrome.locked ? (
        <div
          className="wr-topbar wr-reader-topbar"
          style={chromeBarStyle(-8)}
          onMouseEnter={chrome.enter}
          onMouseLeave={chrome.leave}
        >
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
          {isImageBook && book ? (
            <>
              <button
                className="wr-btn wr-icon-btn"
                aria-pressed={book.is_favorite}
                onClick={() => {
                  const next = !book.is_favorite;
                  setBook({ ...book, is_favorite: next });
                  void setBookFavorite(book.id, next);
                }}
              >
                <IconHeart fill={book.is_favorite ? "currentColor" : "none"} aria-hidden />
                收藏
              </button>
              <button className="wr-btn wr-icon-btn" onClick={() => openDrawer("bookmarks")}>
                <IconBookmark />
                书签
              </button>
              <button className="wr-btn wr-icon-btn" onClick={() => openDrawer("pages")}>
                <IconImage />
                页面
              </button>
            </>
          ) : null}
          <button className="wr-btn wr-icon-btn" onClick={() => openDrawer("settings")}>
            <IconSettings />
            设置
          </button>
          <button
            className="wr-btn wr-icon-btn"
            aria-pressed={chrome.locked}
            title="锁定沉浸：栏与热区全禁用，角落控件或 Esc 解锁"
            onClick={() => chrome.setLocked(true)}
          >
            <IconLock />
            锁定
          </button>
          <div className="wr-muted" style={{ fontVariantNumeric: "tabular-nums" }}>
            {typeof percent === "number" ? `${Math.round(percent * 100)}%` : ""}
          </div>
        </div>
      ) : null}

      <div className="wr-reader-stage">
        <div
          ref={viewerRef}
          className="wr-reader-viewer"
        >
          <Drawer
            open={drawerOpen}
            title={drawerTitle}
            onClose={() => {
              setDrawerOpen(false);
            }}
          >
            {sideTab === "settings" && isImageBook ? (
              <ImageSettingsPanel
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
                onAdd={addBookmarkHere}
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

          <div
            className={isImageBook ? "wr-reader-paper-wrap wr-paper-image" : "wr-reader-paper-wrap"}
            style={isImageBook ? undefined : { position: "relative" }}
          >
            {isImageBook && book ? (
              <ImageReader
                key={book.id}
                book={book}
                settings={imageSettings}
                onRelocated={handleImageRelocated}
                theme={theme}
                onApi={(api) => {
                  imageApiRef.current = api;
                }}
              />
            ) : (
              <>
                {chrome.locked ? null : (
                  // 纸面上方章节小字（占顶部 18px padding 带，零 layout 影响）
                  <div
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 18,
                      lineHeight: "18px",
                      textAlign: "center",
                      fontSize: 12,
                      color: "var(--wr-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      pointerEvents: "none",
                    }}
                  >
                    {chapterTitle}
                  </div>
                )}
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
                  {pageBadge.left || pageBadge.right ? (
                    <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }}>
                      {pageBadge.right ? (
                        <>
                          {pageBadge.left ? (
                            <span style={pageBadgeStyle("left")}>
                              {pageBadge.left.page}/{pageBadge.left.total}
                            </span>
                          ) : null}
                          <span style={pageBadgeStyle("right")}>
                            {pageBadge.right.page}/{pageBadge.right.total}
                          </span>
                        </>
                      ) : pageBadge.left ? (
                        // 单页：只右下角一枚
                        <span style={pageBadgeStyle("right")}>
                          {pageBadge.left.page}/{pageBadge.left.total}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
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
          {!chrome.locked ? (
            <>
              {/* 顶/底热区条：透明覆盖、z(14) 低于边缘翻页区(15) 点击照常翻页；置于 viewer 子树内滚轮照常冒泡翻页 */}
              <div
                aria-hidden="true"
                className="wr-chrome-hotzone wr-chrome-hotzone--top"
                onMouseEnter={chrome.enter}
                onMouseLeave={chrome.leave}
              />
              <div
                aria-hidden="true"
                className="wr-chrome-hotzone wr-chrome-hotzone--bottom"
                onMouseEnter={chrome.enter}
                onMouseLeave={chrome.leave}
              />
            </>
          ) : null}
          <SelectionToolbar
            open={!!selection && !drawerOpen && !readerError}
            rect={selection?.rect ?? null}
            removeMode={overlappingHighlights.length > 0}
            onHighlight={() => {
              const s = selection;
              if (!book || !s) return;
              if (overlappingHighlights.length > 0) {
                const dead = overlappingHighlights;
                void (async () => {
                  for (const h of dead) {
                    await deleteHighlight(h.id);
                    controllerRef.current?.removeHighlight(h.cfi_range);
                  }
                  const ids = new Set(dead.map((h) => h.id));
                  setHighlights((prev) => prev.filter((h) => !ids.has(h.id)));
                  setSelection(null);
                })();
                return;
              }
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

      {!chrome.locked ? (
        <div
          className="wr-reader-footer"
          style={{
            ...chromeBarStyle(8),
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 10,
            borderTop: "1px solid var(--wr-hairline)",
          }}
          onMouseEnter={chrome.enter}
          onMouseLeave={chrome.leave}
        >
          <button
            className="wr-btn wr-icon-btn"
            onClick={() => (isImageBook ? void animateTurn("prev") : navChapter("prev"))}
          >
            <IconChevronLeft />
            {isImageBook ? "上一页" : "上一章"}
          </button>
          <button
            className="wr-btn wr-icon-btn"
            onClick={() => (isImageBook ? void animateTurn("next") : navChapter("next"))}
          >
            <IconChevronRight />
            {isImageBook ? "下一页" : "下一章"}
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

      {!chrome.locked ? null : (
        /* 锁定态常驻退出控件：半透明、hover 提亮，角落 24px 内边距不遮正文 */
        <div className="wr-immersive-exit">
          <span className="wr-immersive-exit-chapter">{isImageBook ? book?.title : chapterTitle}</span>
          <button
            type="button"
            className="wr-immersive-exit-btn"
            aria-label="退出沉浸模式"
            title="退出沉浸模式（Esc）"
            onClick={() => chrome.setLocked(false)}
          >
            <IconLockOpen />
          </button>
        </div>
      )}

      {chrome.locked && lockToast ? (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 12,
            color: "var(--wr-muted)",
            background: "var(--panel-solid)",
            border: "1px solid var(--wr-hairline)",
            borderRadius: 999,
            padding: "6px 14px",
            boxShadow: "var(--shadow-sm)",
            pointerEvents: "none",
          }}
        >
          已锁定 · Esc 解锁
        </div>
      ) : null}
    </div>
  );
}
