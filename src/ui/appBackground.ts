import { extToMime, readAppDataBlobUrl, revokeObjectUrl } from "../tauri/appDataPaths";
import type { ReaderBackground } from "../reader/settings/types";

// 全局背景单槽 objectURL 缓存：换图或改回 preset 时回收旧 URL，全应用同时至多驻留一张（壳与阅读纸面共用）
let cache: { path: string; url: string } | null = null;

// 后端固定写 library/bg/bg.<ext>：同路径换图后 path 不变、内容已变，缓存无法自愈，写入方须显式失效
export function resetBackgroundCache() {
  if (cache) {
    revokeObjectUrl(cache.url);
    cache = null;
  }
}

// 换背景广播（仿 useCoverUrls listeners）：书架改设置后 AppShell 订阅重读 settings 即时换肤，应用即预览
const backgroundListeners = new Set<() => void>();

export function subscribeBackground(fn: () => void): () => void {
  backgroundListeners.add(fn);
  return () => {
    backgroundListeners.delete(fn);
  };
}

export function notifyBackgroundChanged() {
  for (const fn of backgroundListeners) fn();
}

export async function getBackgroundUrl(bg: ReaderBackground): Promise<string | null> {
  if (bg.type !== "image") {
    resetBackgroundCache();
    return null;
  }
  if (cache?.path === bg.path) return cache.url;
  const ext = bg.path.split(".").pop() ?? "";
  const url = await readAppDataBlobUrl(bg.path, extToMime(ext));
  if (cache && cache.url !== url) revokeObjectUrl(cache.url);
  cache = { path: bg.path, url };
  return url;
}
