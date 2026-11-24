import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { IconBook } from "./icons";

/**
 * U-23 无边框窗口的自定义标题栏。红线：关闭钮绝不裸 close——emit 既有 wr:close-requested，
 * 走 App.tsx 监听 → handleCloseRequest 三选流程（托盘/退出/取消，含行为记忆）。
 * 窗口钮组独立导出：阅读页顶栏（沉浸联动）与 AppShell 标题栏共用。
 */

/** 最大化/全屏态跟随（窗口记忆恢复、拖边缩放、F11 都会改变）；jsdom/浏览器环境静默回默认 */
export function useWindowState(): { maximized: boolean; fullscreen: boolean } {
  const [state, setState] = useState({ maximized: false, fullscreen: false });
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const sync = async () => {
      try {
        const win = getCurrentWindow();
        const [maximized, fullscreen] = await Promise.all([win.isMaximized(), win.isFullscreen()]);
        if (!disposed) {
          setState((prev) =>
            prev.maximized === maximized && prev.fullscreen === fullscreen ? prev : { maximized, fullscreen },
          );
        }
      } catch {
        // 非 Tauri 环境（jsdom 测试）：维持默认态
      }
    };
    void sync();
    try {
      void getCurrentWindow()
        .onResized(() => void sync())
        .then((f) => {
          if (disposed) f();
          else unlisten = f;
        })
        .catch(() => {});
    } catch {
      // 同步抛出的环境异常同样静默
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return state;
}

/** Win11 规范三钮：46px 宽 32px 高、hover 背景 rgba(ink,0.06)、关闭钮 hover #e81123 图标白 */
export function WindowControls() {
  const { maximized, fullscreen } = useWindowState();
  return (
    <div className="wr-win-btns" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="wr-win-btn"
        aria-label="最小化"
        title="最小化"
        onClick={() => void getCurrentWindow().minimize().catch(() => {})}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 7.5h8" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      {fullscreen ? null : (
        <button
          type="button"
          className="wr-win-btn"
          aria-label={maximized ? "向下还原" : "最大化"}
          title={maximized ? "向下还原" : "最大化"}
          onClick={() => void getCurrentWindow().toggleMaximize().catch(() => {})}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M3.5 3.5H0.5V9.5H6.5V6.5" stroke="currentColor" strokeWidth="1" />
              <rect x="3.5" y="3.5" width="6" height="6" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
      )}
      <button
        type="button"
        className="wr-win-btn wr-win-btn--close"
        aria-label="关闭"
        title="关闭"
        onClick={() => void emit("wr:close-requested")}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}

/** AppShell 顶置标题栏（32px）：左=图标+当前上下文名，中部拖动区（双击最大化由 Tauri drag-region 处理） */
export default function TitleBar(props: { title: string }) {
  const { fullscreen } = useWindowState();
  // F11 全屏：标题栏整体退场（还原全屏仍走全局 F11），不占屏幕顶
  if (fullscreen) return null;
  return (
    <div className="wr-titlebar">
      <div className="wr-titlebar-left">
        <IconBook width={16} height={16} aria-hidden="true" />
        <span className="wr-titlebar-title" title={props.title}>
          {props.title}
        </span>
      </div>
      <div className="wr-titlebar-drag" data-tauri-drag-region="" aria-hidden="true" />
      <WindowControls />
    </div>
  );
}
