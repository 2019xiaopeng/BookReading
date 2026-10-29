import { useCallback, useEffect, useRef, useState } from "react";
import { readImagePage } from "./api";
import { clampPage } from "./layout";

type Props = {
  bookId: string;
  pageCount: number;
  currentPage: number;
  goTo: (page: number) => void;
  /** resident blob from the reader preload window, avoids a duplicate fetch */
  getResidentUrl?: (page: number) => string | undefined;
  /** PDF 等非图片源：由 reader 自渲染缩略图并返回 objectURL（缺省走 readImagePage）；暂不可用可返回 undefined */
  fetchThumb?: (page: number) => Promise<string | undefined> | undefined;
};

// shortcut: thumbnails are full-size blobs (no Rust downscale); LRU hard cap 48 张（批次16 随预载窗口放宽）; reader cache untouched
const THUMB_LIMIT = 48;
const thumbs = new Map<string, string>(); // `${bookId}:${page}` -> object URL, LRU by insertion order

export default function PagesPanel({ bookId, pageCount, currentPage, goTo, getResidentUrl, fetchThumb }: Props) {
  const [loaded, setLoaded] = useState<Set<number>>(new Set());
  const [jumpText, setJumpText] = useState("");
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cellsRef = useRef(new Map<number, HTMLElement>());
  const inflightRef = useRef(new Set<number>());
  const residentRef = useRef(getResidentUrl);
  const fetchThumbRef = useRef(fetchThumb);

  useEffect(() => {
    residentRef.current = getResidentUrl;
    fetchThumbRef.current = fetchThumb;
  });

  useEffect(() => {
    setLoaded(new Set());
    inflightRef.current.clear();
  }, [bookId]);

  // E9：面板打开（挂载）即滚到当前页居中；面板开着翻页不追滚（打开行为，不是跟随行为）
  useEffect(() => {
    cellsRef.current.get(currentPage)?.scrollIntoView({ block: "center" });
  }, [bookId]);

  // E9：底部页码直达（钳 1..pageCount）
  const jump = useCallback(() => {
    const n = Number.parseInt(jumpText, 10);
    if (!Number.isFinite(n)) return;
    goTo(clampPage(n - 1, pageCount));
    setJumpText("");
  }, [jumpText, pageCount, goTo]);

  const ensureThumb = useCallback(
    (page: number) => {
      const key = `${bookId}:${page}`;
      const hit = thumbs.get(key);
      if (hit) {
        thumbs.delete(key);
        thumbs.set(key, hit);
        setLoaded((prev) => (prev.has(page) ? prev : new Set(prev).add(page)));
        return;
      }
      const resident = residentRef.current?.(page);
      if (resident) {
        setLoaded((prev) => new Set(prev).add(page));
        return;
      }
      if (inflightRef.current.has(page)) return;
      inflightRef.current.add(page);
      const load =
        fetchThumbRef.current ??
        ((p: number) => readImagePage(bookId, p).then((bytes) => URL.createObjectURL(new Blob([new Uint8Array(bytes)]))));
      const urlPromise = load(page);
      if (!urlPromise) {
        inflightRef.current.delete(page); // reader 尚未就绪：不标记已加载，下次进入视口重试
        return;
      }
      urlPromise
        .then((url) => {
          if (!url) return; // 暂不可用：不标记已加载，下次进入视口重试
          const key2 = `${bookId}:${page}`;
          thumbs.delete(key2);
          thumbs.set(key2, url);
          const evicted: number[] = [];
          while (thumbs.size > THUMB_LIMIT) {
            const oldest = thumbs.keys().next().value;
            if (oldest === undefined) break;
            const u = thumbs.get(oldest);
            thumbs.delete(oldest);
            if (u) URL.revokeObjectURL(u);
            evicted.push(Number(oldest.split(":").pop()));
          }
          setLoaded((prev) => {
            let next = prev.has(page) ? prev : new Set(prev).add(page);
            if (evicted.length > 0) {
              next = new Set(next);
              for (const p of evicted) next.delete(p);
            }
            return next;
          });
        })
        .catch(() => undefined)
        .finally(() => inflightRef.current.delete(page));
    },
    [bookId],
  );

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (!Number.isNaN(page)) ensureThumb(page);
        }
      },
      { rootMargin: "200px" },
    );
    for (const el of cellsRef.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [ensureThumb, pageCount]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="wr-image-pages" ref={gridRef} role="list" aria-label="页面目录">
        {Array.from({ length: pageCount }, (_, i) => {
          const url = loaded.has(i) ? thumbs.get(`${bookId}:${i}`) ?? residentRef.current?.(i) : undefined;
          return (
            <button
              key={i}
              type="button"
              className="wr-image-pages-btn"
              data-page={i}
              data-current={i === currentPage}
              aria-label={`第 ${i + 1} 页`}
              aria-current={i === currentPage || undefined}
              onClick={() => goTo(i)}
              ref={(el) => {
                if (el) cellsRef.current.set(i, el);
                else cellsRef.current.delete(i);
              }}
            >
              {url ? (
                <img src={url} alt="" loading="lazy" decoding="async" draggable={false} />
              ) : (
                <span className="wr-image-pages-ph" aria-hidden="true">
                  {i + 1}
                </span>
              )}
              <span>{i + 1}</span>
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="wr-input"
          style={{ width: 96 }}
          inputMode="numeric"
          aria-label={`页码（1 - ${pageCount}）`}
          placeholder={`1 - ${pageCount}`}
          value={jumpText}
          onChange={(e) => setJumpText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") jump();
          }}
        />
        <button className="wr-btn" onClick={jump}>
          跳转
        </button>
        <div className="wr-muted" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
          {currentPage + 1} / {pageCount}
        </div>
      </div>
    </div>
  );
}
