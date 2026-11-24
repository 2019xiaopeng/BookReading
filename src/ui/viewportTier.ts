import { useSyncExternalStore } from "react";

/**
 * V-4 窄窗断点（用户修正 2026-11-24）：
 * 单一阈值 720px——应用 minWidth=720，>=720 恒完整布局（搜索展开/侧栏全文字/底钮纵向全宽）；
 * <720 理论不可达（除非放宽 minWidth），档位代码就位但当前不触发。
 * 原三档 900/800/600 已废弃（默认窗口宽度下触发过早+比例失调）。
 */
export const SEARCH_COLLAPSE_MAX = 720;
export const RAIL_MAX = 720;
export const DRAWER_MAX = 720;

export type ViewportTier = "full" | "rail" | "drawer";

/** 纯：宽度 → 档位（当前恒 full，窗口 minWidth=720 以下不可达） */
export function tierFromWidth(w: number): ViewportTier {
  if (w < DRAWER_MAX) return "drawer";
  if (w < RAIL_MAX) return "rail";
  return "full";
}

// jsdom 无 matchMedia：快照回 false（=宽屏档），测试环境不炸；WebView2 恒有
function matchMediaSafe(query: string): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

function subscribeMedia(query: string, fn: () => void): () => void {
  const mql = matchMediaSafe(query);
  if (!mql) return () => {};
  mql.addEventListener("change", fn);
  return () => mql.removeEventListener("change", fn);
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => subscribeMedia(query, cb),
    () => matchMediaSafe(query)?.matches ?? false,
    () => false,
  );
}

/** 侧栏档位（当前恒 full） */
export function useViewportTier(): ViewportTier {
  const drawer = useMediaQuery(`(max-width: ${DRAWER_MAX - 1}px)`);
  const rail = useMediaQuery(`(max-width: ${RAIL_MAX - 1}px)`);
  return drawer ? "drawer" : rail ? "rail" : "full";
}

/** <720：搜索收为图标（当前恒 false=展开；留档未来放宽 minWidth 用） */
export function useCompactSearch(): boolean {
  return useMediaQuery(`(max-width: ${SEARCH_COLLAPSE_MAX - 1}px)`);
}
