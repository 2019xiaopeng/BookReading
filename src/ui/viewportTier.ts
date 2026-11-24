// V-4 窄窗体系已永久移除（用户 2026-11-24 裁定：固定完整侧栏+常驻搜索框，不做图标化折叠）
// 此文件保留导出签名防止其它文件编译报错，实现改为恒 full/false
import { useSyncExternalStore } from "react";

export const SEARCH_COLLAPSE_MAX = 0; // 永不触发
export const RAIL_MAX = 0;
export const DRAWER_MAX = 0;

export type ViewportTier = "full" | "rail" | "drawer";

export function tierFromWidth(_w: number): ViewportTier { return "full"; }

export function useMediaQuery(_q: string): boolean {
  return useSyncExternalStore(() => () => {}, () => false, () => false);
}
export function useViewportTier(): ViewportTier { return "full"; }
export function useCompactSearch(): boolean { return false; }
