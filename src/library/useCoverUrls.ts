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

// 卡片显示需求 ~96/192/256px 宽（密度档）× dpr，512 已含 2 倍余量：更大的源图缩到 512
const COVER_TARGET_PX = 512;

export function coverRetryDelayMs(failedCount: number): number {
  return 200 * 2 ** Math.max(0, failedCount - 1); // 200 / 400 / 800
}

/** canvas 步进降采样的目标宽度序列：每步 ≤0.5 倍保画质，最后一步落到 target；宽 ≤ target 返回空（用原图） */
export function planCoverDownscale(width: number, target = COVER_TARGET_PX): number[] {
  const steps: number[] = [];
  let w = width;
  while (Math.floor(w / 2) >= target) {
    w = Math.floor(w / 2);
    steps.push(w);
  }
  if (w > target) steps.push(target);
  return steps;
}

// 会话级显示缩略（不落盘）：源宽 >512 的封面 canvas 高质量步进减半到 512 再 jpeg 0.92，
// 避免浏览器对大图（如 1480px）一次性低质缩放的涂抹感并省内存；
// 解码/画布/toBlob 任一步失败返回 null，调用方回退原图 URL
async function downscaleCoverUrl(originalUrl: string): Promise<string | null> {
  if (typeof Image === "undefined" || typeof document === "undefined") return null;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("cover decode failed"));
      im.src = originalUrl;
    });
    const steps = planCoverDownscale(img.naturalWidth);
    if (steps.length === 0) return null;
    // 双 canvas 交替：canvas 改宽高即清空位图，不能同时当源和目标
    const a = document.createElement("canvas");
    const b = document.createElement("canvas");
    let src: CanvasImageSource = img;
    let dst = a;
    let srcW = img.naturalWidth;
    let srcH = img.naturalHeight;
    for (const w of steps) {
      const h = Math.max(1, Math.round((srcH * w) / srcW));
      dst.width = w;
      dst.height = h;
      const ctx = dst.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, w, h);
      src = dst;
      dst = dst === a ? b : a;
      srcW = w;
      srcH = h;
    }
    const scaled = src as HTMLCanvasElement;
    const blob = await new Promise<Blob | null>((resolve) => scaled.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    revokeObjectUrl(originalUrl); // 缩略已就绪；原图 blob 此刻仅本函数持有
    return url;
  } catch {
    return null;
  }
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

// 清理封面缓存后全量失效：重拷/置空会让同 path 的内容或有无发生变化，缓存无法自愈
export function invalidateAllCoverUrls(): void {
  const paths = [...urlCache.keys()];
  for (const path of paths) invalidateCoverUrl(path);
}

export function requestCoverUrl(path: string): void {
  if (urlCache.has(path) || inflight.has(path)) return;
  if ((failedAttempts.get(path) ?? 0) >= COVER_MAX_ATTEMPTS) return;
  inflight.add(path);
  void (async () => {
    try {
      const ext = path.split(".").pop() ?? null;
      const originalUrl = await readAppDataBlobUrl(path, extToMime(ext));
      const url = (await downscaleCoverUrl(originalUrl)) ?? originalUrl;
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
