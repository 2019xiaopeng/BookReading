import { useEffect, useMemo, useRef, useState } from "react";

import type { Book } from "../../tauri/invoke";
import { getReadingState } from "../../tauri/invoke";
import { listImagePages, readImagePage } from "./api";
import {
  WIDE_PAGE_RATIO,
  buildSpreads,
  clampPage,
  displayOrder,
  parseImageCfi,
  spreadIndexForPage,
  type ImageReaderSettings,
  type TurnDirection,
} from "./layout";

export type ImageReaderApi = {
  turn: (direction: TurnDirection) => void;
};

type Props = {
  book: Book;
  settings: ImageReaderSettings;
  onRelocated: (page: number, pageCount: number) => void;
  onApi: (api: ImageReaderApi) => void;
};

// batch-2 red line: at most current +/- 2 pages may stay resident as blobs
const PRELOAD_PAGES = 2;

function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "gif" || ext === "avif" || ext === "bmp") {
    return `image/${ext === "jpg" ? "jpeg" : ext}`;
  }
  return "application/octet-stream";
}

export default function ImageReader({ book, settings, onRelocated, onApi }: Props) {
  const [pages, setPages] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spreadIndex, setSpreadIndex] = useState<number | null>(null);
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [wide, setWide] = useState<Record<number, boolean>>({});
  const [failed, setFailed] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageElsRef = useRef<Map<number, HTMLElement>>(new Map());
  const cacheRef = useRef<Map<number, string>>(new Map());
  const loadingRef = useRef<Set<number>>(new Set());
  const wantedRef = useRef<Set<number>>(new Set());
  const epochRef = useRef(0);
  const currentPageRef = useRef(0);
  const reportedRef = useRef<number | null>(null);
  const settingsRef = useRef(settings);
  const onRelocatedRef = useRef(onRelocated);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    onRelocatedRef.current = onRelocated;
  }, [onRelocated]);

  const spreads = useMemo(() => {
    const count = pages?.length ?? 0;
    return buildSpreads(
      count,
      Array.from({ length: count }, (_, i) => wide[i] === true),
      settings.layout,
    );
  }, [pages, wide, settings.layout]);

  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setError(null);
    setSpreadIndex(null);
    setWide({});
    setUrls({});
    setFailed(new Set());
    reportedRef.current = null;
    (async () => {
      try {
        const names = await listImagePages(book.id);
        if (cancelled) return;
        if (names.length === 0) {
          setPages([]);
          setError("这本书没有可读的页面");
          return;
        }
        const state = await getReadingState(book.id);
        if (cancelled) return;
        const start = clampPage(parseImageCfi(state?.cfi) ?? 0, names.length);
        currentPageRef.current = start;
        setAnchor(start);
        setPages(names);
        const plain = buildSpreads(names.length, names.map(() => false), settingsRef.current.layout);
        setSpreadIndex(spreadIndexForPage(plain, start));
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      epochRef.current += 1;
      wantedRef.current = new Set();
      for (const url of cacheRef.current.values()) URL.revokeObjectURL(url);
      cacheRef.current.clear();
    };
  }, [book.id]);

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

  function retry(index: number) {
    setFailed((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
    void ensureLoaded(index);
  }

  async function ensureLoaded(index: number) {
    const count = pages?.length ?? 0;
    if (index < 0 || index >= count) return;
    if (cacheRef.current.has(index) || loadingRef.current.has(index)) return;
    loadingRef.current.add(index);
    const epoch = epochRef.current;
    try {
      const bytes = await readImagePage(book.id, index);
      // stale fetch (want set moved on / book switched / unmounted): never let it become a resident blob
      if (epoch !== epochRef.current || !wantedRef.current.has(index)) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeFor(pages?.[index] ?? "") }));
      cacheRef.current.set(index, url);
      setUrls((prev) => ({ ...prev, [index]: url }));
      // probe the aspect so wide pages can claim a full spread in double mode
      const probe = new Image();
      probe.src = url;
      await probe.decode().catch(() => undefined);
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
    wantedRef.current = want;
    for (const p of want) void ensureLoaded(p);
    for (const [i, url] of cacheRef.current) {
      if (!want.has(i)) {
        URL.revokeObjectURL(url);
        cacheRef.current.delete(i);
      }
    }
    setUrls((prev) => {
      if (Object.keys(prev).every((k) => want.has(Number(k)))) return prev;
      const next: Record<number, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (want.has(Number(k))) next[Number(k)] = v;
      }
      return next;
    });
  }, [pages, spreadIndex, spreads, anchor, settings.mode]);

  useEffect(() => {
    onApi({
      turn: (direction: TurnDirection) => {
        if (settings.mode === "webtoon") {
          const el = scrollRef.current;
          if (!el) return;
          const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          el.scrollBy({ top: (direction === "next" ? 1 : -1) * el.clientHeight * 0.85, behavior: smooth ? "smooth" : "auto" });
          return;
        }
        setSpreadIndex((prev) => {
          if (prev === null || spreads.length === 0) return prev;
          const next = direction === "next" ? prev + 1 : prev - 1;
          return Math.min(spreads.length - 1, Math.max(0, next));
        });
      },
    });
  }, [onApi, spreads, settings.mode]);

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

  if (error) {
    return (
      <div className="wr-image-stage" role="alert">
        <div className="wr-muted" style={{ padding: 16, textAlign: "center" }}>
          加载失败：{error}
        </div>
      </div>
    );
  }

  if (pages === null || spreadIndex === null) {
    return (
      <div className="wr-image-stage">
        <div className="wr-muted">加载中…</div>
      </div>
    );
  }

  if (settings.mode === "webtoon") {
    return (
      <div className="wr-image-stage">
        <div className="wr-image-webtoon" ref={scrollRef} tabIndex={0} aria-label="条漫阅读区">
          {pages.map((_, i) => (
            <div
              key={i}
              data-page={i}
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
                  <div className="wr-image-loading" />
                )
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="wr-image-stage">
      <div className="wr-image-fit" data-fit={settings.fit}>
        {displayOrder(spreads[spreadIndex] ?? [], settings.rtl).map((p) =>
          urls[p] ? (
            <img key={p} src={urls[p]} alt={`第 ${p + 1} 页`} loading="lazy" decoding="async" draggable={false} />
          ) : (
            failed.has(p) ? (
              <button key={p} type="button" className="wr-image-loading wr-image-failed" onClick={() => retry(p)}>
                本页加载失败，点击重试
              </button>
            ) : (
              <div key={p} className="wr-image-loading" />
            )
          ),
        )}
      </div>
    </div>
  );
}
