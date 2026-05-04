import { useEffect, useRef, useState } from "react";

import { extToMime, readAppDataBlobUrl, revokeObjectUrl } from "../tauri/appDataPaths";
import { logFrontend } from "../tauri/frontendLog";

export function useCoverUrls(items: { cover_path?: string | null }[]): Record<string, string> {
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const coverUrlsRef = useRef<Record<string, string>>({});
  const loadingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    coverUrlsRef.current = coverUrls;
  }, [coverUrls]);

  useEffect(() => {
    const abort = new AbortController();
    const pending: Promise<void>[] = [];

    const wanted = new Set<string>();
    for (const it of items) {
      if (it.cover_path) wanted.add(it.cover_path);
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

    for (const coverPath of wanted) {
      if (coverUrlsRef.current[coverPath]) continue;
      if (loadingRef.current.has(coverPath)) continue;
      loadingRef.current.add(coverPath);

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
          } catch (e) {
            logFrontend(`cover: load failed ${coverPath} ${String(e)}`);
          } finally {
            loadingRef.current.delete(coverPath);
          }
        })(),
      );
    }

    return () => {
      abort.abort();
      void Promise.allSettled(pending);
    };
  }, [items]);

  useEffect(() => {
    return () => {
      setCoverUrls((prev) => {
        for (const url of Object.values(prev)) revokeObjectUrl(url);
        return {};
      });
    };
  }, []);

  return coverUrls;
}

