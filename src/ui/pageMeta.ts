import { useSyncExternalStore, type ComponentProps } from "react";
import type AppShell from "./AppShell";

// 批次8 根治侧栏闪烁：壳（AppShell+侧栏树+底部四钮）由 AppLayout 常驻渲染唯一一份，页面不再各自包裹；
// 页面挂载时把本页的壳 props 切片写进本 store（仿 appBackground.ts 的订阅模式），useLayoutEffect 写入先于绘制，切页零闪烁
export type PageMeta = Omit<ComponentProps<typeof AppShell>, "children">;

// 首帧默认书库：AppShell 首渲染不空 active/title
let meta: PageMeta = { active: "library", title: "书架" };
const listeners = new Set<() => void>();

export function setPageMeta(next: PageMeta): void {
  meta = next;
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function usePageMeta(): PageMeta {
  return useSyncExternalStore(subscribe, () => meta, () => meta);
}
