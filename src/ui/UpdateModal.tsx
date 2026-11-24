// F-1（U-17）更新弹窗：官方 updater 插件 check → 版本卡 → downloadAndInstall 事件驱动进度。
// 纸面基准 = wr-prompt 弹层体系（书库详情同款）；进度条用内联样式，不新增 CSS。
// Windows 事实（tauri-plugin-updater 2.14 源码核实）：install 起安装器后 std::process::exit(0)，
// 且 restartAfterInstall 默认 true（NSIS 装完自动重启应用）——故无需 plugin-process 的 relaunch，
// Finished 后应用随即退出升级，promise 正常 resolve 仅出现在退出失败的边缘情形。
import { useEffect, useRef, useState } from "react";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

import { getSettings } from "../tauri/invoke";
import { formatFileSize } from "../library/tags";
import { showConfirm } from "./dialog";
import {
  checkForUpdateManually,
  clearUpdateAvailable,
  downloadUpdateWithProgress,
  installUpdateAndQuit,
} from "./updater";
import { showToast } from "./toast";

type Phase = "checking" | "available" | "latest" | "downloading" | "finished" | "error";

/** 设置里的代理（proxy.* 三键）→ 插件 check 的 proxy 选项；配了就整条插件链路（检查+下载）走代理 */
async function pluginProxy(): Promise<string | undefined> {
  try {
    const s = await getSettings();
    if (s["proxy.enabled"] !== "1") return undefined;
    const host = (s["proxy.host"] ?? "").trim();
    const port = Number(s["proxy.port"]);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return `http://${host}:${port}`;
  } catch {
    return undefined;
  }
}

export default function UpdateModal({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState("");
  // 进度：downloaded 累计字节；total 为 null = 服务端未给长度（不确定态）
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const startedAtRef = useRef(0);
  const updateRef = useRef<Update | null>(null);

  async function runCheck() {
    setPhase("checking");
    setError("");
    try {
      const proxy = await pluginProxy();
      const update = await check(proxy ? { proxy } : undefined);
      updateRef.current = update;
      if (!update) {
        clearUpdateAvailable();
        setPhase("latest");
      } else {
        setPhase("available");
      }
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  useEffect(() => {
    void runCheck();
    // 关弹窗未安装：释放 Rust 侧 Update 资源（插件文档要求；安装路径应用已退出无所谓）
    return () => {
      void updateRef.current?.close().catch(() => {});
    };
  }, []);

  function onEvent(e: DownloadEvent) {
    if (e.event === "Started") {
      startedAtRef.current = Date.now();
      setDownloaded(0);
      setTotal(e.data.contentLength ?? null);
    } else if (e.event === "Progress") {
      setDownloaded((d) => d + e.data.chunkLength);
    } else {
      // Finished：安装器随即接管（Windows 进程退出 + 装完自动重启）
      setPhase("finished");
    }
  }

  async function startUpdate() {
    const update = updateRef.current;
    if (!update || phase !== "available") return;
    updateRef.current = null; // 安装路径不再需要 close 兜底
    setPhase("downloading");
    setDownloaded(0);
    setTotal(null);
    startedAtRef.current = Date.now();
    try {
      await update.downloadAndInstall(onEvent);
      // Windows 正常到这里前进程已被安装器接管退出；resolve = 退出失败边缘情形
      setPhase("finished");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  /** 备用通道（代理用户路径）：老 GitHub 链路吃 proxy.* 设置并自动试本地代理端口 */
  async function startFallback() {
    setPhase("downloading");
    setDownloaded(0);
    setTotal(null);
    startedAtRef.current = Date.now();
    try {
      const info = await checkForUpdateManually();
      if (!info.hasUpdate) {
        showToast("备用通道未发现新版本");
        setPhase("available");
        return;
      }
      if (!info.assetUrl) {
        setError("备用通道未找到安装包资产（仅源码发布？请到发布页手动下载）");
        setPhase("error");
        return;
      }
      const installerPath = await downloadUpdateWithProgress(info.assetUrl, (p) => {
        setDownloaded(p.downloaded);
        setTotal(p.total);
      });
      const ok = await showConfirm("下载完成", `v${info.latest} 安装包已就绪，立即重启并安装？`, {
        confirmText: "立即重启安装",
      });
      if (ok) {
        await installUpdateAndQuit(installerPath); // 成功路径应用退出；失败走下方 catch
        return;
      }
      showToast("安装包已下载，可稍后重试更新");
      setPhase("available");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  const canClose = phase !== "downloading";
  const update = phase === "available" ? updateRef.current : null;
  const pct = total && total > 0 ? Math.min(100, (downloaded / total) * 100) : null;
  const elapsed = (Date.now() - startedAtRef.current) / 1000;
  const speed = downloaded > 0 && elapsed > 0.5 ? downloaded / elapsed : null;
  const remain = speed && total && total > downloaded ? (total - downloaded) / speed : null;

  return (
    <div
      className="wr-prompt-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && canClose) onClose();
      }}
    >
      <div
        className="wr-panel wr-prompt wr-dialog"
        style={{ maxWidth: 480 }}
        role="dialog"
        aria-modal="true"
        aria-label="软件更新"
        onKeyDown={(e) => {
          if (e.key === "Escape" && canClose) onClose();
        }}
      >
        <div className="wr-prompt-title">软件更新</div>
        <div className="wr-prompt-body">
          {phase === "checking" ? <div className="wr-muted">正在检查更新…</div> : null}

          {phase === "latest" ? <div>当前已是最新版本。</div> : null}

          {update ? (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                发现新版本 <span style={{ color: "var(--wr-accent)" }}>v{update.version}</span>
                <span className="wr-muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                  当前 v{update.currentVersion}
                </span>
              </div>
              {update.date ? (
                <div className="wr-muted" style={{ fontSize: 12, marginBottom: 6 }}>
                  发布于 {update.date.slice(0, 10)}
                </div>
              ) : null}
              {update.body?.trim() ? (
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "32vh", overflowY: "auto" }}>
                  {update.body.trim().split("\n").slice(0, 12).join("\n")}
                </div>
              ) : null}
            </div>
          ) : null}

          {phase === "downloading" || phase === "finished" ? (
            <div aria-live="polite">
              <div style={{ marginBottom: 8, fontSize: 13 }}>
                {phase === "finished" ? "下载完成，正在启动安装…" : "正在下载更新…"}
              </div>
              <div
                style={{ height: 6, borderRadius: 3, background: "rgba(var(--wr-ink-rgb), 0.08)", overflow: "hidden" }}
                role="progressbar"
                aria-valuenow={pct != null ? Math.round(pct) : undefined}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  style={{
                    width: pct != null ? `${pct}%` : "100%",
                    height: "100%",
                    background: "var(--wr-accent)",
                    opacity: pct != null ? 1 : 0.35,
                    transition: "width 200ms ease",
                  }}
                />
              </div>
              <div className="wr-muted" style={{ fontSize: 12, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
                {formatFileSize(downloaded)}
                {total != null ? ` / ${formatFileSize(total)}` : ""}
                {speed != null ? ` · ${formatFileSize(speed)}/s` : ""}
                {remain != null ? ` · 剩余约 ${remain > 90 ? `${Math.round(remain / 60)} 分钟` : `${Math.max(1, Math.round(remain))} 秒`}` : ""}
              </div>
              {phase === "finished" ? (
                <div className="wr-muted" style={{ fontSize: 12, marginTop: 8 }}>
                  安装器接管后将自动退出应用，安装完成后自动重启（Windows 静默升级）。
                </div>
              ) : null}
            </div>
          ) : null}

          {phase === "error" ? (
            <div>
              <div style={{ color: "var(--wr-danger)", wordBreak: "break-word", fontSize: 13 }}>{error}</div>
              <div className="wr-muted" style={{ fontSize: 12, marginTop: 8 }}>
                插件通道不吃系统代理之外的默认代理；可在 设置→网络 配置代理后重试，或用备用通道（自动尝试代理与本地端口）。
                插件不支持断点续传，失败后为整包重下。
              </div>
            </div>
          ) : null}
        </div>
        <div className="wr-prompt-actions">
          {phase === "available" ? (
            <button className="wr-btn wr-btn-primary" onClick={() => void startUpdate()}>
              立即更新
            </button>
          ) : null}
          {phase === "error" ? (
            <>
              <button className="wr-btn" onClick={() => void startFallback()}>
                用备用通道下载
              </button>
              <button className="wr-btn wr-btn-primary" onClick={() => void runCheck()}>
                重试
              </button>
            </>
          ) : null}
          {phase === "finished" ? null : (
            <button className="wr-btn" disabled={!canClose} onClick={canClose ? onClose : undefined}>
              {phase === "downloading" ? "更新中…" : "关闭"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
