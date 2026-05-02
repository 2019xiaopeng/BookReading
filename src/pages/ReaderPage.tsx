import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { Book } from "../tauri/invoke";
import { listBooks } from "../tauri/invoke";
import { createReader, type ReaderController, type TocItem } from "../reader/epub/reader";

export default function ReaderPage() {
  const navigate = useNavigate();
  const { bookId } = useParams();
  const [book, setBook] = useState<Book | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [percent, setPercent] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ReaderController | null>(null);

  useEffect(() => {
    (async () => {
      const books = await listBooks();
      const found = books.find((b) => b.id === bookId) ?? null;
      setBook(found);
    })();
  }, [bookId]);

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
        onRelocated: ({ percent }) => {
          if (typeof percent === "number") setPercent(percent);
        },
        onTocLoaded: (toc) => setToc(toc),
      });
    })();

    return () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [book]);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, borderBottom: "1px solid rgba(0,0,0,0.12)" }}>
        <button onClick={() => navigate("/")}>返回书库</button>
        <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {book?.title ?? "阅读"}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ color: "rgba(0,0,0,0.6)", fontVariantNumeric: "tabular-nums" }}>
          {typeof percent === "number" ? `${Math.round(percent * 100)}%` : ""}
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ width: 280, borderRight: "1px solid rgba(0,0,0,0.12)", padding: 12, overflow: "auto" }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>目录</div>
          {toc.length === 0 ? (
            <div style={{ color: "rgba(0,0,0,0.6)" }}>加载中…</div>
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

        <div style={{ position: "relative", flex: 1, minWidth: 0, background: "white" }}>
          <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
          <div
            style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "1fr 1fr" }}
          >
            <div onClick={() => controllerRef.current?.prev()} style={{ cursor: "w-resize" }} />
            <div onClick={() => controllerRef.current?.next()} style={{ cursor: "e-resize" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
