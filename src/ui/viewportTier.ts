import { useSyncExternalStore } from "react";

/**
 * V-4 窄窗断点（CSS 与 JS 同一套数值）：
 * - <900 搜索框收为图标；<800 侧栏 56px 图标栏 + 底部四钮 2×2；<600 侧栏转抽屉。
 * - drawer 档当前窗口 minWidth=720 不可达（tauri.conf.json），档位先就位、放宽窗口后即刻生效。
 */
export const SEARCH_COLLAPSE_MAX = 900;
export const RAIL_MAX = 800;
export const DRAWER_MAX = 600;

export type ViewportTier = "full" | "rail" | "drawer";

/** 纯：宽度 → 档位（600/800 两道侧栏阈值；搜索 900 阈值独立见 useCompactSearch）。 */
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

/** 侧栏档位（JS 侧驱动树过滤/抽屉态；宽度与视觉仍由 CSS 断点接管，无闪帧）。 */
export function useViewportTier(): ViewportTier {
  const drawer = useMediaQuery(`(max-width: ${DRAWER_MAX - 1}px)`);
  const rail = useMediaQuery(`(max-width: ${RAIL_MAX - 1}px)`);
  return drawer ? "drawer" : rail ? "rail" : "full";
}

/** <900：搜索框收为图标按钮（Ctrl+F 任何宽度可唤起）。 */
export function useCompactSearch(): boolean {
  return useMediaQuery(`(max-width: ${SEARCH_COLLAPSE_MAX - 1}px)`);
}
