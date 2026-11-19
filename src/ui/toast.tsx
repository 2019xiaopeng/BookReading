// v2.7.0 H-3 轻提示：批量操作等成功反馈，2.4s 自动消失。宿主 document 单例容器 + <ToastHost/> 一次挂载。
import { createElement, useSyncExternalStore } from "react";

type Toast = { id: number; text: string };
let seq = 1;
let toasts: Toast[] = [];
const subs = new Set<() => void>();

function notify() {
  for (const fn of subs) fn();
}

export function showToast(text: string): void {
  const id = seq++;
  toasts = [...toasts, { id, text }];
  notify();
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, 2400);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => toasts,
  );
}

/** AppShell 挂载一次；无宿主时提示静默丢失（无碍） */
export function ToastHost() {
  const list = useToasts();
  if (list.length === 0) return null;
  return createElement(
    "div",
    { className: "wr-toast-host", "aria-live": "polite" },
    list.map((t) => createElement("div", { key: t.id, className: "wr-toast-item", role: "status" }, t.text)),
  );
}
