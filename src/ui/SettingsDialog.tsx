import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";

import { clearCache, getSettings, migrateLibraryRoot, reextractAllCovers, storageStats, type StorageStats } from "../tauri/invoke";
import { formatFileSize } from "../library/tags";
import { BOOKS_CHANGED_EVENT } from "../library/importRunner";
import { invalidateAllCoverUrls } from "../library/useCoverUrls";
import { notifyBackgroundChanged, resetBackgroundCache } from "./appBackground";
import { showAlert, showConfirm } from "./dialog";

const RETENTION_LABELS: Record<string, string> = { "7": "7 天", "30": "30 天", "0": "永不" };

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
  ["PDF", "复用漫画键位与热区（翻页 / 缩放 / Ctrl+B 书签；连续滚动模式无自动滚动）"],
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

  const reload = async () => {
    const [s, settings] = await Promise.all([storageStats(), getSettings()]);
    setStats(s);
    setRetention(RETENTION_LABELS[settings.trash_retention_days ?? "30"] ?? `${settings.trash_retention_days} 天`);
  };

  useEffect(() => {
    reload().catch((e) => showAlert("读取存储信息失败", String(e)));
    getVersion().then(setVersion).catch(() => setVersion("未知"));
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
      await showAlert("迁移完成", await migrateLibraryRoot(target));
    } catch (e) {
      await showAlert("迁移失败", String(e));
    } finally {
      setBusy(false);
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

        <div className="wr-settings-group">关于</div>
        <div className="wr-settings-row">
          <span className="wr-settings-label">版本</span>
          <span className="wr-settings-value">{version || "…"}</span>
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
    </div>
  );
}
