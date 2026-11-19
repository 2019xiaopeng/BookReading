// v2.7.0 C-1/C-2 关闭行为记忆：✕ 三选弹窗可勾「记住我的选择」（settings 键 close_action），
// 已记忆时直接执行不再弹窗；设置页可改回「每次询问」。
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { getSettings, setSetting } from "../tauri/invoke";
import { logFrontend } from "../tauri/frontendLog";
import { showChoiceRemember } from "./dialog";

export type CloseBehavior = "ask" | "tray" | "exit";

/** 纯：settings 键 close_action → 行为。本项目 settings 以空串表示"无值"（同 library_status 约定），垃圾值回每次询问 */
export function resolveCloseAction(v: unknown): CloseBehavior {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "tray" || s === "exit" ? s : "ask";
}

// 缓存：启动时壳的 getSettings 读顺带预热；弹窗/设置页改动即推写
let cached: CloseBehavior = "ask";
let primed = false;

export function primeCloseAction(v: unknown): void {
  cached = resolveCloseAction(v);
  primed = true;
}

/** 设置页改「关闭按钮行为」：ask=清空键（空串），tray/exit=写键；同步缓存让下次 ✕ 立即生效 */
export function setCloseBehavior(b: CloseBehavior): void {
  cached = b;
  void setSetting("close_action", b === "ask" ? "" : b);
}

async function hideToTray() {
  try {
    await getCurrentWindow().hide();
  } catch (e) {
    logFrontend(`app: hide window failed ${String(e)}`);
  }
}

/** wr:close-requested 入口（App.tsx 监听转发）：已记忆直接执行；否则三选 + 可勾记住 */
export async function handleCloseRequest(): Promise<void> {
  if (!primed) {
    // 启动预热失败（DB 不可达）兜底再拉一次；仍失败按"每次询问"走
    try {
      primeCloseAction((await getSettings()).close_action);
    } catch {
      primed = true;
    }
  }
  if (cached === "exit") {
    await invoke("quit_app");
    return;
  }
  if (cached === "tray") {
    await hideToTray();
    return;
  }
  const { action, remember } = await showChoiceRemember("关闭 BookReading", "要退出应用，还是最小化到系统托盘？", {
    confirmText: "退出",
    secondaryText: "最小化到托盘",
    rememberLabel: "记住我的选择，不再询问",
  });
  if (remember && (action === "primary" || action === "secondary")) {
    setCloseBehavior(action === "primary" ? "exit" : "tray");
  }
  if (action === "primary") await invoke("quit_app");
  else if (action === "secondary") await hideToTray();
}
