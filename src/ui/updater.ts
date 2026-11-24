// v2.7.0 U 前端半：应用内更新（契约见 invoke.ts：checkAppUpdate/downloadAppUpdate/runUpdateInstaller）。
// 状态存模块单例——AppShell 每页重挂，红点/toast 须活过路由切换。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { checkAppUpdate, downloadAppUpdate, getSettings, runUpdateInstaller, type UpdateInfo } from "../tauri/invoke";
import { logFrontend } from "../tauri/frontendLog";
import { showToast } from "./toast";

export const RELEASES_URL = "https://github.com/2019xiaopeng/BookReading/releases";

/** 纯：asset 下载链接 → 发布页链接（https://github.com/o/r/releases/download/… → …/releases） */
export function releasePageFromAssetUrl(url: string): string {
  return url.replace(/\/download\/.*$/, "");
}

// U-3 红点：启动静默检查或手动检查发现新版后点亮；确认已是最新则熄灭
let available: UpdateInfo | null = null;
const badgeListeners = new Set<() => void>();

function setAvailable(info: UpdateInfo | null) {
  available = info;
  for (const l of badgeListeners) l();
}

export function subscribeUpdateAvailable(fn: () => void): () => void {
  badgeListeners.add(fn);
  return () => {
    badgeListeners.delete(fn);
  };
}

export function getUpdateAvailable(): UpdateInfo | null {
  return available;
}

let startupStarted = false;

/** U-3 启动静默检查（挂载后 10s；settings 键 update_check 默认开）：失败静默；发现新版=红点+toast 一次，不弹窗 */
export function startSilentUpdateCheck(): void {
  if (startupStarted) return;
  startupStarted = true;
  void (async () => {
    try {
      if ((await getSettings()).update_check === "off") return;
    } catch {
      // 读不到设置按默认开
    }
    await new Promise((r) => window.setTimeout(r, 10_000));
    try {
      const info = await checkAppUpdate();
      if (info.hasUpdate) {
        setAvailable(info);
        showToast(`发现新版本 v${info.latest}，在设置中查看`);
      }
    } catch (e) {
      logFrontend(`updater: silent check failed ${String(e)}`);
    }
  })();
}

/** 设置页手动检查：错误原样抛给调用方 showAlert；顺带维护红点 */
export async function checkForUpdateManually(): Promise<UpdateInfo> {
  const info = await checkAppUpdate();
  setAvailable(info.hasUpdate ? info : null);
  return info;
}

/** F-1：插件通道确认最新后熄红点（与 checkForUpdateManually 的红点维护对称） */
export function clearUpdateAvailable(): void {
  setAvailable(null);
}

export type DownloadProgress = { downloaded: number; total: number };

/** U-2 下载 NSIS 到临时目录：进度经 "update-download-progress" 事件回调，resolve 出安装包路径 */
export async function downloadUpdateWithProgress(
  assetUrl: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<string> {
  const unlistenP = listen<DownloadProgress>("update-download-progress", (e) => onProgress(e.payload));
  try {
    return await downloadAppUpdate(assetUrl);
  } finally {
    void unlistenP.then((f) => f());
  }
}

/** U-2 运行安装器（NSIS 原地升级接管）并退出应用；退出失败（进程正被替换等）不算错误 */
export async function installUpdateAndQuit(installerPath: string): Promise<void> {
  await runUpdateInstaller(installerPath);
  await invoke("quit_app").catch(() => {});
}
