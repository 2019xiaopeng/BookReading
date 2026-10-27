import { useEffect, useMemo, useState } from "react";

import { extToMime, readAppDataBlobUrl, revokeObjectUrl } from "../tauri/appDataPaths";
import { logFrontend } from "../tauri/frontendLog";

// Module-level cache: blob URLs live for the whole app session, so covers survive
// page unmount/remount (returning from the reader shows them instantly, no refetch).
// shortcut: blobs of deleted/replaced covers are never revoked; local covers are small
const urlCache = new Map<string, string>();
const failedAttempts = new Map<string, number>();
const inflight = new Set<string>();
const listeners = new Set<(path: string) => void>();

export const COVER_MAX_ATTEMPTS = 3;

export function coverRetryDelayMs(failedCount: number): number {
  return 200 * 2 ** Math.max(0, failedCount - 1); // 200 / 400 / 800
}

export function getCoverUrl(path: string): string | undefined {
  return urlCache.get(path);
}

function notify(path: string) {
  for (const l of listeners) l(path);
}

// 自定义封面替换/删除后：回收旧 blob、清缓存并通知；failedAttempts 一并清除让此前失败的可重试
export function invalidateCoverUrl(path: string): void {
  const url = urlCache.get(path);
  if (url) revokeObjectUrl(url);
  urlCache.delete(path);
  failedAttempts.delete(path);
  notify(path);
}

export function requestCoverUrl(path: string): void {
  if (urlCache.has(path) || inflight.has(path)) return;
  if ((failedAttempts.get(path) ?? 0) >= COVER_MAX_ATTEMPTS) return;
  inflight.add(path);
  void (async () => {
    try {
      const ext = path.split(".").pop() ?? null;
      const url = await readAppDataBlobUrl(path, extToMime(ext));
      failedAttempts.delete(path);
      urlCache.set(path, url);
      notify(path);
      inflight.delete(path);
    } catch (e) {
      const failed = (failedAttempts.get(path) ?? 0) + 1;
      failedAttempts.set(path, failed);
      if (failed < COVER_MAX_ATTEMPTS) {
        logFrontend(`cover: load failed ${path} attempt ${failed}, retrying: ${String(e)}`);
        setTimeout(() => {
          inflight.delete(path);
          requestCoverUrl(path);
        }, coverRetryDelayMs(failed));
        return;
      }
      logFrontend(`cover: load failed ${path}, giving up: ${String(e)}`);
      inflight.delete(path);
    }
  })();
}

export function useCoverUrls(items: { cover_path?: string | null }[]): Record<string, string> {
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  // deps: the cover path set as a stable string, so book-list refreshes with identical covers don't churn loads
  const wantedKey = useMemo(
    () =>
      [...new Set(items.map((it) => it.cover_path).filter((p): p is string => !!p))].sort().join("\n"),
    [items],
  );

  useEffect(() => {
    const onLoaded = (path: string) => {
      setCoverUrls((prev) => {
        const url = urlCache.get(path);
        if (!url) {
          // invalidate 通知：缓存已无此 path，同步从 state 删 key（含从未加载成功的情况）
          if (!(path in prev)) return prev;
          const next = { ...prev };
          delete next[path];
          return next;
        }
        if (prev[path] === url) return prev;
        return { ...prev, [path]: url };
      });
    };
    listeners.add(onLoaded);
    return () => {
      listeners.delete(onLoaded);
    };
  }, []);

  useEffect(() => {
    const wanted = new Set(wantedKey ? wantedKey.split("\n") : []);
    for (const path of wanted) requestCoverUrl(path);
    setCoverUrls((prev) => {
      let next: Record<string, string> | null = null;
      for (const k of Object.keys(prev)) {
        if (wanted.has(k)) continue;
        next ??= { ...prev };
        delete next[k];
      }
      for (const p of wanted) {
        const u = urlCache.get(p);
        if (u && prev[p] !== u) {
          next ??= { ...prev };
          next[p] = u;
        }
      }
      return next ?? prev;
    });
  }, [wantedKey]);

  return coverUrls;
}
