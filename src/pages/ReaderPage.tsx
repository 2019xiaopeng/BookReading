import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
  scrollEdgeDirection,
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
  normalizeReaderFont,
  normalizeReadingMode,
} from "../reader/settings/normalize";
import { calcPaperStage } from "../reader/ui/paperStage";
import { logFrontend } from "../tauri/frontendLog";
import Drawer from "../ui/Drawer";
import { showConfirm } from "../ui/dialog";
import { useElementSize } from "../ui/useElementSize";
import { useImmersiveChrome } from "../ui/useImmersiveChrome";
import { getBackgroundUrl } from "../ui/appBackground";
import { applyReaderFont } from "../ui/readerFont";
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
  IconRefresh,
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
  // B12 全局“位置页”（估算，1024 字/页粒度）：locations 就绪后 X/Y 全书页码；未就绪回退章内页码
  const [locPage, setLocPage] = useState<{ index: number; total: number } | null>(null);
  const [lockToast, setLockToast] = useState(false);
  const [speedToast, setSpeedToast] = useState<number | null>(null);
  // B13 滚动模式章续读提示（"已进入 <章名>"1.5s）
  const [chapterToast, setChapterToast] = useState<string | null>(null);
  const [pagerHover, setPagerHover] = useState<"left" | "right" | null>(null);
  const [locationsReady, setLocationsReady] = useState(false);
  const [dragPct, setDragPct] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const speedToastTimerRef = useRef<number | null>(null);
  const chapterToastTimerRef = useRef<number | null>(null);
  const pendingChapterToastRef = useRef(false);
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
  // 沉浸 chrome（B12 精简版）：显示=指针进顶/底热区（无延迟）；隐藏=离开热区与栏 1.2s / 翻页动作即收 /
  // 开始选字或打开抽屉、错误浮层（disabled=栏隐藏）；锁定=全藏+热区禁用。单击正文不承担收栏职责。
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
        reader_font: normalizeReaderFont(map.reader_font),
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
      setLocPage(null);
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
        // 视觉页码徽标：优先全局“位置页”（B12，locations 估算 1024 字/页）；paginated 无 locPage 时回退章内页码
        setLocPage(payload.locPage ?? null);
        if (settingsRef.current.readingMode === "paginated" && !payload.locPage) {
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
          // iframe 内按下（含开始新选区）即收起旧气泡；B12：单击正文不再承担收栏职责（与点击翻页/选字冲突）
          onContentsPress: () => {
            setSelection(null);
          },
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

  // B11：自定义正文字体——@font-face("wr-custom") 单槽注入，preset 时回收 objectURL 与 <style>
  useEffect(() => {
    applyReaderFont(settings.reader_font).catch((e) => logFrontend(`reader: font load failed ${String(e)}`));
  }, [settings.reader_font]);

  // B12 固定预留：栏显隐只做淡入淡出、布局零变化（不再需要 visible-keyed resize）；
  // 仅锁定切换（padding 62↔0 的一次性 200ms 过渡）后补一次 epub 重排，保持分页正确
  useEffect(() => {
    if (isImageBook) return;
    const t = window.setTimeout(() => controllerRef.current?.resize(), 220);
    return () => window.clearTimeout(t);
  }, [chrome.locked, isImageBook]);

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

      // F11 窗口全屏（独立于沉浸锁定；Esc 不退全屏，浏览器惯例由用户 F11 自控）
      if (e.key === "F11") {
        e.preventDefault();
        void (async () => {
          const win = getCurrentWindow();
          try {
            await win.setFullscreen(!(await win.isFullscreen()));
          } catch (e) {
            logFrontend(`reader: fullscreen toggle failed ${String(e)}`);
          }
        })();
        return;
      }

      if (isTyping) return;

      if (imageCtxRef.current.active) {
        // B12 条漫：空格=自动滚动播放/暂停（缩放态、输入焦点除外，不再触发原生下跳）；
        // 播放中 ↑/↓=速度 ±10（实时生效+轻提示当前速度）
        if (imageCtxRef.current.webtoon && !imageApiRef.current?.zoomed?.()) {
          if (e.key === " ") {
            e.preventDefault();
            imageApiRef.current?.toggleAutoScroll();
            return;
          }
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && imageApiRef.current?.autoActive?.()) {
            e.preventDefault();
            nudgeAutoScrollSpeed(e.key === "ArrowUp" ? 10 : -10);
            return;
          }
        }
        const imageDir = turnKeyDirection(e.key, imageCtxRef.current.rtl);
        if (imageDir) {
          e.preventDefault();
          chrome.dismiss(); // B12：翻页动作即收栏（栏可见时）
          void animateTurn(imageDir);
          return;
        }
      } else if (
        !imageCtxRef.current.active &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "PageUp" || e.key === "PageDown")
      ) {
        // 分页=翻页；滚动模式 Arrow 仍整章跳（animateTurn 分流）
        e.preventDefault();
        chrome.dismiss(); // B12：翻页动作即收栏（栏可见时）
        // B13 滚动模式 PageDown/PageUp：章末/章首即时章导航，章中原生滚一屏（键盘优先，不等 400ms 防抖）
        if (settingsRef.current.readingMode !== "paginated" && (e.key === "PageDown" || e.key === "PageUp")) {
          void controllerRef.current?.scrollStep(e.key === "PageDown" ? 1 : -1);
          return;
        }
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
  }, [book, drawerOpen, chrome, imageSettings, chapterTitle, settings.pageAnimation, settings.readingMode]);

  useEffect(() => {
    // B12：热区条上移到根级预留带（viewer overflow:hidden 会裁掉负偏移），滚轮监听同步挂根级
    const el = readerRootRef.current;
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
      chrome.dismiss(); // B12：滚轮翻页即收栏（栏可见时）
      void animateTurn(dir);
    };

    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [drawerOpen, settings.pageAnimation]);

  // B13 滚动模式章续读：滚到章末/章首持续 ~400ms 自动 display 下/上一章（保持 scrolled）+ 轻提示。
  // 章切换落位的程序性滚动（整屏级大跳）不参与判定，避免落位即回跳；短章按滚动方向续读。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || isImageBook || settings.readingMode !== "scrolled" || drawerOpen) return;
    let timer: number | null = null;
    let lastTop = -1;
    let lastDelta = 1;
    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const onScroll = () => {
      const sc = el.querySelector<HTMLElement>(".epub-container");
      if (!sc || sc.clientHeight <= 0) return;
      const delta = sc.scrollTop - lastTop;
      lastTop = sc.scrollTop;
      if (Math.abs(delta) >= sc.clientHeight * 0.9) return; // display 落位整跳：只同步位置不判定
      if (delta !== 0) lastDelta = delta;
      clearTimer();
      const dir = scrollEdgeDirection(sc.scrollTop, sc.clientHeight, sc.scrollHeight, lastDelta);
      if (!dir) return;
      timer = window.setTimeout(() => {
        timer = null;
        const sc2 = el.querySelector<HTMLElement>(".epub-container");
        const ctrl = controllerRef.current;
        if (!sc2 || sc2.clientHeight <= 0 || !ctrl) return;
        if (scrollEdgeDirection(sc2.scrollTop, sc2.clientHeight, sc2.scrollHeight, lastDelta) !== dir) return;
        pendingChapterToastRef.current = true;
        ctrl.chapterNav(dir);
      }, 400);
    };
    el.addEventListener("scroll", onScroll, true);
    return () => {
      clearTimer();
      el.removeEventListener("scroll", onScroll, true);
    };
  }, [isImageBook, settings.readingMode, drawerOpen]);

  // 章续读落位（relocated 更新 chapterHref）后弹 1.5s 轻提示
  useEffect(() => {
    if (!pendingChapterToastRef.current) return;
    pendingChapterToastRef.current = false;
    if (!chapterTitle) return;
    setChapterToast(chapterTitle);
    if (chapterToastTimerRef.current) window.clearTimeout(chapterToastTimerRef.current);
    chapterToastTimerRef.current = window.setTimeout(() => setChapterToast(null), 1500);
    return () => {
      if (chapterToastTimerRef.current) window.clearTimeout(chapterToastTimerRef.current);
    };
  }, [chapterTitle]);

  async function persistSettings(next: ReaderSettings) {
    settingsTouchedRef.current = true;
    await setSetting("fontSizePercent", String(next.fontSizePercent));
    await setSetting("pageAnimation", next.pageAnimation);
    await setSetting("layoutMode", next.layoutMode);
    await setSetting("lineHeight", String(next.lineHeight));
    await setSetting("fontFamily", next.fontFamily);
    await setSetting("readingMode", next.readingMode);
    await setSetting("reader_bg", JSON.stringify(next.reader_bg));
    await setSetting("reader_font", JSON.stringify(next.reader_font));
  }

  // B12 条漫播放中 ↑/↓ 调速：±10 并钳 20-240，实时写入设置（ImageReader autoSpeedRef 即时生效）+ 轻提示
  function nudgeAutoScrollSpeed(delta: number) {
    const speed = Math.min(240, Math.max(20, imageSettings.autoScrollSpeed + delta));
    const next = { ...imageSettings, autoScrollSpeed: speed };
    setImageSettings(next);
    settingsTouchedRef.current = true;
    void setSetting("image_reader_settings", JSON.stringify(next));
    setSpeedToast(speed);
    if (speedToastTimerRef.current) window.clearTimeout(speedToastTimerRef.current);
    speedToastTimerRef.current = window.setTimeout(() => setSpeedToast(null), 1200);
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
      ref={readerRootRef}
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

      {/* B12 固定预留：非锁定态 stage 恒定 padding 62px（栏在预留区内淡入淡出，内容零位移）；锁定态一次性收 0；
          B13 漫画：栏为悬浮玻璃条后无需让位，padding 恒 0（见 weread.css [data-image]） */}
      <div
        className="wr-reader-stage"
        data-locked={chrome.locked ? "true" : undefined}
        data-image={isImageBook || undefined}
      >
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
                  <div className="wr-state wr-state-loading">
                    <span className="wr-state-icon" aria-hidden="true">
                      <IconRefresh />
                    </span>
                    <div className="wr-state-title">加载中</div>
                  </div>
                ) : toc.length === 0 ? (
                  <div className="wr-state">
                    <span className="wr-state-icon" aria-hidden="true">
                      <IconList />
                    </span>
                    <div className="wr-state-title">暂无目录</div>
                  </div>
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
                  void (async () => {
                    const ok = await showConfirm("删除书签", "确定删除该书签吗？", { danger: true, confirmText: "删除" });
                    if (!ok) return;
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
                  void (async () => {
                    const ok = await showConfirm("删除标注", "确定删除该标注吗？笔记将一并删除。", {
                      danger: true,
                      confirmText: "删除",
                    });
                    if (!ok) return;
                    const h = highlights.find((x) => x.id === id);
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
                  <div className="wr-state wr-state-loading">
                    <span className="wr-state-icon" aria-hidden="true">
                      <IconRefresh />
                    </span>
                    <div className="wr-state-title">加载中</div>
                  </div>
                ) : favoriteQuotes.length === 0 ? (
                  <div className="wr-state">
                    <span className="wr-state-icon" aria-hidden="true">
                      <IconQuote />
                    </span>
                    <div className="wr-state-title">还没有收藏</div>
                    <div className="wr-state-sub">选中正文一段文字试试</div>
                  </div>
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
                              void (async () => {
                                const ok = await showConfirm("删除收藏", "确定删除这条收藏吗？", {
                                  danger: true,
                                  confirmText: "删除",
                                });
                                if (!ok) return;
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
                  <div className="wr-state wr-state-loading" style={{ margin: "auto" }}>
                    <span className="wr-state-icon" aria-hidden="true">
                      <IconRefresh />
                    </span>
                    <div className="wr-state-title">加载中</div>
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
                  {/* B12 页码徽标：locations 就绪显示全书“位置页” X / Y（1024 字/页估算；双页两角 X 与 X+1 近似）；未就绪回退章内页码 */}
                  {locPage ? (
                    <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }}>
                      {pageBadge.right ? (
                        <>
                          <span style={pageBadgeStyle("left")}>
                            {locPage.index + 1} / {locPage.total}
                          </span>
                          <span style={pageBadgeStyle("right")}>
                            {Math.min(locPage.index + 2, locPage.total)} / {locPage.total}
                          </span>
                        </>
                      ) : (
                        // 单页：只右下角一枚
                        <span style={pageBadgeStyle("right")}>
                          {locPage.index + 1} / {locPage.total}
                        </span>
                      )}
                    </div>
                  ) : pageBadge.left || pageBadge.right ? (
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
            <div style={{ position: "absolute", inset: 18, zIndex: "var(--wr-z-pager)", pointerEvents: "none", borderRadius: "var(--wr-radius-xl)" }}>
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
                        ? "linear-gradient(90deg, rgba(var(--wr-ink-rgb),0.06), rgba(var(--wr-ink-rgb),0))"
                        : "linear-gradient(270deg, rgba(var(--wr-ink-rgb),0.06), rgba(var(--wr-ink-rgb),0))",
                  }}
                />
              ) : null}
              <div
                onClick={() => {
                  chrome.dismiss(); // B12：边缘热区点击翻页即收栏
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
                  chrome.dismiss(); // B12：边缘热区点击翻页即收栏
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
              role="alert"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
                background: "var(--wr-scrim)",
                zIndex: "var(--wr-z-overlay)",
              }}
            >
              <div className="wr-card wr-state wr-state-error" style={{ maxWidth: 720, width: "100%" }}>
                <div className="wr-state-title">加载失败</div>
                <div className="wr-state-sub" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "30vh", overflow: "auto" }}>
                  {readerError}
                </div>
                <div className="wr-state-actions">
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
                    className="wr-btn"
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

      {/* B12 顶/底热区条：根级正对 stage 的 62px 预留带（栏所在处；viewer overflow:hidden 会裁掉负偏移故挂根级），
          鼠标进入唤出栏；透明覆盖、z(14) 低于栏(16)与抽屉(20)，点击穿透照常翻页 */}
      {!chrome.locked ? (
        <>
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

      {!chrome.locked ? (
        <div
          className="wr-reader-footer"
          style={{
            ...chromeBarStyle(8),
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 10,
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
            <div style={{ "--wr-fill": String(dragPct ?? percent ?? 0) } as React.CSSProperties} />
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
              : locPage
                ? // B12 全局位置页（估算，与角标一致）；未就绪回退百分比
                  `${locPage.index + 1} / ${locPage.total}`
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

      {speedToast !== null ? (
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
            fontVariantNumeric: "tabular-nums",
          }}
        >
          自动滚动 {speedToast}px/s
        </div>
      ) : null}

      {chapterToast !== null ? (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 84,
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
          已进入 {chapterToast}
        </div>
      ) : null}
    </div>
  );
}
