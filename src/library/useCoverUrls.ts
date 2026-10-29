import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { extToMime, readAppDataBlobUrl, revokeObjectUrl } from "../tauri/appDataPaths";
import { logFrontend } from "../tauri/frontendLog";
import { MAX_CONCURRENT_COVER_LOADS, pickNextCoverRequests, type CoverRequest } from "./coverScheduler";

// Module-level cache: blob URLs live for the whole app session, so covers survive
// page unmount/remount (returning from the reader shows them instantly, no refetch).
// shortcut: blobs of deleted/replaced covers are never revoked; local covers are small
const urlCache = new Map<string, string>();
const failedAttempts = new Map<string, number>();
const inflight = new Set<string>();
const listeners = new Set<(path: string) => void>();

// 调度队列：按入队顺序去重等待；visible 为视口命中集合（IntersectionObserver 维护），命中者优先出队
const queue: CoverRequest[] = [];
const queuedPaths = new Set<string>();
const visiblePaths = new Set<string>();

export const COVER_MAX_ATTEMPTS = 3;
// 合帧窗口：封面逐张经独立 IPC 宏任务到达，微任务批不到；50ms 内到达的合并成一次广播/setState
export const NOTIFY_COALESCE_MS = 50;

export function coverRetryDelayMs(failedCount: number): number {
  return 200 * 2 ** Math.max(0, failedCount - 1); // 200 / 400 / 800
}

export function getCoverUrl(path: string): string | undefined {
  return urlCache.get(path);
}

let notifyTimer: ReturnType<typeof setTimeout> | null = null;
const pendingNotifyPaths = new Set<string>();

function notify(path: string) {
  pendingNotifyPaths.add(path);
  if (notifyTimer != null) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const paths = [...pendingNotifyPaths];
    pendingNotifyPaths.clear();
    for (const p of paths) for (const l of listeners) l(p);
  }, NOTIFY_COALESCE_MS);
}

export function subscribeCoverNotifications(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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

function pump() {
  if (queue.length === 0) return;
  const batch = pickNextCoverRequests(
    queue,
    MAX_CONCURRENT_COVER_LOADS - inflight.size,
    (r) => visiblePaths.has(r.path),
  );
  for (const r of batch) {
    const i = queue.indexOf(r);
    if (i >= 0) queue.splice(i, 1);
    queuedPaths.delete(r.path);
    startFetch(r);
  }
}

function enqueueCoverRequest(req: CoverRequest, priority = false) {
  if (urlCache.has(req.path) || inflight.has(req.path) || queuedPaths.has(req.path)) return;
  if ((failedAttempts.get(req.path) ?? 0) >= COVER_MAX_ATTEMPTS) return;
  queuedPaths.add(req.path);
  if (priority && queue.length > 0) queue.unshift(req);
  else queue.push(req);
  pump();
}

export function requestCoverUrl(path: string, opts?: { id?: string; priority?: boolean }): void {
  enqueueCoverRequest({ path, id: opts?.id }, opts?.priority ?? false);
}

// 缩略档约定：480px，不透明封面=JPEG(.jpg)，透明封面=无损 webp(.webp)（后端生成时按此落盘）
export function coverThumbCandidates(id: string): string[] {
  return [`library/covers/thumbs/${id}.jpg`, `library/covers/thumbs/${id}.webp`];
}

function startFetch(req: CoverRequest) {
  inflight.add(req.path);
  void (async () => {
    try {
      let url: string | undefined;
      if (req.id) {
        // 缩略缺失是预期路径（存量书未生成），静默回退原图
        for (const [cand, mime] of coverThumbCandidates(req.id).map((p) => [
          p,
          p.endsWith(".webp") ? "image/webp" : "image/jpeg",
        ] as const)) {
          try {
            url = await readAppDataBlobUrl(cand, mime);
            break;
          } catch {
            url = undefined;
          }
        }
      }
      if (!url) {
        const ext = req.path.split(".").pop() ?? null;
        url = await readAppDataBlobUrl(req.path, extToMime(ext));
      }
      failedAttempts.delete(req.path);
      urlCache.set(req.path, url);
      notify(req.path);
      inflight.delete(req.path);
      pump();
    } catch (e) {
      const failed = (failedAttempts.get(req.path) ?? 0) + 1;
      failedAttempts.set(req.path, failed);
      inflight.delete(req.path);
      if (failed < COVER_MAX_ATTEMPTS) {
        logFrontend(`cover: load failed ${req.path} attempt ${failed}, retrying: ${String(e)}`);
        pump(); // 退避期间让出并发名额
        setTimeout(() => {
          queuedPaths.delete(req.path);
          enqueueCoverRequest(req);
        }, coverRetryDelayMs(failed));
        return;
      }
      logFrontend(`cover: load failed ${req.path}, giving up: ${String(e)}`);
      pump();
    }
  })();
}

// ---- 视口优先：封面元素进入视口即提升其请求优先级（模块级单例 IO，所有卡共用） ----

let coverIO: IntersectionObserver | null = null;
const observedEls = new Map<Element, string>();

function getCoverIO(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  coverIO ??= new IntersectionObserver(
    (entries) => {
      let changed = false;
      for (const en of entries) {
        const path = observedEls.get(en.target);
        if (path == null) continue;
        changed = true;
        if (en.isIntersecting) visiblePaths.add(path);
        // 离开视口不删记录：只是丢优先级候选无害，误删会让仍在视口的同名封面丢优先级
      }
      if (changed) pump();
    },
    { rootMargin: "200px" }, // 预取视口外一圈，滚动中提前就绪
  );
  return coverIO;
}

export function observeCoverEl(el: Element, path: string): void {
  const io = getCoverIO();
  if (!io) return;
  observedEls.set(el, path);
  io.observe(el);
}

export function unobserveCoverEl(el: Element): void {
  observedEls.delete(el);
  coverIO?.unobserve(el);
}

/** 封面容器 ref：挂载即把 path 报给调度器做视口优先（无 IO 环境为 no-op） */
export function useCoverPriority(path: string | null | undefined) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!path || !el) return;
    observeCoverEl(el, path);
    return () => unobserveCoverEl(el);
  }, [path]);
  return ref;
}

// ---- hook ----

export type CoverItem = { cover_path?: string | null; id?: string };
export type CoverUrlsOptions = { preferThumb?: boolean };

/** 初始 state 播种：已缓存封面直接进首帧，占位→图片跳变的根因之一即初始恒空对象 */
export function seedCoverUrls(items: readonly CoverItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of items) {
    const p = it.cover_path;
    if (!p) continue;
    const u = urlCache.get(p);
    if (u) out[p] = u;
  }
  return out;
}

export function useCoverUrls(
  items: CoverItem[],
  options?: CoverUrlsOptions,
): Record<string, string> {
  const preferThumb = options?.preferThumb === true;
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>(() => seedCoverUrls(items));
  // deps: the cover path set as a stable string, so book-list refreshes with identical covers don't churn loads
  const wantedKey = useMemo(
    () =>
      [...new Set(items.map((it) => it.cover_path).filter((p): p is string => !!p))].sort().join("\n"),
    [items],
  );
  // 最新 path→book_id 映射（缩略档用）；wantedKey 只含 path，id 经 ref 随取随用
  const idByPathRef = useRef<Map<string, string>>(new Map());
  idByPathRef.current = useMemo(() => {
    const m = new Map<string, string>();
    if (preferThumb) for (const it of items) if (it.cover_path && it.id != null) m.set(it.cover_path, it.id);
    return m;
  }, [items, preferThumb]);

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
    return subscribeCoverNotifications(onLoaded);
  }, []);

  // layout effect：切架/回页时缓存命中的封面在重绘（首次上屏）前就位，杜绝先占位后跳图
  useLayoutEffect(() => {
    const wanted = new Set(wantedKey ? wantedKey.split("\n") : []);
    for (const path of wanted) requestCoverUrl(path, { id: idByPathRef.current.get(path) });
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
