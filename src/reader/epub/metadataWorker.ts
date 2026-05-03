export type EpubMetadataResult = {
  title: string | null;
  author: string | null;
  cover_bytes_base64: string | null;
  cover_ext: string | null;
};

export async function extractEpubMetadataInWorker(bytes: Uint8Array): Promise<EpubMetadataResult> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./metadata.worker.ts", import.meta.url), { type: "module" });

    const timer = window.setTimeout(() => {
      w.terminate();
      reject(new Error("timeout"));
    }, 60_000);

    w.onmessage = (ev: MessageEvent) => {
      window.clearTimeout(timer);
      w.terminate();
      const data = ev.data as any;
      if (!data?.ok) {
        reject(new Error(data?.error ?? "failed"));
        return;
      }
      resolve({
        title: data.title ?? null,
        author: data.author ?? null,
        cover_bytes_base64: data.cover_bytes_base64 ?? null,
        cover_ext: data.cover_ext ?? null,
      });
    };

    w.onerror = (e) => {
      window.clearTimeout(timer);
      w.terminate();
      reject(new Error(String((e as any)?.message ?? e)));
    };

    w.postMessage({ buffer }, [buffer]);
  });
}

