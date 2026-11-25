// V-3 设置大页面「书库」分区：原 SettingsDialog 的位置 / 存储 / 导入 / 维护条目整体迁入（逻辑不变），
// 外加书架显示（密度、继续阅读卡）。存储占用要遍历书库算大小——由页面在本分区激活时惰性取，清理/迁移后经 onStatsStale 重取。
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import {
  clearCache,
  migrateLibraryRoot,
  reextractAllCovers,
  removeOldLibrary,
  type ImportMode,
  type StorageStats,
} from "../tauri/invoke";
import { formatFileSize } from "../library/tags";
import { BOOKS_CHANGED_EVENT } from "../library/importRunner";
import { invalidateAllCoverUrls } from "../library/useCoverUrls";
import { DENSITY_PRESETS, normalizeLibraryDensity, type LibraryDensity } from "../library/density";
import HealthScanDialog from "../library/HealthScanDialog";
import CleanTitleDialog from "../library/CleanTitleDialog";
import { resetBackgroundCache, notifyBackgroundChanged } from "../ui/appBackground";
import { showAlert, showConfirm } from "../ui/dialog";
import { WrSelect } from "../ui/radix";
import { Check, type SettingsCtx, SectionHeader, Seg, SettingsGroup, SettingsRow } from "./controls";

const RETENTION_LABELS: Record<string, string> = { "7": "7 天", "30": "30 天", "0": "永不" };

// M-3 导入方式：写 settings 键 import_mode（导入管线读）；小字说明各语义
const IMPORT_MODE_OPTIONS: { value: ImportMode; label: string; hint: string }[] = [
  { value: "copy", label: "复制入库（默认）", hint: "复制一份入库，源文件保留原处" },
  { value: "move", label: "移动（源文件入回收站）", hint: "复制校验通过后把源文件移入系统回收站" },
  { value: "reference", label: "原地引用（EPUB/PDF）", hint: "不复制，直接引用原路径；移动或删除源文件会失链（体检可重链接）" },
];

const SWEEP_CATS = [
  { cat: "covers", short: "封面", label: "封面缓存" },
  { cat: "bg", short: "背景", label: "阅读背景图" },
  { cat: "logs", short: "日志", label: "运行日志" },
] as const;

// 占用行：books/db 不可清（按钮灰显 + title 说明），其余类别走 clear_cache
type StorageRow = { key: string; label: string; bytes: number; extra?: string; clearable: boolean; title: string };
function storageRows(stats: StorageStats): StorageRow[] {
  return [
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
    { key: "bg", label: "阅读背景图", bytes: stats.bg_bytes, clearable: true, title: "清理后恢复默认底色" },
    { key: "db", label: "数据库", bytes: stats.db_bytes, clearable: false, title: "数据库不可清理" },
    { key: "logs", label: "运行日志", bytes: stats.logs_bytes, clearable: true, title: "清空运行日志" },
  ];
}

export default function LibrarySection(props: { ctx: SettingsCtx; stats: StorageStats | null; onStatsStale: () => void }) {
  const { ctx } = props;
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  // H-5 后台插图优化进度：事件仅在优化进行中持续发，无事件/已完成时隐藏
  const [optProgress, setOptProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    const un = listen<{ done: number; total: number }>("epub-opt-progress", (e) => setOptProgress(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // 迁移 / 清理 / 重提取进行中：告诉浮窗别响应关闭。登记放在操作开始的同一行（同步），不靠 effect——
  // effect 要等下一次渲染提交才执行，那个空档里 Esc 能穿透（测试全量跑时抓到过）。
  useEffect(() => () => ctx.hold(false), [ctx.hold]); // 卸载复位

  async function clearCats(cats: string[]) {
    if (busy || cats.length === 0) return;
    setBusy(true);
    ctx.hold(true);
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
      setChecked(new Set());
      props.onStatsStale();
      await showAlert("清理完成", `已释放 ${formatFileSize(res.freed_bytes)}。`);
    } catch (e) {
      await showAlert("清理失败", String(e));
    } finally {
      setBusy(false);
      ctx.hold(false);
    }
  }

  async function onMigrate() {
    if (!props.stats || busy) return;
    const target = await open({ directory: true, multiple: false, title: "选择新的书库位置（空目录）" });
    if (typeof target !== "string") return;
    const s = props.stats;
    const size = s.library_bytes + s.covers_bytes + s.bg_bytes + s.db_bytes;
    const ok = await showConfirm(
      "迁移书库",
      `目标位置：\n${target}\n\n将复制约 ${formatFileSize(size)}（书籍、封面、背景与数据库；复制式迁移，原位置保留作回滚兜底）。\n迁移完成后需重启应用生效。`,
      { confirmText: "开始迁移" },
    );
    if (!ok) return;
    setBusy(true);
    ctx.hold(true);
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
      ctx.hold(false);
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
    ctx.hold(true);
    try {
      const n = await reextractAllCovers();
      invalidateAllCoverUrls();
      window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
      props.onStatsStale();
      await showAlert("重新提取完成", `已更新 ${n} 本。`);
    } catch (e) {
      await showAlert("重新提取失败", String(e));
    } finally {
      setBusy(false);
      ctx.hold(false);
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

  const stats = props.stats;
  const rows = stats ? storageRows(stats) : [];
  const retentionRaw = ctx.map.trash_retention_days ?? "30";
  const retention = RETENTION_LABELS[retentionRaw] ?? `${retentionRaw} 天`;
  const importMode: ImportMode =
    ctx.map.import_mode === "move" || ctx.map.import_mode === "reference" ? ctx.map.import_mode : "copy";
  const importOptions = IMPORT_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

  return (
    <>
      <SectionHeader id="library" />

      <SettingsGroup title="位置">
        <SettingsRow label="书库位置" hint="迁移为复制式：新位置验证无误前，原位置保留作回滚兜底">
          <span className="wr-settings-value wr-settings-path" title={stats?.library_root}>
            {stats?.library_root ?? "…"}
          </span>
          {/* 低频的重操作：不用主按钮色，免得在整页里最抢眼 */}
          <button className="wr-btn" disabled={!stats || busy} onClick={() => void onMigrate()}>
            迁移书库…
          </button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="存储占用">
        {rows.map((r) => (
          <SettingsRow key={r.key} label={r.label} hint={r.extra ? `（${r.extra}）` : undefined}>
            <span className="wr-settings-value wr-settings-num">{formatFileSize(r.bytes)}</span>
            <button
              className="wr-btn"
              disabled={!r.clearable || busy || r.bytes === 0}
              title={r.title}
              aria-label={`清理${r.label}`}
              onClick={() => void clearCats([r.key])}
            >
              清理
            </button>
          </SettingsRow>
        ))}
        {optProgress && optProgress.done < optProgress.total ? (
          <SettingsRow label="后台任务">
            <span className="wr-settings-value" aria-live="polite">
              插图优化副本 {optProgress.done}/{optProgress.total}
            </span>
          </SettingsRow>
        ) : null}
        <SettingsRow label="一键清理" hint="勾选要清理的类别">
          {SWEEP_CATS.map((c) => (
            <Check key={c.cat} text={c.short} checked={checked.has(c.cat)} onChange={() => toggleCat(c.cat)} />
          ))}
          <button
            className="wr-btn wr-btn-danger"
            disabled={busy || checked.size === 0}
            onClick={async () => {
              const cats = [...checked];
              const labels = cats.map((c) => SWEEP_CATS.find((x) => x.cat === c)?.label ?? c);
              if (await showConfirm("一键清理", `清理以下类别？\n${labels.map((l) => `· ${l}`).join("\n")}`, { danger: true, confirmText: "清理" })) {
                await clearCats(cats);
              }
            }}
          >
            清理
          </button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="导入">
        <SettingsRow label="导入方式" hint={IMPORT_MODE_OPTIONS.find((o) => o.value === importMode)?.hint}>
          <WrSelect
            ariaLabel="导入方式"
            value={importMode}
            options={importOptions}
            onChange={(v) => void ctx.put("import_mode", v)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="维护">
        <SettingsRow label="封面重提取" hint="为存量 EPUB 重新选择最高清封面">
          <button className="wr-btn" disabled={!stats || busy} onClick={() => void onReextractCovers()}>
            重新提取全部封面
          </button>
        </SettingsRow>
        <SettingsRow label="书库体检" hint="检查重复导入、失链与悬空封面">
          <button className="wr-btn" onClick={() => setHealthOpen(true)}>
            开始体检
          </button>
        </SettingsRow>
        <SettingsRow label="智能清洗标题" hint="剥离实体码 / 水印 / 发布标签，拆分双语标题">
          <button className="wr-btn" onClick={() => setCleanOpen(true)}>
            重新清洗全部标题
          </button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="书架显示">
        <SettingsRow label="书架密度" hint="封面与卡片的大小">
          <Seg
            label="书架密度"
            value={normalizeLibraryDensity(ctx.map.library_density)}
            options={(Object.keys(DENSITY_PRESETS) as LibraryDensity[]).map((k) => ({ value: k, text: DENSITY_PRESETS[k].label }))}
            onPick={(v) => void ctx.put("library_density", v)}
          />
        </SettingsRow>
        <SettingsRow label="继续阅读卡">
          <Check
            text="在书架刊头下显示最近在读的书"
            checked={ctx.map["continue_card.enabled"] !== "0"}
            onChange={(on) => void ctx.put("continue_card.enabled", on ? "1" : "0")}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="数据">
        <SettingsRow label="回收站保留期" hint="到期自动清除；可在回收站页修改">
          <span className="wr-settings-value">{retention}</span>
        </SettingsRow>
      </SettingsGroup>

      {healthOpen ? <HealthScanDialog onClose={() => setHealthOpen(false)} /> : null}
      {cleanOpen ? <CleanTitleDialog onClose={() => setCleanOpen(false)} onChanged={() => {}} /> : null}
    </>
  );
}
