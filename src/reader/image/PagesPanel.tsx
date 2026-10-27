import { useCallback, useEffect, useRef, useState } from "react";
import { readImagePage } from "./api";

type Props = {
  bookId: string;
  pageCount: number;
  currentPage: number;
  goTo: (page: number) => void;
  /** resident blob from the reader preload window, avoids a duplicate fetch */
  getResidentUrl?: (page: number) => string | undefined;
};

// shortcut: thumbnails are full-size blobs (no Rust downscale); LRU hard cap 24 张（内存红线，超出即回收）; reader cache untouched
const THUMB_LIMIT = 24;
const thumbs = new Map<string, string>(); // `${bookId}:${page}` -> object URL, LRU by insertion order

export default function PagesPanel({ bookId, pageCount, currentPage, goTo, getResidentUrl }: Props) {
  const [loaded, setLoaded] = useState<Set<number>>(new Set());
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cellsRef = useRef(new Map<number, HTMLElement>());
  const inflightRef = useRef(new Set<number>());
  const residentRef = useRef(getResidentUrl);

  useEffect(() => {
    residentRef.current = getResidentUrl;
  });

  useEffect(() => {
    setLoaded(new Set());
    inflightRef.current.clear();
  }, [bookId]);

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
      readImagePage(bookId, page)
        .then((bytes) => {
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
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
  );
}
