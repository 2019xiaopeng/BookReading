import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

import type { Book } from "../../tauri/invoke";
import { getReadingState } from "../../tauri/invoke";
import type { Theme } from "../settings/types";
import { IconPause, IconPlay, IconRefresh } from "../../ui/icons";
import { useElementSize } from "../../ui/useElementSize";
import { loadPdf, pdfLoadErrorMessage, renderPdfPage } from "./api";
import { autoScrollStep, type ImageReaderSettings } from "../image/layout";
import {
  clampPage,
  clampZoomScale,
  panClamp,
  parsePdfCfi,
  type TurnDirection,
} from "./layout";

/** 与 ImageReaderApi 同形（消费面对齐 ReaderPage）：PDF 无常驻 blob 页（位图是 canvas），getPageUrl 为占位桩 */
export type PdfReaderApi = {
  turn: (direction: TurnDirection) => void;
  goToPage: (page: number) => void;
  getPageUrl: (page: number) => string | undefined;
  /** 页面面板缩略图：小尺寸渲染→objectURL；不可用返回 undefined */
  renderThumb: (page: number) => Promise<string | undefined>;
  zoomed: () => boolean;
  /** 批次15：连续滚动（webtoon 枚举）空格播放/暂停，与条漫同语义 */
  toggleAutoScroll: () => void;
  autoActive: () => boolean;
};

type Props = {
  book: Book;
  settings: ImageReaderSettings;
  theme: Theme;
  onRelocated: (page: number, pageCount: number) => void;
  onApi: (api: PdfReaderApi) => void;
};

// 与漫画同一红线：当前页 ±3 常驻位图，其余回收（批次16 由 ±2 放宽一页，翻页少一次重渲等待）
const PRELOAD_PAGES = 3;

type PageDim = { w: number; h: number };

function drawBitmap(target: HTMLCanvasElement, src: HTMLCanvasElement) {
  if (target.width !== src.width) target.width = src.width;
  if (target.height !== src.height) target.height = src.height;
  const ctx = target.getContext("2d");
  if (ctx) ctx.drawImage(src, 0, 0);
}

export default function PdfReader({ book, theme, settings, onRelocated, onApi }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null); // 身份标记：就绪/换书重画；实际渲染走 docRef
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState<Record<number, PageDim>>({});
  const [page, setPage] = useState(0); // 分页模式当前页
  const [anchor, setAnchor] = useState(0); // 连续滚动当前页（可见最小页）
  const [failed, setFailed] = useState<Set<number>>(new Set());
  const [tick, setTick] = useState(0); // 位图缓存版本：缓存变动后触发重画
  const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  const zoomed = zoom.scale !== 1;
  // 批次15：连续滚动自动滚动（复制条漫 B11/B12 实现，速度随批次16 改存 pdf_reader_settings）
  const [autoScroll, setAutoScroll] = useState(false);
  const [autoEndToast, setAutoEndToast] = useState(false);

  const docRef = useRef<PDFDocumentProxy | null>(null);
  const destroyRef = useRef<(() => Promise<void>) | null>(null);
  const dimsRef = useRef<Record<number, PageDim>>({});
  const bitmapsRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const tasksRef = useRef<Map<number, RenderTask>>(new Map());
  const inflightRef = useRef<Set<number>>(new Set());
  const cacheKeyRef = useRef("");
  const epochRef = useRef(0);
  const pageCountRef = useRef(0);
  const zoomRef = useRef(zoom);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageElsRef = useRef<Map<number, HTMLElement>>(new Map());
  const currentPageRef = useRef(0);
  const reportedRef = useRef<number | null>(null);
  const settingsRef = useRef(settings);
  const onRelocatedRef = useRef(onRelocated);
  const autoSpeedRef = useRef(settings.autoScrollSpeed);
  const autoScrollRef = useRef(false);
  const stageSize = useElementSize(stageRef);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    onRelocatedRef.current = onRelocated;
  }, [onRelocated]);
  useEffect(() => {
    autoSpeedRef.current = settings.autoScrollSpeed;
  }, [settings.autoScrollSpeed]);
  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    pageCountRef.current = pageCount;
  }, [pageCount]);

  // 模式切换：停自动滚动 + 复位缩放（分页/滚动的缩放几何不同，各模式从 1x 重新开始）
  useEffect(() => {
    setAutoScroll(false);
    if (zoomRef.current.scale !== 1) setZoom({ scale: 1, tx: 0, ty: 0 });
  }, [settings.mode]);

  // ---- 加载：pdf 字节 → pdfjs 文档；恢复 pdf:N 进度；后台补全页尺寸 ----
  useEffect(() => {
    let cancelled = false;
    epochRef.current += 1;
    setError(null);
    setDoc(null);
    setPageCount(0);
    setPage(0);
    setAnchor(0);
    setDims({});
    setFailed(new Set());
    reportedRef.current = null;
    dimsRef.current = {};
    bitmapsRef.current.clear();
    for (const t of tasksRef.current.values()) t.cancel();
    tasksRef.current.clear();
    inflightRef.current.clear();

    const loadDims = async (indices: number[]) => {
      const d = docRef.current;
      if (!d) return;
      const batch: Record<number, PageDim> = {};
      await Promise.all(
        indices.map((i) =>
          d
            .getPage(i + 1)
            .then((p) => {
              const v = p.getViewport({ scale: 1 });
              batch[i] = { w: v.width, h: v.height };
            })
            .catch(() => undefined),
        ),
      );
      if (cancelled || Object.keys(batch).length === 0) return;
      dimsRef.current = { ...dimsRef.current, ...batch };
      setDims((prev) => ({ ...prev, ...batch }));
    };

    (async () => {
      try {
        const handle = await loadPdf(book.library_path);
        if (cancelled) {
          void handle.destroy();
          return;
        }
        const d = handle.doc;
        docRef.current = d;
        destroyRef.current = handle.destroy;
        setDoc(d);
        setPageCount(d.numPages);
        pageCountRef.current = d.numPages;
        const state = await getReadingState(book.id);
        if (cancelled) return;
        const start = clampPage(parsePdfCfi(state?.cfi) ?? 0, d.numPages);
        currentPageRef.current = start;
        setPage(start);
        setAnchor(start);
        // 先取首屏窗口尺寸（尽快开渲染），再后台补全其余页
        const win = Array.from({ length: d.numPages }, (_, i) => i).filter(
          (i) => i >= start - PRELOAD_PAGES && i <= start + PRELOAD_PAGES,
        );
        await loadDims(win);
        void loadDims(Array.from({ length: d.numPages }, (_, i) => i).filter((i) => !win.includes(i)));
      } catch (e) {
        if (!cancelled) setError(pdfLoadErrorMessage(e));
      }
    })();

    return () => {
      cancelled = true;
      epochRef.current += 1;
      for (const t of tasksRef.current.values()) t.cancel();
      tasksRef.current.clear();
      inflightRef.current.clear();
      bitmapsRef.current.clear();
      void destroyRef.current?.();
      destroyRef.current = null;
      docRef.current = null;
    };
  }, [book.id]);

  // ---- 渲染治理：renderScale 随容器/模式/适配变化 ⇒ 作废整缓存（位图尺寸失效） ----
  const cacheKey = `${settings.mode}/${settings.fit}/${stageSize.width}x${stageSize.height}`;
  useEffect(() => {
    if (cacheKey === cacheKeyRef.current) return;
    cacheKeyRef.current = cacheKey;
    for (const t of tasksRef.current.values()) t.cancel();
    tasksRef.current.clear();
    inflightRef.current.clear();
    bitmapsRef.current.clear();
    setFailed(new Set());
    setTick((t) => t + 1);
  }, [cacheKey]);

  function renderScaleFor(dim: PageDim): number {
    const stage = stageRef.current;
    const s = settingsRef.current;
    if (!stage || stage.clientWidth <= 0 || stage.clientHeight <= 0) return 0;
    if (s.mode === "webtoon" || s.fit === "width") return stage.clientWidth / dim.w;
    if (s.fit === "height") return stage.clientHeight / dim.h;
    return 1; // original
  }

  async function ensureRendered(index: number) {
    const d = docRef.current;
    if (!d || index < 0 || index >= pageCountRef.current) return;
    if (bitmapsRef.current.has(index) || inflightRef.current.has(index)) return;
    const dim = dimsRef.current[index];
    if (!dim) return; // 尺寸未就绪：dims 到位后 effect 重跑
    const scale = renderScaleFor(dim);
    if (scale <= 0) return;
    inflightRef.current.add(index);
    const epoch = epochRef.current;
    try {
      const { canvas, renderTask } = await renderPdfPage(d, index + 1, scale);
      if (epoch !== epochRef.current) return;
      tasksRef.current.set(index, renderTask);
      try {
        await renderTask.promise;
      } finally {
        tasksRef.current.delete(index);
      }
      if (epoch !== epochRef.current) return;
      bitmapsRef.current.set(index, canvas);
      setTick((t) => t + 1);
    } catch (e) {
      if (epoch !== epochRef.current) return;
      // 窗口外取消（跳页防卡）不算失败：页面可正常重渲染
      if (e && typeof e === "object" && (e as { name?: string }).name === "RenderingCancelledException") return;
      setFailed((prev) => {
        const next = new Set(prev);
        next.add(index);
        return next;
      });
    } finally {
      inflightRef.current.delete(index);
    }
  }

  function retry(index: number) {
    setFailed((prev) => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
    void ensureRendered(index);
  }

  // 预载窗口（当前 ±2 常驻，窗口外回收）——与漫画 LRU 语义一致
  useEffect(() => {
    if (doc === null) return;
    const current = settings.mode === "webtoon" ? anchor : page;
    const want = new Set<number>();
    for (let i = current - PRELOAD_PAGES; i <= current + PRELOAD_PAGES; i++) {
      if (i >= 0 && i < pageCount) want.add(i);
    }
    for (const i of want) void ensureRendered(i);
    // 跳页防卡：窗口外的在途渲染立即取消；窗口外位图回收
    for (const [i, t] of tasksRef.current) {
      if (!want.has(i)) {
        t.cancel();
        tasksRef.current.delete(i);
      }
    }
    for (const i of bitmapsRef.current.keys()) {
      if (!want.has(i)) bitmapsRef.current.delete(i);
    }
  }, [doc, page, anchor, settings.mode, dims, tick]);

  // ---- 进度上报（relocated 语义对齐漫画）----
  const activePage = settings.mode === "webtoon" ? anchor : page;
  useEffect(() => {
    if (doc === null || pageCount === 0) return;
    if (reportedRef.current === activePage) return;
    reportedRef.current = activePage;
    currentPageRef.current = activePage;
    onRelocatedRef.current(activePage, pageCount);
  }, [activePage, doc, pageCount]);

  // ---- 滚动模式：可见页锚定 + 初始落位 ----
  // 批次17 修复：doc 提交时后台页尺寸未就绪、占位无高度 → offsetTop≈0，落位被跳过且不重试。
  // 落位需等恢复页之前所有页的尺寸（它们决定 offsetTop）；后台 loadDims 补全后（dims 变更）一次性跳准。
  // shortcut: 恢复页之前有个别页尺寸获取失败时会等不到而停在顶部，与修复前行为一致，可滚动自行定位
  const initialScrollRef = useRef(false);
  useEffect(() => {
    if (settings.mode !== "webtoon") {
      initialScrollRef.current = false; // 离开滚动模式复位：再次进入时重新锚定当前页
      return;
    }
    if (doc === null) return;
    const root = scrollRef.current;
    if (!root || initialScrollRef.current) return;
    const start = currentPageRef.current;
    for (let i = 0; i < start; i++) {
      if (!dimsRef.current[i]) return;
    }
    initialScrollRef.current = true;
    root.focus({ preventScroll: true });
    const target = pageElsRef.current.get(start);
    if (target && target.offsetTop > 0) root.scrollTop = target.offsetTop;
  }, [settings.mode, doc, dims]);

  useEffect(() => {
    if (settings.mode !== "webtoon" || doc === null) return;
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const p = Number((entry.target as HTMLElement).dataset.page);
          if (Number.isNaN(p)) continue;
          if (entry.isIntersecting) visible.add(p);
          else visible.delete(p);
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
  }, [settings.mode, doc]);

  // 批次15 自动滚动（复制条漫实现）：rAF 按帧距浮点累积 scrollTop；滚轮/键盘/指针=用户接管即停；
  // 空格/↑/↓ 已被 ReaderPage 接管为播放暂停与调速键，不算“用户接管”；到底自动停并轻提示
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    let last = performance.now();
    let accum = 0;
    const stop = () => setAutoScroll(false);
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

  // ---- 缩放/平移（复制漫画实现：光标锚点缩放 + 平移钳制 + 复原保持位置） ----
  function panDims() {
    const stage = stageRef.current;
    if (!stage) return { vw: 0, vh: 0, cw: 0, ch: 0 };
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    const content = settings.mode === "webtoon" ? wrapRef.current : fitRef.current;
    if (settings.mode === "webtoon") return { vw, vh, cw: content?.clientWidth ?? vw, ch: content?.clientHeight ?? vh };
    return { vw, vh, cw: content?.scrollWidth || vw, ch: content?.scrollHeight || vh };
  }

  function resetZoom() {
    const z = zoomRef.current;
    if (z.scale === 1) return;
    const sc = scrollRef.current;
    if (settings.mode === "webtoon" && sc && sc.clientHeight > 0) {
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
      setZoom({ scale: 1, tx: 0, ty: 0 });
      if (best) requestAnimationFrame(() => best!.scrollIntoView({ block: "center" }));
      return;
    }
    setZoom({ scale: 1, tx: 0, ty: 0 });
  }

  function startPan(e: ReactPointerEvent<HTMLDivElement>) {
    const el = stageRef.current;
    if (!el || zoomRef.current.scale === 1) return;
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const start = zoomRef.current;
    const onMove = (ev: PointerEvent) => {
      const d = panDims();
      setZoom({ ...start, ...panClamp(start.tx + ev.clientX - sx, start.ty + ev.clientY - sy, d.vw, d.vh, d.cw, d.ch, start.scale) });
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  // native listener：Ctrl+滚轮缩放（光标锚点）、缩放态滚轮=平移；与漫画同规则
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left - rect.width / 2;
        const py = e.clientY - rect.top - rect.height / 2;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        setZoom((z) => {
          const scale = clampZoomScale(z.scale * factor);
          if (scale === z.scale) return z;
          const k = scale / z.scale;
          const d = panDims();
          return { scale, ...panClamp(px - (px - z.tx) * k, py - (py - z.ty) * k, d.vw, d.vh, d.cw, d.ch, scale) };
        });
        return;
      }
      if (zoomRef.current.scale !== 1) {
        e.preventDefault();
        e.stopPropagation();
        setZoom((z) => {
          const d = panDims();
          const p = panClamp(z.tx - e.deltaX, z.ty - e.deltaY, d.vw, d.vh, d.cw, d.ch, z.scale);
          return p.tx === z.tx && p.ty === z.ty ? z : { ...z, ...p };
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [settings.mode, doc, error]);

  // ---- ReaderPage 消费面 ----
  useEffect(() => {
    onApi({
      turn: (direction: TurnDirection) => {
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
        setPage((prev) => Math.min(pageCountRef.current - 1, Math.max(0, prev + (direction === "next" ? 1 : -1))));
      },
      goToPage: (p: number) => {
        setAutoScroll(false);
        const target = clampPage(p, pageCountRef.current);
        const wasZoomed = zoomRef.current.scale !== 1;
        if (wasZoomed) resetZoom();
        if (settings.mode === "webtoon") {
          const el = pageElsRef.current.get(target);
          if (!el) return;
          const opts = {
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? ("auto" as const) : ("smooth" as const),
            block: "start" as const,
          };
          if (wasZoomed) requestAnimationFrame(() => el.scrollIntoView(opts));
          else el.scrollIntoView(opts);
          return;
        }
        setPage(target);
      },
      getPageUrl: () => undefined, // PDF 位图是离屏 canvas 非 blob，页面面板走 renderThumb
      renderThumb: async (p: number) => {
        const d = docRef.current;
        const dim = dimsRef.current[p];
        if (!d || !dim || p < 0 || p >= pageCountRef.current) return undefined;
        const scale = Math.min(1, 150 / dim.w);
        try {
          const { canvas, renderTask } = await renderPdfPage(d, p + 1, scale);
          await renderTask.promise;
          return await new Promise<string | undefined>((resolve) =>
            canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : undefined), "image/png"),
          );
        } catch {
          return undefined;
        }
      },
      zoomed: () => zoomRef.current.scale !== 1,
      toggleAutoScroll: () => {
        if (settings.mode !== "webtoon") return;
        // 缩放态容器锁滚：允许暂停、不允许启动
        if (!autoScrollRef.current && zoomRef.current.scale !== 1) return;
        setAutoScroll((v) => !v);
      },
      autoActive: () => settings.mode === "webtoon" && autoScrollRef.current,
    });
  }, [onApi, settings.mode, doc]);

  const zoomTransform = zoomed ? `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})` : undefined;
  let zoomOrigin: string | undefined;
  if (zoomed) {
    const stage = stageRef.current;
    const vh2 = (stage?.clientHeight ?? 0) / 2;
    zoomOrigin =
      settings.mode === "webtoon"
        ? `center ${(scrollRef.current?.scrollTop ?? 0) + vh2}px`
        : `${(fitRef.current?.scrollLeft ?? 0) + (stage?.clientWidth ?? 0) / 2}px ${(fitRef.current?.scrollTop ?? 0) + vh2}px`;
  }
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
  const resetBtn = zoomed ? (
    <button type="button" aria-label="复原缩放" title="复原缩放" onClick={resetZoom} style={HUD_FLOAT}>
      <IconRefresh />
      复原
    </button>
  ) : null;
  // 批次15：连续滚动自动滚动 HUD（同条漫：缩放态隐藏，暂停不受限）
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

  // 分页模式 canvas 尺寸语义 = 漫画 img 的 fit 三档（复用 .wr-image-fit 容器规则）
  const pagedCanvasStyle: CSSProperties =
    settings.fit === "height"
      ? { maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto" }
      : settings.fit === "width"
        ? { width: "100%", height: "auto" }
        : { maxWidth: "none", maxHeight: "none", margin: "auto" };

  // 单一根节点跨加载/错误/内容态常驻：stageRef 稳定，useElementSize 的 ResizeObserver 才能贯穿状态切换
  const pagedBitmap = bitmapsRef.current.get(page);
  return (
    <div
      className="wr-image-stage"
      data-theme={theme}
      role={error ? "alert" : undefined}
      ref={stageRef}
      onPointerDown={startPan}
      onDoubleClick={resetZoom}
      style={zoomed ? { cursor: "grab" } : undefined}
    >
      {error ? (
        <div className="wr-state wr-state-error">
          <div className="wr-state-title">加载失败</div>
          <div className="wr-state-sub" style={{ overflowWrap: "anywhere" }}>
            {error}
          </div>
        </div>
      ) : doc === null ? (
        <div className="wr-state wr-state-loading">
          <span className="wr-state-icon" aria-hidden="true">
            <IconRefresh />
          </span>
          <div className="wr-state-title">加载中</div>
        </div>
      ) : settings.mode === "webtoon" ? (
        <>
          <div
            className="wr-image-webtoon"
            ref={scrollRef}
            tabIndex={0}
            aria-label="PDF 连续滚动阅读区"
            style={zoomed ? { overflow: "hidden" } : undefined}
          >
            <div
              ref={wrapRef}
              style={{
                width: "100%",
                ...(zoomed ? { transform: zoomTransform, transformOrigin: zoomOrigin } : null),
              }}
            >
              {Array.from({ length: pageCount }, (_, i) => {
                const bitmap = bitmapsRef.current.get(i);
                return (
                  <div
                    key={i}
                    data-page={i}
                    // 批次15：连续滚动宽度档与条漫共用（webtoonWidth 百分比居中）
                    style={{ width: `${settings.webtoonWidth}%`, marginInline: "auto" }}
                    ref={(el) => {
                      if (el) pageElsRef.current.set(i, el);
                      else pageElsRef.current.delete(i);
                    }}
                  >
                    {bitmap ? (
                      <canvas
                        ref={(el) => {
                          if (el) drawBitmap(el, bitmap);
                        }}
                        style={{ display: "block", width: "100%", height: "auto" }}
                        aria-label={`第 ${i + 1} 页`}
                      />
                    ) : failed.has(i) ? (
                      <button type="button" className="wr-image-loading wr-image-failed" onClick={() => retry(i)}>
                        本页渲染失败，点击重试
                      </button>
                    ) : (
                      <div
                        className="wr-image-loading"
                        style={dims[i] ? { aspectRatio: `${dims[i].w} / ${dims[i].h}` } : undefined}
                      />
                    )}
                  </div>
                );
              })}
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
        </>
      ) : (
        <>
          <div
            className="wr-image-fit"
            data-fit={settings.fit}
            ref={fitRef}
            style={
              zoomed
                ? { transform: zoomTransform, transformOrigin: zoomOrigin, overflow: "hidden" as const }
                : undefined
            }
          >
            {pagedBitmap ? (
              <canvas
                ref={(el) => {
                  if (el) drawBitmap(el, pagedBitmap);
                }}
                style={pagedCanvasStyle}
                aria-label={`第 ${page + 1} 页`}
              />
            ) : failed.has(page) ? (
              <button type="button" className="wr-image-loading wr-image-failed" onClick={() => retry(page)}>
                本页渲染失败，点击重试
              </button>
            ) : (
              <div
                className="wr-image-loading"
                style={dims[page] ? { aspectRatio: `${dims[page].w} / ${dims[page].h}`, width: "100%" } : undefined}
              />
            )}
          </div>
          <div style={HUD_GROUP}>{resetBtn}</div>
        </>
      )}
    </div>
  );
}
