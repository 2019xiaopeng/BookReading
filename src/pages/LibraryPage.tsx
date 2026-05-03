import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import ePub from "epubjs";

import type { Book } from "../tauri/invoke";
import { deleteBook, importBook, listBooks, setBookFavorite } from "../tauri/invoke";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function mimeToExt(mime: string | null): string | null {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg")) return "jpeg";
  if (m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  return null;
}

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

  const booksSorted = useMemo(() => books, [books]);

  async function refresh() {
    const list = await listBooks();
    setBooks(list);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onImport() {
    if (loading) return;
    setLoading(true);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "EPUB", extensions: ["epub"] }],
      });
      if (!selected || Array.isArray(selected)) return;

      const bytes = await readFile(selected);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const book: any = ePub(buffer);
      await Promise.race([
        book.ready,
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("timeout")), 60_000)),
      ]);
      const metadata = await book.loaded.metadata;
      const title = (metadata?.title as string | undefined) ?? null;
      const author =
        (metadata?.creator as string | undefined) ??
        (metadata?.author as string | undefined) ??
        null;

      let cover_bytes_base64: string | null = null;
      let cover_ext: string | null = null;
      try {
        const coverUrl = (await book.coverUrl?.()) ?? null;
        if (coverUrl) {
          const res = await fetch(coverUrl);
          const buffer = await res.arrayBuffer();
          cover_bytes_base64 = arrayBufferToBase64(buffer);
          cover_ext = mimeToExt(res.headers.get("content-type")) ?? "png";
        }
      } catch {
      }

      await importBook({
        source_path: selected,
        title,
        author,
        cover_bytes_base64,
        cover_ext,
      });

      await refresh();
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
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>BookReading</div>
        <div style={{ flex: 1 }} />
        <button onClick={() => navigate("/favorites")} disabled={loading}>
          收藏
        </button>
        <button onClick={onImport} disabled={loading}>
          导入 EPUB
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
        {booksSorted.map((b) => (
          <div
            key={b.id}
            style={{
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 10,
              padding: 12,
              display: "flex",
              gap: 12,
              background: "white",
            }}
          >
            <div
              style={{
                width: 64,
                height: 96,
                borderRadius: 6,
                border: "1px solid rgba(0,0,0,0.12)",
                background: "rgba(0,0,0,0.04)",
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              {b.cover_path ? (
                <img
                  src={convertFileSrc(b.cover_path)}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : null}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {formatTitle(b)}
              </div>
              <div style={{ color: "rgba(0,0,0,0.65)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {formatAuthor(b)}
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
                <button onClick={() => navigate(`/read/${b.id}`)} disabled={loading}>
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
                <button onClick={() => onDelete(b.id)} disabled={loading}>
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {booksSorted.length === 0 ? (
        <div style={{ color: "rgba(0,0,0,0.6)", padding: 16 }}>暂无书籍，点击右上角导入 EPUB。</div>
      ) : null}
    </div>
  );
}
