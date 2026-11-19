import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { router } from "./app/router";
import { DialogHost } from "./ui/dialog";
import { handleCloseRequest } from "./ui/closeAction";
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

  // 批次19：✕ 拦截（Rust prevent_close 后 emit）；v2.7.0 C-1 起行为记忆/三选弹窗收敛到 ui/closeAction
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen("wr:close-requested", () => void handleCloseRequest())
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
