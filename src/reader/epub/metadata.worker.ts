import ePub from "epubjs";

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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]);
}

self.onmessage = (ev: MessageEvent) => {
  void (async () => {
    const data = ev.data as { buffer: ArrayBuffer };
    try {
      const book: any = ePub(data.buffer);
      await withTimeout(book.ready, 60_000);
      const metadata = await withTimeout<any>(book.loaded.metadata as Promise<any>, 30_000);
      const title = (metadata?.title as string | undefined) ?? null;
      const author = (metadata?.creator as string | undefined) ?? (metadata?.author as string | undefined) ?? null;

      let cover_bytes_base64: string | null = null;
      let cover_ext: string | null = null;
      try {
        const coverUrl = (await withTimeout<any>(book.coverUrl?.() as Promise<any>, 30_000)) ?? null;
        if (coverUrl) {
          const res = await fetch(coverUrl);
          const buffer = await res.arrayBuffer();
          cover_bytes_base64 = arrayBufferToBase64(buffer);
          cover_ext = mimeToExt(res.headers.get("content-type")) ?? "png";
        }
      } catch {
      }

      (self as any).postMessage({ ok: true, title, author, cover_bytes_base64, cover_ext });
    } catch (e) {
      (self as any).postMessage({ ok: false, error: String(e) });
    }
  })();
};

