import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { router } from "./app/router";
import { DialogHost, showChoice } from "./ui/dialog";
import { logFrontend } from "./tauri/frontendLog";

export default function App() {
  // 批次19：F11 窗口全屏上提到全局（原挂阅读页 keydown，回书架后仍可退出全屏）；
  // 不做输入焦点豁免——浏览器惯例 F11 在输入框内同样生效
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "F11") return;
      e.preventDefault();
      void (async () => {
        const win = getCurrentWindow();
        try {
          await win.setFullscreen(!(await win.isFullscreen()));
        } catch (e) {
          logFrontend(`app: fullscreen toggle failed ${String(e)}`);
        }
      })();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 批次19：✕ 拦截（Rust prevent_close 后 emit）→ 三选：最小化到托盘 / 退出 / 取消（Esc 或点遮罩）
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen("wr:close-requested", () => {
      void (async () => {
        const action = await showChoice("关闭 BookReading", "要退出应用，还是最小化到系统托盘？", {
          confirmText: "退出",
          secondaryText: "最小化到托盘",
        });
        if (action === "primary") {
          await invoke("quit_app");
        } else if (action === "secondary") {
          try {
            await getCurrentWindow().hide();
          } catch (e) {
            logFrontend(`app: hide window failed ${String(e)}`);
          }
        }
      })();
    })
      .then((f) => {
        if (disposed) f();
        else unlisten = f;
      })
      .catch((e) => logFrontend(`app: close-requested listen failed ${String(e)}`));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <>
      <RouterProvider router={router} />
      <DialogHost />
    </>
  );
}
