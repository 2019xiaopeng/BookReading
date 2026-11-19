import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { clearCache, getSettings, migrateLibraryRoot, reextractAllCovers, removeOldLibrary, setSetting, storageStats, type ImportMode, type StorageStats, type UpdateInfo } from "../tauri/invoke";
import { formatFileSize } from "../library/tags";
import { BOOKS_CHANGED_EVENT } from "../library/importRunner";
import HealthScanDialog from "../library/HealthScanDialog";
import CleanTitleDialog from "../library/CleanTitleDialog";
import { invalidateAllCoverUrls } from "../library/useCoverUrls";
import { notifyBackgroundChanged, resetBackgroundCache } from "./appBackground";
import { showAlert, showChoice, showConfirm } from "./dialog";
import { IconUpdate } from "./icons";
import { resolveCloseAction, setCloseBehavior, type CloseBehavior } from "./closeAction";
import {
  checkForUpdateManually,
  downloadUpdateWithProgress,
  installUpdateAndQuit,
  releasePageFromAssetUrl,
  RELEASES_URL,
} from "./updater";
import { showToast } from "./toast";

const RETENTION_LABELS: Record<string, string> = { "7": "7 天", "30": "30 天", "0": "永不" };

// M-3 导入方式：写 settings 键 import_mode（导入管线读）；小字说明各语义
const IMPORT_MODE_OPTIONS: { value: ImportMode; label: string; hint: string }[] = [
  { value: "copy", label: "复制入库（默认）", hint: "复制一份入库，源文件保留原处" },
  { value: "move", label: "移动（源文件入回收站）", hint: "复制校验通过后把源文件移入系统回收站" },
  { value: "reference", label: "原地引用（EPUB/PDF）", hint: "不复制，直接引用原路径；移动或删除源文件会失链（体检可重链接）" },
];

// 快捷键静态表（与 ReaderPage.onKeyDown / LibraryPage 键盘导航对齐）
const READER_KEYS: [string, string][] = [
  ["← / → / PgUp / PgDn", "翻页（漫画 RTL 下方向语义反转）"],
  ["滚轮", "滚动阅读 / 翻页"],
  ["空格", "条漫模式：自动滚动播放 / 暂停"],
  ["↑ / ↓", "自动滚动播放中：速度 ±10px/s"],
  ["Esc", "关抽屉 → 解除界面锁定 → 唤醒工具栏"],
  ["F11", "窗口全屏开关（独立于沉浸锁定）"],
  ["Ctrl+F", "书内搜索（EPUB）"],
  ["Ctrl+B", "在当前位置加书签"],
  ["Ctrl+D", "锁定 / 解锁界面"],
  ["Ctrl+滚轮 / 双击", "漫画缩放 / 复位缩放"],
  ["PDF", "与漫画一致（连续滚动支持空格自动滚动）"],
];
const LIBRARY_KEYS: [string, string][] = [
  ["Enter / Space", "打开选中的书或书架"],
  ["Tab", "在书与书架间移动焦点"],
  ["右键", "上下文菜单"],
  ["拖拽", "把书移入书架（含批量）"],
];

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [retention, setRetention] = useState("30 天");
  const [version, setVersion] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  // v2.7.0：导入方式（M-3）/ 关闭按钮行为（C-2）/ 自动检查更新（U-3）
  const [importMode, setImportMode] = useState<ImportMode>("copy");
  const [closeBehavior, setCloseBehaviorState] = useState<CloseBehavior>("ask");
  const [autoUpdateCheck, setAutoUpdateCheck] = useState(true);
  // U-1/U-2 手动检查更新：idle → checking →（弹窗确认后）downloading
  const [updatePhase, setUpdatePhase] = useState<"idle" | "checking" | "downloading">("idle");
  const [dlProgress, setDlProgress] = useState<{ downloaded: number; total: number } | null>(null);
  // H-5 后台插图优化进度：事件仅在优化进行中持续发，无事件/已完成时隐藏
  const [optProgress, setOptProgress] = useState<{ done: number; total: number } | null>(null);

  const reload = async () => {
    const [s, settings] = await Promise.all([storageStats(), getSettings()]);
    setStats(s);
    setRetention(RETENTION_LABELS[settings.trash_retention_days ?? "30"] ?? `${settings.trash_retention_days} 天`);
    setImportMode(settings.import_mode === "move" || settings.import_mode === "reference" ? settings.import_mode : "copy");
    setCloseBehaviorState(resolveCloseAction(settings.close_action));
    setAutoUpdateCheck(settings.update_check !== "off");
  };

  useEffect(() => {
    reload().catch((e) => showAlert("读取存储信息失败", String(e)));
    getVersion().then(setVersion).catch(() => setVersion("未知"));
  }, []);

  // H-5：epub-opt-progress {done,total}——存储组小字显示后台优化副本进度
  useEffect(() => {
    const un = listen<{ done: number; total: number }>("epub-opt-progress", (e) => setOptProgress(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  async function clearCats(cats: string[]) {
    if (busy || cats.length === 0) return;
    setBusy(true);
    try {
      const res = await clearCache(cats);
      if (cats.includes("covers")) {
        invalidateAllCoverUrls();
        window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
      }
      if (cats.includes("bg")) {
        resetBackgroundCache();
        notifyBackgroundChanged();
      }
      await reload();
      setChecked(new Set());
      await showAlert("清理完成", `已释放 ${formatFileSize(res.freed_bytes)}。`);
    } catch (e) {
      await showAlert("清理失败", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onMigrate() {
    if (!stats || busy) return;
    const target = await open({ directory: true, multiple: false, title: "选择新的书库位置（空目录）" });
    if (typeof target !== "string") return;
    const size = stats.library_bytes + stats.covers_bytes + stats.bg_bytes + stats.db_bytes;
    const ok = await showConfirm(
      "迁移书库",
      `目标位置：\n${target}\n\n将复制约 ${formatFileSize(size)}（书籍、封面、背景与数据库；复制式迁移，原位置保留作回滚兜底）。\n迁移完成后需重启应用生效。`,
      { confirmText: "开始迁移" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      // 批次16：迁移后追问是否删除旧库文件（Rust 端按迁移记录校验，bootstrap db 永不动）
      const res = await migrateLibraryRoot(target);
      const del = await showConfirm(
        "迁移完成",
        `已复制 ${formatFileSize(res.moved_bytes)}。重启应用后新库生效。\n\n是否删除旧位置的库文件以释放空间？\n${res.old_library}`,
        { danger: true, confirmText: "删除旧文件" },
      );
      if (del) {
        try {
          await showAlert("清理完成", await removeOldLibrary(res.old_library, res.old_db));
        } catch (e2) {
          await showAlert("删除旧文件失败", String(e2));
        }
      } else {
        await showAlert("迁移完成", `旧文件保留于 ${res.old_library}，可稍后手动删除。`);
      }
    } catch (e) {
      await showAlert("迁移失败", String(e));
    } finally {
      setBusy(false);
    }
  }

  // U-1/U-2：打开发布页（opener 插件；失败退复制链接）
  async function openReleasePage(info: UpdateInfo): Promise<void> {
    const url = info.assetUrl ? releasePageFromAssetUrl(info.assetUrl) : RELEASES_URL;
    try {
      await openUrl(url);
    } catch {
      try {
        await navigator.clipboard.writeText(url);
        showToast("已复制发布页链接");
      } catch {
        await showAlert("打开发布页失败", url);
      }
    }
  }

  // U-1/U-2：手动检查 → 已是最新 toast / 新版弹窗（下载并安装 · 打开发布页）；下载带进度，完成后确认重启安装
  async function onUpdateCheck() {
    if (busy || updatePhase !== "idle") return;
    setUpdatePhase("checking");
    try {
      const info = await checkForUpdateManually();
      if (!info.hasUpdate) {
        showToast("当前已是最新版本");
        return;
      }
      const notes = info.notes.trim().split("\n").slice(0, 8).join("\n");
      const size = info.assetSize != null ? `（安装包约 ${formatFileSize(info.assetSize)}）` : "";
      const act = await showChoice(`发现新版本 v${info.latest}`, `当前 ${info.current} → v${info.latest}${size}\n\n${notes}`, {
        confirmText: "下载并安装",
        secondaryText: "打开发布页",
      });
      if (act === "secondary") {
        await openReleasePage(info);
        return;
      }
      if (act !== "primary") return;
      if (!info.assetUrl) {
        await openReleasePage(info); // 无安装包资产（如仅源码发布）：只能去发布页
        return;
      }
      setUpdatePhase("downloading");
      setDlProgress(null);
      const installerPath = await downloadUpdateWithProgress(info.assetUrl, setDlProgress);
      const ok = await showConfirm("下载完成", `v${info.latest} 安装包已就绪，立即重启并安装？`, { confirmText: "立即重启安装" });
      if (ok) {
        setUpdatePhase("idle");
        try {
          await installUpdateAndQuit(installerPath); // 成功路径应用退出，弹窗无需回显
        } catch (e) {
          await showAlert("启动安装器失败", `${String(e)}\n\n可从发布页手动下载安装。`);
        }
        return;
      }
      showToast("安装包已下载，可稍后重新检查更新安装");
    } catch (e) {
      await showAlert("检查更新失败", String(e));
    } finally {
      setUpdatePhase("idle");
      setDlProgress(null);
    }
  }

  // B13：为存量 EPUB 重提最高清封面；覆盖 covers 后必须整体失效封面缓存（同 path 内容已变）
  async function onReextractCovers() {
    if (busy) return;
    const ok = await showConfirm("重新提取全部封面", "将为所有 EPUB 重新选择最高清封面。\n已手动设置过封面的书也会被覆盖。", {
      confirmText: "重新提取",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const n = await reextractAllCovers();
      invalidateAllCoverUrls();
      window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
      await reload();
      await showAlert("重新提取完成", `已更新 ${n} 本。`);
    } catch (e) {
      await showAlert("重新提取失败", String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleCat(cat: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  // 占用行：books/db 不可清（按钮灰显 + title 说明），其余类别走 clear_cache
  type StorageRow = { key: string; label: string; bytes: number; extra?: string; clearable: boolean; title: string };
  const rows: StorageRow[] = stats
    ? [
        {
          key: "books",
          label: "书库文件",
          bytes: stats.library_bytes,
          extra: `回收站 ${stats.trash_count} 本`,
          clearable: false,
          title: "书籍本体不可清理，请在书库中删除",
        },
        {
          key: "covers",
          label: "封面缓存",
          bytes: stats.covers_bytes,
          clearable: true,
          title: "清理后文件夹漫画自动重拷首页，其余回退文字卡",
        },
        {
          key: "bg",
          label: "阅读背景图",
          bytes: stats.bg_bytes,
          clearable: true,
          title: "清理后恢复默认底色",
        },
        { key: "db", label: "数据库", bytes: stats.db_bytes, clearable: false, title: "数据库不可清理" },
        { key: "logs", label: "运行日志", bytes: stats.logs_bytes, clearable: true, title: "清空运行日志" },
      ]
    : [];

  return (
    <div
      className="wr-prompt-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="wr-panel wr-prompt wr-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
        }}
      >
        <div className="wr-prompt-title">设置</div>

        <div className="wr-settings-group">存储</div>
        <div className="wr-settings-row">
          <span className="wr-settings-label">书库位置</span>
          <span className="wr-settings-value" title={stats?.library_root}>
            {stats?.library_root ?? "…"}
          </span>
          <button className="wr-btn wr-btn-primary" disabled={!stats || busy} onClick={() => void onMigrate()}>
            迁移书库…
          </button>
        </div>

        <div className="wr-settings-row">
          <span className="wr-settings-label">封面重提取</span>
          <span className="wr-settings-value">为存量 EPUB 重新选择最高清封面</span>
          <button className="wr-btn" disabled={!stats || busy} onClick={() => void onReextractCovers()}>
            重新提取全部封面
          </button>
        </div>

        <div className="wr-settings-row">
          <span className="wr-settings-label">书库体检</span>
          <span className="wr-settings-value">检查重复导入、失链与悬空封面</span>
          <button className="wr-btn" onClick={() => setHealthOpen(true)}>
            开始体检
          </button>
        </div>

        <div className="wr-settings-row">
          <span className="wr-settings-label">智能清洗标题</span>
          <span className="wr-settings-value">剥离实体码/水印/发布标签，拆分双语标题</span>
          <button className="wr-btn" onClick={() => setCleanOpen(true)}>
            重新清洗全部标题
          </button>
        </div>

        <div className="wr-settings-row">
          <span className="wr-settings-label">导入方式</span>
          <span
            className="wr-settings-value"
            style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, whiteSpace: "normal" }}
          >
            <select
              className="wr-select"
              value={importMode}
              aria-label="导入方式"
              onChange={(e) => {
                const v = e.currentTarget.value as ImportMode;
                setImportMode(v);
                void setSetting("import_mode", v);
              }}
            >
              {IMPORT_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="wr-settings-hint">{IMPORT_MODE_OPTIONS.find((o) => o.value === importMode)?.hint}</span>
          </span>
        </div>

        {rows.map((r) => (
          <div className="wr-settings-row" key={r.key}>
            <span className="wr-settings-label">
              {r.label}
              {r.extra ? <span className="wr-settings-hint">（{r.extra}）</span> : null}
            </span>
            <span className="wr-settings-value">{formatFileSize(r.bytes)}</span>
            <button
              className="wr-btn"
              disabled={!r.clearable || busy || r.bytes === 0}
              title={r.title}
              aria-label={`清理${r.label}`}
              onClick={() => void clearCats([r.key])}
            >
              清理
            </button>
          </div>
        ))}

        {/* H-5 后台插图优化进度：事件进行中才显示（无事件/已完成隐藏） */}
        {optProgress && optProgress.done < optProgress.total ? (
          <div className="wr-settings-row" aria-live="polite">
            <span className="wr-settings-label">后台任务</span>
            <span className="wr-settings-value">
              插图优化副本 {optProgress.done}/{optProgress.total}
            </span>
          </div>
        ) : null}

        <div className="wr-settings-row wr-settings-sweep">
          <span className="wr-settings-label">
            一键清理
            <span className="wr-settings-hint">（勾选要清理的类别）</span>
          </span>
          {(["covers", "bg", "logs"] as const).map((cat) => (
            <label key={cat} className="wr-settings-check">
              <input
                type="checkbox"
                checked={checked.has(cat)}
                onChange={() => toggleCat(cat)}
                aria-label={
                  cat === "covers" ? "封面缓存" : cat === "bg" ? "阅读背景图" : "运行日志"
                }
              />
              {cat === "covers" ? "封面" : cat === "bg" ? "背景" : "日志"}
            </label>
          ))}
          <button
            className="wr-btn wr-btn-danger"
            disabled={busy || checked.size === 0}
            onClick={async () => {
              const cats = [...checked];
              const labels = cats.map((c) => (c === "covers" ? "封面缓存" : c === "bg" ? "阅读背景图" : "运行日志"));
              if (
                await showConfirm("一键清理", `清理以下类别？\n${labels.map((l) => `· ${l}`).join("\n")}`, {
                  danger: true,
                  confirmText: "清理",
                })
              ) {
                await clearCats(cats);
              }
            }}
          >
            清理
          </button>
        </div>

        <div className="wr-settings-group">数据</div>
        <div className="wr-settings-row">
          <span className="wr-settings-label">回收站保留期</span>
          <span className="wr-settings-value">{retention}（在回收站页修改）</span>
        </div>

        <div className="wr-settings-group">窗口</div>
        <div className="wr-settings-row">
          <span className="wr-settings-label">关闭按钮行为</span>
          <span className="wr-settings-value">
            <select
              className="wr-select"
              value={closeBehavior}
              aria-label="关闭按钮行为"
              onChange={(e) => {
                const v = e.currentTarget.value as CloseBehavior;
                setCloseBehaviorState(v);
                setCloseBehavior(v);
              }}
            >
              <option value="ask">每次询问</option>
              <option value="tray">最小化到托盘</option>
              <option value="exit">退出</option>
            </select>
          </span>
        </div>

        <div className="wr-settings-group">关于</div>
        <div className="wr-settings-row">
          <span className="wr-settings-label">版本</span>
          <span className="wr-settings-value">{version || "…"}</span>
        </div>
        <div className="wr-settings-row">
          <span className="wr-settings-label">检查更新</span>
          <span className="wr-settings-value">
            {updatePhase === "downloading" && dlProgress
              ? `下载中 ${(dlProgress.downloaded / 1048576).toFixed(1)}/${(dlProgress.total / 1048576).toFixed(1)} MB`
              : updatePhase === "checking"
                ? "正在检查…"
                : "GitHub Releases"}
          </span>
          <button className="wr-btn wr-btn-primary" disabled={busy || updatePhase !== "idle"} onClick={() => void onUpdateCheck()}>
            <IconUpdate />
            {updatePhase === "idle" ? "检查更新" : updatePhase === "checking" ? "检查中…" : "下载中…"}
          </button>
        </div>
        <div className="wr-settings-row">
          <span className="wr-settings-label">自动检查</span>
          <label className="wr-settings-check">
            <input
              type="checkbox"
              checked={autoUpdateCheck}
              aria-label="启动时自动检查更新"
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setAutoUpdateCheck(on);
                void setSetting("update_check", on ? "on" : "off");
              }}
            />
            启动时静默检查，发现新版在设置入口提示
          </label>
        </div>
        <div className="wr-settings-row">
          <span className="wr-settings-label">数据库</span>
          <span className="wr-settings-value" title={stats?.db_path}>
            {stats?.db_path ?? "…"}
          </span>
        </div>

        <div className="wr-settings-group">快捷键</div>
        <table className="wr-kbd-table">
          <tbody>
            <tr>
              <th scope="row">阅读</th>
              <td>
                {READER_KEYS.map(([k, v]) => (
                  <div key={k}>
                    <span className="wr-kbd">{k}</span> {v}
                  </div>
                ))}
              </td>
            </tr>
            <tr>
              <th scope="row">书库</th>
              <td>
                {LIBRARY_KEYS.map(([k, v]) => (
                  <div key={k}>
                    <span className="wr-kbd">{k}</span> {v}
                  </div>
                ))}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="wr-prompt-actions">
          <button className="wr-btn wr-btn-primary" autoFocus disabled={busy} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      {healthOpen ? <HealthScanDialog onClose={() => setHealthOpen(false)} /> : null}
      {cleanOpen ? <CleanTitleDialog onClose={() => setCleanOpen(false)} onChanged={() => {}} /> : null}
    </div>
  );
}
