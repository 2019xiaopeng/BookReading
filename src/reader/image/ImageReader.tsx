import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";

import type { Book } from "../../tauri/invoke";
import { getReadingState } from "../../tauri/invoke";
import type { Theme } from "../settings/types";
import { IconPause, IconPlay, IconRefresh } from "../../ui/icons";
import { showAlert } from "../../ui/dialog";
import { BOOKS_CHANGED_EVENT } from "../../library/importRunner";
import { listImagePageMeta, listImagePages, readImagePage, relinkImageBook, type ImagePageMeta } from "./api";
import {
  WIDE_PAGE_RATIO,
  autoScrollStep,
  buildSpreads,
  clampPage,
  clampZoomScale,
  displayOrder,
    slideDirection,
  maxWidthForStage,
  panClamp,
  parseImageCfi,
  spreadIndexForPage,
  widePagesFromMeta,
  type ImageReaderSettings,
  type TurnDirection,
} from "./layout";

export type ImageReaderApi = {
  turn: (direction: TurnDirection) => void;
  goToPage: (page: number) => void;
  /** url of a resident (preload-window) page blob, for the pages panel */
  getPageUrl: (page: number) => string | undefined;
  /** B6: true while Ctrl+wheel zoom is active — 仅用于滚轮分流（缩放态滚轮=平移）；翻页不受缩放阻塞 */
  zoomed: () => boolean;
  /** B12: 条漫空格键播放/暂停自动滚动（非条漫/缩放态起点为无操作） */
  toggleAutoScroll: () => void;
  /** B12: 自动滚动播放中（条漫）——ReaderPage 键盘 ↑/↓ 调速用 */
  autoActive: () => boolean;
};

type Props = {
  book: Book;
  settings: ImageReaderSettings;
  /** 跟随全局六主题（ReaderPage 传入；组件内部 token 化由批次4 B 区接线） */
  theme: Theme;
  /** 翻页滑动过渡时长（ms），与 epub 翻页动画同源；缺省 260≈CSS 里的 250ms */
  turnSpeedMs?: number;
  onRelocated: (page: number, pageCount: number) => void;
  onApi: (api: ImageReaderApi) => void;
};

// resident window: current +/- 3 pages stay as blobs（批次17 由 ±4 收窄：±4 全量并发解码挤占翻页，
// 2 与 4 的折中取 3；配合错峰预载后同帧解码量≤1，翻页不再被拖）
const PRELOAD_PAGES = 3;

function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "gif" || ext === "avif" || ext === "bmp") {
    return `image/${ext === "jpg" ? "jpeg" : ext}`;
  }
  return "application/octet-stream";
}

type ZoomState = { scale: number; tx: number; ty: number };
type PageEntry = { url: string; maxWidth: number | null };

function ImageReaderImpl({ book, theme, settings, turnSpeedMs = 260, onRelocated, onApi }: Props) {
  const [pages, setPages] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 批次18：重链接成功后 +1 触发装载 effect 重跑（book.id 不变，必须靠它重载）
  const [reloadKey, setReloadKey] = useState(0);
  const [spreadIndex, setSpreadIndex] = useState<number | null>(null);
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [wide, setWide] = useState<Record<number, boolean>>({});
  const [failed, setFailed] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState(0);
  const [shownSpread, setShownSpread] = useState<number | null>(null);
  // 批次17：本次换页是否走“占位→成像”路径（初始载入/跳页）——只有它淡入；相邻翻页由 slide 转场，不叠加淡入
  const [reveal, setReveal] = useState(true);
  const [snap, setSnap] = useState<{ pages: number[]; urls: Record<number, string>; dir: 1 | -1 } | null>(null);
  const [zoom, setZoom] = useState<ZoomState>({ scale: 1, tx: 0, ty: 0 });
  const zoomed = zoom.scale !== 1;
  // B11 条漫自动滚动（webtoon 专属）：rAF 按帧距累积 scrollTop，速度存 image_reader_settings
  const [autoScroll, setAutoScroll] = useState(false);
  const [autoEndToast, setAutoEndToast] = useState(false);
  // 页宽高元数据（可失败）：占位按宽高比预留 + spreads 宽页预判；null=无元数据走旧探测路径
  const [pageMeta, setPageMeta] = useState<ImagePageMeta[] | null>(null);
  const autoSpeedRef = useRef(settings.autoScrollSpeed);
  const autoScrollRef = useRef(false);
  const zoomRef = useRef(zoom);
  const zoomFrameRef = useRef(0);
  const zoomCommitTimerRef = useRef<number | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageElsRef = useRef<Map<number, HTMLElement>>(new Map());
  const cacheRef = useRef<Map<number, PageEntry>>(new Map());
  const loadingRef = useRef<Set<number>>(new Set());
  const wantedRef = useRef<Set<number>>(new Set());
  const epochRef = useRef(0);
  const currentPageRef = useRef(0);
  const shownSpreadRef = useRef<number | null>(null);
  const reportedRef = useRef<number | null>(null);
  const settingsRef = useRef(settings);
  const onRelocatedRef = useRef(onRelocated);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    onRelocatedRef.current = onRelocated;
  }, [onRelocated]);

  useEffect(() => {
    autoSpeedRef.current = settings.autoScrollSpeed;
  }, [settings.autoScrollSpeed]);

  // B12: onApi 回调长期持有，须走 ref 读实时播放态（闭包 state 会过期）
  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

  // zoom geometry is per-mode (stage fit layer vs webtoon strip): start each mode fresh.
  // paged 下 anchor 从不更新：切模式前先把锚拉回当前页，否则用陈旧 anchor 错误回收当前页邻域再重载（模式切换闪烁根因）
  useEffect(() => {
    setAutoScroll(false); // 模式切换停自动滚动（分页模式无此功能）
    setAnchor(currentPageRef.current);
    if (zoomRef.current.scale !== 1) applyZoomNow({ scale: 1, tx: 0, ty: 0 });
  }, [settings.mode]);

  const spreads = useMemo(() => {
    const count = pages?.length ?? 0;
    return buildSpreads(
      count,
      Array.from({ length: count }, (_, i) => wide[i] === true),
      settings.layout,
      settings.doubleOffset,
    );
  }, [pages, wide, settings.layout, settings.doubleOffset]);

  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setError(null);
    setSpreadIndex(null);
    setWide({});
    setUrls({});
    setFailed(new Set());
    setAutoScroll(false);
    setPageMeta(null);
    reportedRef.current = null;
    shownSpreadRef.current = null;
    setShownSpread(null);
    setSnap(null);
    (async () => {
      try {
        const names = await listImagePages(book.id);
        if (cancelled) return;
        if (names.length === 0) {
          setPages([]);
          setError("这本书没有可读的页面");
          return;
        }
        // 页宽高元数据（与页名同序）：失败/长度不符时静默回退（解码后探测 wide + 50vh 占位）
        let meta: ImagePageMeta[] | null = null;
        try {
          const m = await listImagePageMeta(book.id);
          if (Array.isArray(m) && m.length === names.length) meta = m;
        } catch {
          // 旧后端无此命令：无元数据照常可读
        }
        if (cancelled) return;
        const state = await getReadingState(book.id);
        if (cancelled) return;
        const start = clampPage(parseImageCfi(state?.cfi) ?? 0, names.length);
        currentPageRef.current = start;
        setAnchor(start);
        setPages(names);
        setPageMeta(meta);
        // 有元数据时按已知宽高建 spreads（宽页解码前就占整组，不再换组闪变）
        const wideArr = widePagesFromMeta(meta, names.length);
        const initialWide: Record<number, boolean> = {};
        for (let i = 0; i < wideArr.length; i++) if (wideArr[i]) initialWide[i] = true;
        setWide(initialWide);
        setSpreadIndex(spreadIndexForPage(buildSpreads(names.length, wideArr, settingsRef.current.layout, settingsRef.current.doubleOffset), start));
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      epochRef.current += 1;
      wantedRef.current = new Set();
      for (const entry of cacheRef.current.values()) URL.revokeObjectURL(entry.url);
      cacheRef.current.clear();
    };
  }, [book.id, reloadKey]);

  // keep the paged view anchored to the current page when spreads are rebuilt (mode/layout flip, late wide detection)
  useEffect(() => {
    setSpreadIndex((prev) => (prev === null ? prev : spreadIndexForPage(spreads, currentPageRef.current)));
  }, [spreads, settings.mode]);

  const activePage =
    settings.mode === "webtoon"
      ? anchor
      : spreadIndex !== null && spreads[spreadIndex]
        ? spreads[spreadIndex][0]
        : null;

  useEffect(() => {
    if (pages === null || activePage === null) return;
    if (reportedRef.current === activePage) return;
    reportedRef.current = activePage;
    currentPageRef.current = activePage;
    onRelocatedRef.current(activePage, pages.length);
  }, [activePage, pages]);

  // batch4 B2: hold the last ready spread while the target loads (no white flash), then slide on unit turns
  useEffect(() => {
    if (settings.mode === "webtoon") {
      if (snap) setSnap(null);
      shownSpreadRef.current = null;
      return;
    }
    if (spreadIndex === null) return;
    const target = spreads[spreadIndex];
    if (!target || !target.every((p) => urls[p] || failed.has(p))) return;
    const prev = shownSpreadRef.current;
    if (prev === spreadIndex) return;
    shownSpreadRef.current = spreadIndex;
    setShownSpread(spreadIndex);
    // 批次17：相邻翻页=页间互换，不淡入（slide 已是转场）；初始载入/跳页=占位→成像，保留 120ms 淡入
    const adjacent = prev !== null && Math.abs(spreadIndex - prev) === 1;
    setReveal(!adjacent);
    if (
      adjacent &&
      settings.pageAnimation === "slide" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const pages = spreads[prev] ?? [];
      const snapUrls: Record<number, string> = {};
      for (const p of pages) {
        const u = urls[p];
        if (u) snapUrls[p] = u;
      }
      if (pages.length > 0 && pages.every((p) => snapUrls[p])) {
        setSnap({ pages, urls: snapUrls, dir: slideDirection(spreadIndex - prev, settings.rtl) as 1 | -1 });
      }
    }
  }, [spreadIndex, spreads, urls, failed, settings.mode, settings.rtl, settings.pageAnimation, snap]);
  function retry(index: number) {
    setFailed((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
    void ensureLoaded(index);
  }

  // 大页降采样上限：显示宽*1.5*DPR（256px 分桶）；fit=original 取原图不缩
  function currentPageMaxWidth(): number | null {
    const s = settingsRef.current;
    if (s.mode === "paged" && s.fit === "original") return null;
    return maxWidthForStage(stageRef.current?.clientWidth ?? 0, window.devicePixelRatio || 1);
  }

  async function ensureLoaded(index: number) {
    const count = pages?.length ?? 0;
    if (index < 0 || index >= count) return;
    if (cacheRef.current.has(index) || loadingRef.current.has(index)) return;
    loadingRef.current.add(index);
    const epoch = epochRef.current;
    const maxWidth = currentPageMaxWidth();
    try {
      const bytes = await readImagePage(book.id, index, maxWidth ?? undefined);
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeFor(pages?.[index] ?? "") }));
      // 批次16：解码完成才算就绪——未解码完不入缓存不换页，消除半载入闪白
      const probe = new Image();
      probe.src = url;
      await probe.decode().catch(() => undefined);
      // stale fetch (want set moved on / book switched / unmounted): never let it become a resident blob
      if (epoch !== epochRef.current || !wantedRef.current.has(index)) {
        URL.revokeObjectURL(url);
        return;
      }
      cacheRef.current.set(index, { url, maxWidth });
      setUrls((prev) => ({ ...prev, [index]: url }));
      // probe the aspect so wide pages can claim a full spread in double mode
      if (probe.naturalHeight > 0 && probe.naturalWidth / probe.naturalHeight > WIDE_PAGE_RATIO) {
        setWide((prev) => (prev[index] ? prev : { ...prev, [index]: true }));
      }
    } catch {
      // keep the slot empty but remember the failure so the placeholder offers a retry
      setFailed((prev) => {
        if (prev.has(index)) return prev;
        const next = new Set(prev);
        next.add(index);
        return next;
      });
    } finally {
      loadingRef.current.delete(index);
    }
  }

  useEffect(() => {
    if (pages === null || spreadIndex === null) return;
    const count = pages.length;
    const want = new Set<number>();
    if (settings.mode === "webtoon") {
      for (let i = anchor - PRELOAD_PAGES; i <= anchor + PRELOAD_PAGES; i++) {
        if (i >= 0 && i < count) want.add(i);
      }
    } else {
      const primary = spreads[spreadIndex]?.[0] ?? 0;
      for (let s = spreadIndex - PRELOAD_PAGES; s <= spreadIndex + PRELOAD_PAGES; s++) {
        for (const p of spreads[s] ?? []) {
          if (p >= primary - PRELOAD_PAGES && p <= primary + PRELOAD_PAGES) want.add(p);
        }
      }
    }
    for (const p of spreads[shownSpreadRef.current ?? -1] ?? []) want.add(p);
    wantedRef.current = want;
    // 先按 want 与降采样档清理缓存（档位变了重取），再错峰载入——ensureLoaded 见缓存缺失才会补拉
    const desiredMaxWidth = currentPageMaxWidth();
    for (const [i, entry] of cacheRef.current) {
      if (!want.has(i) || entry.maxWidth !== desiredMaxWidth) {
        URL.revokeObjectURL(entry.url);
        cacheRef.current.delete(i);
      }
    }
    // 批次17 预载错峰：当前 spread 立即载入（ensureLoaded 内仍 await decode，保证切换即显），
    // 其余邻页按距离逐张隔帧（16ms≈一帧）启动——同帧解码量≤1，不再 ±N 全量并发挤占翻页。
    // 每次翻页重建队列（清旧定时器）：新当前页恒为立即档，未被启动的旧邻页按新距离重排。
    const currentSpread = settings.mode === "webtoon" ? [anchor] : (spreads[spreadIndex] ?? []);
    const primary = settings.mode === "webtoon" ? anchor : (spreads[spreadIndex]?.[0] ?? 0);
    const timers: number[] = [];
    let order = 0;
    for (const p of [...want].sort((a, b) => Math.abs(a - primary) - Math.abs(b - primary))) {
      if (order === 0 || currentSpread.includes(p)) void ensureLoaded(p);
      else timers.push(window.setTimeout(() => void ensureLoaded(p), order * 16));
      order++;
    }
    setUrls((prev) => {
      let changed = false;
      const next: Record<number, string> = {};
      for (const k of Object.keys(prev)) {
        const i = Number(k);
        const entry = cacheRef.current.get(i);
        if (want.has(i) && entry) {
          next[i] = entry.url;
          if (entry.url !== prev[i]) changed = true;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [pages, spreadIndex, spreads, anchor, settings.mode, settings.fit]);

  useEffect(() => {
    onApi({
      turn: (direction: TurnDirection) => {
        // B6：翻页先复位缩放（缩放不再阻塞翻页；条漫缩放态容器 overflow:hidden，复位后下一帧再滚动）
        setAutoScroll(false); // 手动翻页停自动滚动
        const wasZoomed = zoomRef.current.scale !== 1;
        if (wasZoomed) resetZoom();
        if (settings.mode === "webtoon") {
          const el = scrollRef.current;
          if (!el) return;
          const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          const opts = {
            top: (direction === "next" ? 1 : -1) * el.clientHeight * 0.85,
            behavior: smooth ? ("smooth" as const) : ("auto" as const),
          };
          if (wasZoomed) requestAnimationFrame(() => el.scrollBy(opts));
          else el.scrollBy(opts);
          return;
        }
        setSpreadIndex((prev) => {
          if (prev === null || spreads.length === 0) return prev;
          const next = direction === "next" ? prev + 1 : prev - 1;
          return Math.min(spreads.length - 1, Math.max(0, next));
        });
      },
      goToPage: (page: number) => {
        setAutoScroll(false);
        const wasZoomed = zoomRef.current.scale !== 1;
        if (wasZoomed) resetZoom();
        if (settings.mode === "webtoon") {
          const el = pageElsRef.current.get(clampPage(page, pages?.length ?? 0));
          if (!el) return;
          const opts = {
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? ("auto" as const) : ("smooth" as const),
            block: "start" as const,
          };
          if (wasZoomed) requestAnimationFrame(() => el.scrollIntoView(opts));
          else el.scrollIntoView(opts);
          return;
        }
        setSpreadIndex(spreadIndexForPage(spreads, page));
      },
      getPageUrl: (page: number) => cacheRef.current.get(page)?.url,
      zoomed: () => zoomRef.current.scale !== 1,
      toggleAutoScroll: () => {
        if (settings.mode !== "webtoon") return;
        // 缩放态容器锁滚：允许暂停、不允许启动
        if (!autoScrollRef.current && zoomRef.current.scale !== 1) return;
        setAutoScroll((v) => !v);
      },
      autoActive: () => settings.mode === "webtoon" && autoScrollRef.current,
    });
  }, [onApi, spreads, settings.mode, pages]);

  // snap webtoon mode to the current page when it (re)mounts
  useEffect(() => {
    if (settings.mode !== "webtoon" || pages === null) return;
    const root = scrollRef.current;
    if (!root) return;
    root.focus({ preventScroll: true });
    const target = pageElsRef.current.get(currentPageRef.current);
    // shortcut: unloaded pages use a fixed placeholder height, so deep restores land approximately
    if (target && target.offsetTop > 0) root.scrollTop = target.offsetTop;
  }, [settings.mode, pages]);

  useEffect(() => {
    if (settings.mode !== "webtoon" || pages === null) return;
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (Number.isNaN(page)) continue;
          if (entry.isIntersecting) visible.add(page);
          else visible.delete(page);
        }
        if (visible.size === 0) return;
        let min = Infinity;
        for (const p of visible) if (p < min) min = p;
        setAnchor((prev) => (prev === min ? prev : min));
      },
      { root, rootMargin: "20% 0px 20% 0px" },
    );
    for (const el of pageElsRef.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [settings.mode, pages]);

  // B11 自动滚动：rAF 按帧距累积 scrollTop；滚轮/键盘/指针=用户接管即停；到底自动停并轻提示。
  // 脚本改 scrollTop 不产生这些事件，无需区分自身滚动；reduced-motion 下照常（功能非装饰）。
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    let last = performance.now();
    let accum = 0; // B12：浮点累积器——scrollTop 整像素化会吞 <1px/帧增量，攒满整像素才写、余数留存，速度 20-240 全程线性
    const stop = () => setAutoScroll(false);
    // B12：空格/↑/↓ 已被 ReaderPage 接管为播放暂停与调速键，不算“用户接管滚动”，不触发停止
    const onUserInput = (e: Event) => {
      const k = (e as KeyboardEvent).key;
      if (k === " " || k === "ArrowUp" || k === "ArrowDown") return;
      stop();
    };
    el.addEventListener("wheel", onUserInput, { passive: true });
    el.addEventListener("keydown", onUserInput);
    el.addEventListener("pointerdown", onUserInput, { passive: true });
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); // 后台页回来的大间隔不做跳变
      last = now;
      const step = autoScrollStep(accum, autoSpeedRef.current, dt);
      accum = step.accum;
      if (step.px > 0) el.scrollTop += step.px;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
        stop();
        setAutoEndToast(true);
        window.setTimeout(() => setAutoEndToast(false), 1500);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("wheel", onUserInput);
      el.removeEventListener("keydown", onUserInput);
      el.removeEventListener("pointerdown", onUserInput);
    };
  }, [autoScroll]);

  // B5 zoom: viewport vs content dims decide the pan slack (tall strips / fit-width pages pan end to end)
  function panDims() {
    const stage = stageRef.current;
    if (!stage) return { vw: 0, vh: 0, cw: 0, ch: 0 };
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    const content = settings.mode === "webtoon" ? wrapRef.current : fitRef.current;
    if (settings.mode === "webtoon") return { vw, vh, cw: content?.clientWidth ?? vw, ch: content?.clientHeight ?? vh };
    return { vw, vh, cw: content?.scrollWidth || vw, ch: content?.scrollHeight || vh };
  }

  // 缩放/平移 rAF 化：手势期变换直写容器 style（rAF 合帧），不落 React state——webtoon 数百页 DOM
  // 每帧重渲 diff 是缩放卡顿根因。跨 1x 边界/手势结束才提交 state（zoomed 驱动 cursor/overflow/HUD），
  // 另有 200ms 尾随提交兜底：未提交前任何无关重渲会用陈旧 state 样式覆盖直写值。
  function zoomOriginFor(): string {
    const stage = stageRef.current;
    const vh2 = (stage?.clientHeight ?? 0) / 2;
    return settingsRef.current.mode === "webtoon"
      ? `center ${(scrollRef.current?.scrollTop ?? 0) + vh2}px`
      : `${(fitRef.current?.scrollLeft ?? 0) + (stage?.clientWidth ?? 0) / 2}px ${(fitRef.current?.scrollTop ?? 0) + vh2}px`;
  }
  function writeZoomTransform(z: ZoomState) {
    const el = settingsRef.current.mode === "webtoon" ? wrapRef.current : fitRef.current;
    if (!el) return;
    if (z.scale === 1) {
      el.style.transform = "";
      el.style.transformOrigin = "";
    } else {
      el.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.scale})`;
      el.style.transformOrigin = zoomOriginFor();
    }
  }
  function commitZoomNow() {
    if (zoomFrameRef.current) {
      cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = 0;
    }
    if (zoomCommitTimerRef.current !== null) {
      window.clearTimeout(zoomCommitTimerRef.current);
      zoomCommitTimerRef.current = null;
    }
    const z = zoomRef.current;
    writeZoomTransform(z);
    setZoom((prev) => (prev.scale === z.scale && prev.tx === z.tx && prev.ty === z.ty ? prev : z));
  }
  function zoomGestureWrite(next: ZoomState) {
    zoomRef.current = next;
    if (zoomCommitTimerRef.current !== null) window.clearTimeout(zoomCommitTimerRef.current);
    zoomCommitTimerRef.current = window.setTimeout(commitZoomNow, 200);
    if (!zoomFrameRef.current) {
      zoomFrameRef.current = requestAnimationFrame(() => {
        zoomFrameRef.current = 0;
        writeZoomTransform(zoomRef.current);
      });
    }
  }
  function applyZoomNow(next: ZoomState) {
    zoomRef.current = next;
    commitZoomNow();
  }

  // B11 复原语义：仅重置 scale/pan 到 1x/0，保持当前阅读位置——条漫先把当前视口中心页记下
  // （把 transform 逆映射回内容坐标），复位后 rAF 滚回该页；绝不回跳缩放开始前的旧页。分页模式本就只复位。
  function resetZoom() {
    // 读 ref 而非 state：本函数被 onApi effect（turn/goToPage）长期持有，闭包里的 zoom state 会过期
    const z = zoomRef.current;
    if (z.scale === 1) return;
    const sc = scrollRef.current;
    if (settings.mode === "webtoon" && sc && sc.clientHeight > 0) {
      // 缩放原点=缩放开始时的视口中心（scrollTop 整段锁定不变），故中心内容坐标 = scrollTop+vh/2 - ty/scale
      const center = sc.scrollTop + sc.clientHeight / 2 - z.ty / z.scale;
      let best: HTMLElement | null = null;
      let bestD = Infinity;
      for (const el of pageElsRef.current.values()) {
        const d = Math.abs(el.offsetTop + el.offsetHeight / 2 - center);
        if (d < bestD) {
          bestD = d;
          best = el;
        }
      }
      applyZoomNow({ scale: 1, tx: 0, ty: 0 });
      if (best) requestAnimationFrame(() => best!.scrollIntoView({ block: "center" }));
      return;
    }
    applyZoomNow({ scale: 1, tx: 0, ty: 0 });
  }

  function startPan(e: ReactPointerEvent<HTMLDivElement>) {
    const el = stageRef.current;
    if (!el || zoomRef.current.scale !== 1) return;
    // pointer capture retargets clicks to the stage: never swallow the reset/retry buttons
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const start = zoomRef.current;
    const onMove = (ev: PointerEvent) => {
      const d = panDims();
      zoomGestureWrite({ ...start, ...panClamp(start.tx + ev.clientX - sx, start.ty + ev.clientY - sy, d.vw, d.vh, d.cw, d.ch, start.scale) });
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      commitZoomNow(); // 手势结束才把变换落 state
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  // native listener: React's onWheel is passive at the root, preventDefault needs passive:false.
  // stopPropagation keeps the zoom/pan gesture away from ReaderPage's page-turn wheel handler.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        const rect = el.getBoundingClientRect();
        // anchor the zoom: the point under the cursor stays fixed (origin = stage center)
        const px = e.clientX - rect.left - rect.width / 2;
        const py = e.clientY - rect.top - rect.height / 2;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const z = zoomRef.current;
        const scale = clampZoomScale(z.scale * factor);
        if (scale === z.scale) return;
        const k = scale / z.scale;
        const d = panDims();
        const next = { scale, ...panClamp(px - (px - z.tx) * k, py - (py - z.ty) * k, d.vw, d.vh, d.cw, d.ch, scale) };
        // 跨 1x 边界（zoomed 标志位驱动溢出锁滚/HUD）即时提交；纯变换值走 rAF 直写
        if ((z.scale === 1) !== (scale === 1)) applyZoomNow(next);
        else zoomGestureWrite(next);
        return;
      }
      if (zoomRef.current.scale !== 1) {
        e.preventDefault();
        e.stopPropagation();
        const z = zoomRef.current;
        const d = panDims();
        const p = panClamp(z.tx - e.deltaX, z.ty - e.deltaY, d.vw, d.vh, d.cw, d.ch, z.scale);
        if (p.tx !== z.tx || p.ty !== z.ty) zoomGestureWrite({ ...z, ...p });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (zoomFrameRef.current) {
        cancelAnimationFrame(zoomFrameRef.current);
        zoomFrameRef.current = 0;
      }
      if (zoomCommitTimerRef.current !== null) {
        window.clearTimeout(zoomCommitTimerRef.current);
        zoomCommitTimerRef.current = null;
      }
    };
  }, [settings.mode, pages, error]);

  const zoomTransform = zoomed ? `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})` : undefined;
  // zooming is scroll-locked while active, so the visible-center origin read here stays
  // frozen for the whole zoom session; panClamp's symmetric slack is exact around it
  let zoomOrigin: string | undefined;
  if (zoomed) {
    const stage = stageRef.current;
    const vh2 = (stage?.clientHeight ?? 0) / 2;
    zoomOrigin =
      settings.mode === "webtoon"
        ? `center ${(scrollRef.current?.scrollTop ?? 0) + vh2}px`
        : `${(fitRef.current?.scrollLeft ?? 0) + (stage?.clientWidth ?? 0) / 2}px ${(fitRef.current?.scrollTop ?? 0) + vh2}px`;
  }
  // 浮动小钮公共样式：B12 居中组（bottom:12 落在 62px 底部预留带内，栏浮现也不遮内容）；
  // 组 z(17) 高于热区(14)与两栏(16)——B11 前复原钮 z=3 埋在底热区带下被吞点击
  const HUD_FLOAT: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 10px",
    fontSize: 12,
    borderRadius: 999,
    border: "1px solid var(--wr-hairline)",
    background: "var(--wr-bg)",
    color: "var(--wr-muted)",
    cursor: "pointer",
  };
  const HUD_GROUP: CSSProperties = {
    position: "absolute",
    bottom: 12,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 17,
    display: "inline-flex",
    gap: 8,
  };
  // B6：缩放中可见的“复原”浮动钮（一键回 1x，保持当前阅读位置）
  const resetBtn = zoomed ? (
    <button
      type="button"
      aria-label="复原缩放"
      title="复原缩放"
      onClick={resetZoom}
      style={HUD_FLOAT}
    >
      <IconRefresh />
      复原
    </button>
  ) : null;
  // B11 条漫自动滚动 HUD：缩放态隐藏（缩放中容器锁滚，先复原再播）；B12 移入底部居中组（复原钮左侧）
  const autoBtn = !zoomed ? (
    <button
      type="button"
      aria-pressed={autoScroll}
      title={autoScroll ? "暂停自动滚动" : "自动滚动"}
      onClick={() => setAutoScroll((v) => !v)}
      style={HUD_FLOAT}
    >
      {autoScroll ? <IconPause /> : <IconPlay />}
      {autoScroll ? "暂停" : "自动"}
    </button>
  ) : null;

  // 批次18：文件夹漫画源目录丢失的恢复路径——选新目录 → Rust 校验改写 library_path → 重载阅读器
  async function relinkSource() {
    const picked = await open({ directory: true, multiple: false, title: "重新选择漫画源文件夹" });
    if (!picked || Array.isArray(picked)) return;
    try {
      await relinkImageBook(book.id, picked);
      window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
      setReloadKey((k) => k + 1);
    } catch (e) {
      await showAlert("重链接失败", String(e));
    }
  }

  if (error) {
    const folderComic = book.format === "images" && !book.library_path.toLowerCase().endsWith(".cbz");
    return (
      <div className="wr-image-stage" role="alert" data-theme={theme}>
        <div className="wr-state wr-state-error">
          <div className="wr-state-title">加载失败</div>
          <div className="wr-state-sub" style={{ overflowWrap: "anywhere" }}>
            {error}
          </div>
          {folderComic ? (
            <div className="wr-state-actions">
              <button type="button" className="wr-btn wr-btn-primary" onClick={() => void relinkSource()}>
                源文件夹丢失？重新链接…
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (pages === null || spreadIndex === null) {
    return (
      <div className="wr-image-stage" data-theme={theme}>
        <div className="wr-state wr-state-loading">
          <span className="wr-state-icon" aria-hidden="true">
            <IconRefresh />
          </span>
          <div className="wr-state-title">加载中</div>
        </div>
      </div>
    );
  }

  if (settings.mode === "webtoon") {
    return (
      <div
        className="wr-image-stage"
        data-theme={theme}
        ref={stageRef}
        onPointerDown={startPan}
        onDoubleClick={resetZoom}
        style={zoomed ? { cursor: "grab" } : undefined}
      >
        <div
          className="wr-image-webtoon"
          ref={scrollRef}
          tabIndex={0}
          aria-label="条漫阅读区"
          style={zoomed ? { overflow: "hidden" } : undefined}
        >
          <div
            ref={wrapRef}
            style={{
              width: "100%",
              ...(zoomed ? { transform: zoomTransform, transformOrigin: zoomOrigin } : null),
            }}
          >
            {pages.map((_, i) => (
              <div
                key={i}
                data-page={i}
                // B3: wrap 中间层挡住了列容器 align-items:center，块级 marginInline:auto 恢复水平居中
                style={{ width: `${settings.webtoonWidth}%`, marginInline: "auto" }}
                ref={(el) => {
                  if (el) pageElsRef.current.set(i, el);
                  else pageElsRef.current.delete(i);
                }}
              >
                {urls[i] ? (
                  <img src={urls[i]} alt={`第 ${i + 1} 页`} loading="lazy" decoding="async" draggable={false} />
                ) : (
                  failed.has(i) ? (
                    <button type="button" className="wr-image-loading wr-image-failed" onClick={() => retry(i)}>
                      本页加载失败，点击重试
                    </button>
                  ) : (
                    <div
                      className="wr-image-loading"
                      // 有元数据按宽高比精确预留（替代 min-height:50vh，向上滚动不再被推动）；无元数据回退 CSS 默认
                      style={pageMeta?.[i] ? { aspectRatio: `${pageMeta[i].width} / ${pageMeta[i].height}` } : undefined}
                    />
                  )
                )}
              </div>
            ))}
          </div>
        </div>
        <div style={HUD_GROUP}>
          {resetBtn}
          {autoBtn}
        </div>
        {autoEndToast ? (
          <div
            role="status"
            style={{
              position: "absolute",
              bottom: 56,
              left: "50%",
              transform: "translateX(-50%)",
              fontSize: 12,
              color: "var(--wr-muted)",
              background: "var(--wr-bg)",
              border: "1px solid var(--wr-hairline)",
              borderRadius: 999,
              padding: "4px 12px",
              pointerEvents: "none",
            }}
          >
            已到底部，自动滚动停止
          </div>
        ) : null}
      </div>
    );
  }

  return (
  <div
    className="wr-image-stage"
    data-theme={theme}
    ref={stageRef}
    onPointerDown={startPan}
    onDoubleClick={resetZoom}
    style={zoomed ? { cursor: "grab" } : undefined}
  >
    {snap ? (
      <div
        className="wr-image-fit wr-image-fit--out"
        data-fit={settings.fit}
        aria-hidden="true"
        style={{ "--slide-dir": snap.dir, animationDuration: `${turnSpeedMs}ms` } as CSSProperties}
        onAnimationEnd={() => setSnap(null)}
      >
        {displayOrder(snap.pages, settings.rtl).map((p) =>
          snap.urls[p] ? (
            <img key={p} src={snap.urls[p]} alt="" className="wr-img-instant" draggable={false} />
          ) : null,
        )}
      </div>
    ) : null}
    <div
      className={snap ? "wr-image-fit wr-image-fit--in" : "wr-image-fit"}
      data-fit={settings.fit}
      ref={fitRef}
      style={{
        // 滑动过渡时长与 epub 翻页速度同源（覆盖 weread.css 的 250ms）
        ...(snap ? ({ "--slide-dir": snap.dir, animationDuration: `${turnSpeedMs}ms` } as CSSProperties) : null),
        // zoomed: pan/translate the whole layer and suppress the fit=width/original overflow scroll
        ...(zoomed
          ? { transform: zoomTransform, transformOrigin: zoomOrigin, overflow: "hidden" as const }
          : null),
      }}
    >
      {displayOrder(spreads[shownSpread ?? spreadIndex] ?? spreads[spreadIndex] ?? [], settings.rtl).map((p) =>
        urls[p] ? (
          <img
            key={p}
            src={urls[p]}
            alt={"第 " + (p + 1) + " 页"}
            className={reveal ? undefined : "wr-img-instant"}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ) : failed.has(p) ? (
          <button key={p} type="button" className="wr-image-loading wr-image-failed" onClick={() => retry(p)}>
            本页加载失败，点击重试
          </button>
        ) : (
          <div
            key={p}
            className="wr-image-loading"
            style={pageMeta?.[p] ? { aspectRatio: `${pageMeta[p].width} / ${pageMeta[p].height}` } : undefined}
          />
        ),
      )}
    </div>
    <div style={HUD_GROUP}>{resetBtn}</div>
  </div>
);
}

// memo：onRelocated/onApi 由 ReaderPage useCallback 稳定后，沉浸栏显隐（chrome bump）不再重渲整棵阅读器
export default memo(ImageReaderImpl);
