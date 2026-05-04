import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";

import type { Book } from "../tauri/invoke";
import { deleteBook, importBook, listBooks, repairBookMetadata, setBookFavorite } from "../tauri/invoke";
import { extToMime, readAppDataBlobUrl, revokeObjectUrl } from "../tauri/appDataPaths";
import { needsMetadataRepair } from "../library/metadataRepair";
import { logFrontend } from "../tauri/frontendLog";

function formatTitle(book: Book): string {
  return book.title?.trim() || "未命名";
}

function formatAuthor(book: Book): string {
  return book.author?.trim() || "未知作者";
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(false);
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const repairingRef = useRef<Set<string>>(new Set());
  const attemptedRef = useRef<Set<string>>(new Set());
  const coverUrlsRef = useRef<Record<string, string>>({});
  const coverLoadingRef = useRef<Set<string>>(new Set());

  const booksSorted = useMemo(() => books, [books]);

  async function refresh() {
    const list = await listBooks();
    setBooks(list);
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const pending: Promise<void>[] = [];
    for (const b of books) {
      if (!needsMetadataRepair(b)) continue;
      if (attemptedRef.current.has(b.id)) continue;
      if (repairingRef.current.has(b.id)) continue;
      repairingRef.current.add(b.id);
      attemptedRef.current.add(b.id);
      pending.push(
        (async () => {
          try {
            await repairBookMetadata(b.id);
            await refresh();
          } catch {
          } finally {
            repairingRef.current.delete(b.id);
          }
        })(),
      );
    }
    return () => {
      void Promise.allSettled(pending);
    };
  }, [books]);

  useEffect(() => {
    coverUrlsRef.current = coverUrls;
  }, [coverUrls]);

  useEffect(() => {
    const abort = new AbortController();
    const pending: Promise<void>[] = [];

    const wanted = new Set<string>();
    for (const b of books) {
      if (b.cover_path) wanted.add(b.cover_path);
    }

    setCoverUrls((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (!wanted.has(key)) {
          revokeObjectUrl(next[key]);
          delete next[key];
        }
      }
      return next;
    });

    for (const b of books) {
      const coverPath = b.cover_path;
      if (!coverPath) continue;
      if (coverUrlsRef.current[coverPath]) continue;
      if (coverLoadingRef.current.has(coverPath)) continue;
      coverLoadingRef.current.add(coverPath);

      pending.push(
        (async () => {
          try {
            const ext = coverPath.split(".").pop() ?? null;
            const url = await readAppDataBlobUrl(coverPath, extToMime(ext));
            if (abort.signal.aborted) {
              revokeObjectUrl(url);
              return;
            }
            setCoverUrls((prev) => {
              if (prev[coverPath]) {
                revokeObjectUrl(url);
                return prev;
              }
              return { ...prev, [coverPath]: url };
            });
          } catch {
          } finally {
            coverLoadingRef.current.delete(coverPath);
          }
        })(),
      );
    }

    return () => {
      abort.abort();
      void Promise.allSettled(pending);
    };
  }, [books]);

  useEffect(() => {
    return () => {
      setCoverUrls((prev) => {
        for (const url of Object.values(prev)) revokeObjectUrl(url);
        return {};
      });
    };
  }, []);

  async function onImport() {
    if (loading) return;
    setLoading(true);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "EPUB", extensions: ["epub"] }],
      });
      if (!selected || Array.isArray(selected)) {
        setLoading(false);
        return;
      }

      await importBook({
        source_path: selected,
        title: null,
        author: null,
        cover_bytes_base64: null,
        cover_ext: null,
      });

      await refresh();
      setLoading(false);
      return;
    } finally {
      setLoading(false);
    }
  }

  async function onDelete(bookId: string) {
    if (loading) return;
    const ok = window.confirm("确定删除这本书吗？");
    if (!ok) return;

    setLoading(true);
    try {
      await deleteBook(bookId);
      await refresh();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-page" data-theme="light">
      <div className="app-header">
        <div className="app-title">BookReading</div>
        <div className="app-spacer" />
        <button onClick={() => navigate("/favorites")} disabled={loading}>
          收藏
        </button>
        <button onClick={onImport} disabled={loading} className="btn-primary">
          导入 EPUB
        </button>
      </div>

      <div className="app-grid">
        {booksSorted.map((b) => (
          <div
            key={b.id}
            className="app-card"
          >
            <div className="app-cover">
              {b.cover_path && coverUrls[b.cover_path] ? (
                <img src={coverUrls[b.cover_path]} alt="" />
              ) : null}
            </div>

            <div className="app-meta">
              <div className="app-meta-title">{formatTitle(b)}</div>
              <div className="app-meta-sub">{formatAuthor(b)}</div>

              <div className="app-actions">
                <button
                  onClick={() => {
                    logFrontend(`ui: open book ${b.id}`);
                    navigate(`/read/${b.id}`);
                  }}
                  disabled={loading}
                  className="btn-primary"
                >
                  打开
                </button>
                <button
                  onClick={() => {
                    setLoading(true);
                    setBookFavorite(b.id, !b.is_favorite)
                      .then(() => refresh())
                      .finally(() => setLoading(false));
                  }}
                  disabled={loading}
                >
                  {b.is_favorite ? "取消收藏" : "收藏"}
                </button>
                <button onClick={() => onDelete(b.id)} disabled={loading} className="btn-danger">
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {booksSorted.length === 0 ? (
        <div className="muted" style={{ padding: 16 }}>
          暂无书籍，点击右上角导入 EPUB。
        </div>
      ) : null}
    </div>
  );
}
