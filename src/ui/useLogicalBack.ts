import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { Shelf } from "../tauri/invoke";
import { getShelvesCache } from "./AppShell";

/**
 * M-3 鼠标侧键逻辑回溯：后退侧键（button 3）走"逻辑上一层"而非浏览器历史栈，
 * 前进侧键（button 4）仅吞掉（WebView2 默认把两者映射成 history.back/forward）。
 *
 * 纯：侧键逻辑目标（null=无操作）。导出供测试。
 * - /read/:id → 来源书架（location.state.fromShelf），无 state 退书库根
 * - / 且 ?shelf=X（X 非根级）→ 父书架
 * - /favorites 或 /?trash=1 → 书库根
 * - 其它（书库根等）→ 无操作
 */
export function logicalBackTarget(pathname: string, search: string, shelves: Shelf[], state: unknown): string | null {
  if (pathname.startsWith("/read/")) {
    const from = (state as { fromShelf?: unknown } | null)?.fromShelf;
    return typeof from === "number" ? `/?shelf=${from}` : "/";
  }
  if (pathname === "/favorites") return "/";
  if (pathname !== "/") return null;
  if (search.includes("trash=1")) return "/";
  const m = /[?&]shelf=(\d+)/.exec(search);
  if (!m) return null;
  const shelf = shelves.find((s) => s.id === Number(m[1]));
  // 根级书架（或已不存在的架——LibraryPage 自有回根纠偏）→ 无操作
  return shelf?.parent_id == null ? null : `/?shelf=${shelf.parent_id}`;
}

export default function useLogicalBack(): void {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      // 捕获阶段先于一切：吃掉默认行为（WebView2 的 history.back/forward）并阻断页面内 mousedown
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.button === 4) return; // 前进侧键：仅吞掉
      const target = logicalBackTarget(location.pathname, location.search, getShelvesCache(), location.state);
      if (target !== null) navigate(target);
    };
    // U-2：WebView2 把侧键默认回退执行在松手相——mousedown 吞掉按下后 mouseup 仍触发 history.back，
    // 把逻辑导航 push 进去的上级退回最深层。松手相同样捕获吞掉，两相都不放行默认回退。
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("mousedown", onMouseDown, { capture: true });
    window.addEventListener("mouseup", onMouseUp, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onMouseDown, { capture: true });
      window.removeEventListener("mouseup", onMouseUp, { capture: true });
    };
  }, [location, navigate]);
}
