// v3.0 B5 侧栏底部动作全局常驻：页面注册、壳消费的模块级 store（照 appBackground 的 subscribe 模式）。
// page 槽=刷新（当前视图注册，切视图自动替换）；global 槽=导入两钮（LibraryPage 挂载时注册，未注册时壳渲染禁用兜底）。
import { useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

export type SidebarAction = {
  label: string;
  icon?: ReactNode;
  title?: string;
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};

export type SidebarSlot = "page" | "global";

let pageSlot: SidebarAction[] | null = null;
let globalSlot: SidebarAction[] | null = null;
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 壳侧消费：当前两槽的动作（快照=版本号，数组每次渲染现读模块变量） */
export function useSidebarActionSlots(): { page: SidebarAction[] | null; global: SidebarAction[] | null } {
  useSyncExternalStore(subscribe, () => version);
  return { page: pageSlot, global: globalSlot };
}

/** 页面侧注册：actions 每次渲染都是新数组 → effect 重注册，handlers 恒新；null=注销该槽 */
export function useSidebarActions(slot: SidebarSlot, actions: SidebarAction[] | null): void {
  useEffect(() => {
    if (slot === "page") pageSlot = actions;
    else globalSlot = actions;
    bump();
    return () => {
      // 只清自己注册的那份（后注册者已接管时不动）
      if (slot === "page" ? pageSlot === actions : globalSlot === actions) {
        if (slot === "page") pageSlot = null;
        else globalSlot = null;
        bump();
      }
    };
  }, [slot, actions]);
}
