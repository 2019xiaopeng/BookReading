// V-3 设置浮窗（PyCharm 式，2026-11-25 用户定稿）：居中模态弹窗——顶部大字标题，左侧分区目录 + 右侧配置面板，
// 只有右侧面板内部滚动；遮罩 / Esc / 「关闭」退出，底下的书架页不切页、状态原样保留。
// 八个分区在 src/settings/（登记表 sections.ts）。阅读页的设置抽屉是另一套，不在这里。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  getSettings,
  listShelves,
  saveReaderBackground,
  setSetting,
  setSettings,
  storageStats,
  type Shelf,
  type StorageStats,
} from "../tauri/invoke";
import { wenku8Status } from "../tauri/wenku8";
import { setCachedSetting } from "../library/settingsCache";
import { shelfTreeRows } from "../library/shelves";
import { showToast } from "./toast";
import { showAlert } from "./dialog";
import { Modal, WrSelect } from "./radix";
import {
  IconBookOpen,
  IconCloud,
  IconImage,
  IconInfo,
  IconKeyboard,
  IconPalette,
  IconShelf,
  IconUpdate,
} from "./icons";
import { setTheme, THEME_SWATCHES, useThemeSelection } from "./theme";
import { getBackgroundUrl, notifyBackgroundChanged, resetBackgroundCache } from "./appBackground";
import { resolveCloseAction, setCloseBehavior } from "./closeAction";
import { getUpdateAvailable, subscribeUpdateAvailable } from "./updater";
import NetworkSettings from "./NetworkSettings";
import UpdateModal from "./UpdateModal";
import { normalizeBgVeil, normalizeReaderBackground } from "../reader/settings/normalize";
import { SETTINGS_SECTIONS, normalizeSettingsSection, type SettingsSectionId } from "../settings/sections";
import { Check, type SettingsCtx, SectionHeader, SettingsGroup, SettingsRow, Slider } from "../settings/controls";
import { MangaSection, ReadingSection } from "../settings/ReaderDefaultsSections";
import LibrarySection from "../settings/LibrarySection";

const PROJECT_URL = "https://github.com/2019xiaopeng/BookReading";

const CLOSE_OPTIONS = [
  { value: "ask", label: "每次询问" },
  { value: "tray", label: "最小化到托盘" },
  { value: "exit", label: "退出" },
];

// ---- 云书架：settings 键与 CloudShelfPage 同键（那边页面内也各有一份字面量） ----
const CLOUD_DEST_SHELF_KEY = "wenku8.dest_shelf"; // '' = 书库根
const CLOUD_SORT_KEY = "wenku8.sort"; // added=收藏顺序（API 返回序）/ updated=最近更新 / title=书名
const CLOUD_SORT_OPTIONS = [
  { value: "added", label: "收藏顺序" },
  { value: "updated", label: "最近更新" },
  { value: "title", label: "书名" },
];
function normalizeCloudSort(v: unknown): string {
  return v === "updated" || v === "title" ? v : "added";
}

// 快捷键静态表（与 ReaderPage.onKeyDown / LibraryPage 键盘导航对齐；自原设置弹窗原样迁入）
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

// 分区图标：目录行里固定 18px 宽，切换选中态不改变任何尺寸
const SECTION_ICONS: Record<SettingsSectionId, ReactNode> = {
  appearance: <IconPalette />,
  reading: <IconBookOpen />,
  library: <IconShelf />,
  cloud: <IconCloud />,
  network: <IconUpdate />,
  shortcuts: <IconKeyboard />,
  manga: <IconImage />,
  about: <IconInfo />,
};

const tabId = (id: SettingsSectionId) => `wr-settings-tab-${id}`;

export default function SettingsDialog(props: { initialSection?: SettingsSectionId; onClose: () => void }) {
  const [section, setSection] = useState<SettingsSectionId>(() => normalizeSettingsSection(props.initialSection));
  const [map, setMap] = useState<Record<string, string>>({});
  const [version, setVersion] = useState("");
  const [stats, setStats] = useState<StorageStats | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  // 书库迁移 / 清理进行中不响应关闭（沿原设置弹窗口径：迁移后的"是否删旧文件"追问不能被关窗吞掉）
  const heldRef = useRef(false);

  useEffect(() => {
    // DB 不可达时各控件显示默认值（与"未设置过"同一表现）
    getSettings().then(setMap).catch(() => {});
    getVersion().then(setVersion).catch(() => setVersion("未知"));
  }, []);

  // 存储占用要遍历书库算大小：只在用得到的两分区惰性取一次；清理/迁移后置空触发重取
  const needStats = section === "library" || section === "about";
  useEffect(() => {
    if (!needStats || stats) return;
    let cancelled = false;
    storageStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [needStats, stats]);

  // 切分区回顶（右侧面板是唯一滚动区，位置固定——不让滚动位置跨分区残留）
  useEffect(() => {
    const el = paneRef.current;
    if (el) el.scrollTop = 0;
  }, [section]);

  const patch = useCallback((values: Record<string, string>) => {
    setMap((m) => ({ ...m, ...values }));
    for (const [k, v] of Object.entries(values)) setCachedSetting(k, v);
  }, []);
  const put = useCallback(
    async (key: string, value: string) => {
      patch({ [key]: value });
      try {
        await setSetting(key, value);
      } catch {
        showToast("保存设置失败");
      }
    },
    [patch],
  );
  const putMany = useCallback(
    async (values: Record<string, string>) => {
      patch(values);
      try {
        await setSettings(values);
      } catch {
        showToast("保存设置失败");
      }
    },
    [patch],
  );
  const hold = useCallback((on: boolean) => {
    heldRef.current = on;
  }, []);
  const requestClose = useCallback(() => {
    if (!heldRef.current) props.onClose();
  }, [props]);
  const ctx = useMemo<SettingsCtx>(
    () => ({ map, patch, put, putMany, version, close: requestClose, hold }),
    [map, patch, put, putMany, version, requestClose, hold],
  );

  // 目录的键盘操作（WAI-ARIA 标签页）：上下方向键 / Home / End 在分区间移动并直接切换
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = SETTINGS_SECTIONS.length;
    const idx = SETTINGS_SECTIONS.findIndex((s) => s.id === section);
    let next = idx;
    if (e.key === "ArrowDown") next = (idx + 1) % n;
    else if (e.key === "ArrowUp") next = (idx - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    const id = SETTINGS_SECTIONS[next].id;
    setSection(id);
    document.getElementById(tabId(id))?.focus();
  };

  return (
    <Modal label="设置" onClose={requestClose} panelClassName="wr-panel wr-prompt wr-dialog wr-settings-dialog">
      <div className="wr-settings-frame">
        {/* 标题与书架 / 收藏刊头同款大字；右侧一行小字 */}
        <div className="wr-settings-mast">
          <h1 className="wr-masthead-name">设 置</h1>
          <div className="wr-masthead-stats">BookReading v{version || "…"} · 更改即时保存</div>
        </div>

        <div className="wr-settings-frame-body">
          <div className="wr-settings-nav" role="tablist" aria-label="设置分区" aria-orientation="vertical" onKeyDown={onTabKey}>
            {SETTINGS_SECTIONS.map((s) => {
              const active = s.id === section;
              return (
                <button
                  key={s.id}
                  id={tabId(s.id)}
                  type="button"
                  role="tab"
                  className="wr-settings-tab"
                  data-section={s.id}
                  aria-selected={active}
                  aria-controls="wr-settings-panel"
                  tabIndex={active ? 0 : -1}
                  title={s.desc}
                  onClick={() => setSection(s.id)}
                >
                  <span className="wr-settings-tab-icon" aria-hidden="true">
                    {SECTION_ICONS[s.id]}
                  </span>
                  <span className="wr-settings-tab-label">{s.label}</span>
                </button>
              );
            })}
          </div>
          <div className="wr-settings-pane" ref={paneRef}>
            <div
              className="wr-settings-body"
              key={section}
              role="tabpanel"
              id="wr-settings-panel"
              aria-labelledby={tabId(section)}
            >
              {section === "appearance" ? <AppearanceSection ctx={ctx} /> : null}
              {section === "reading" ? <ReadingSection ctx={ctx} /> : null}
              {section === "library" ? <LibrarySection ctx={ctx} stats={stats} onStatsStale={() => setStats(null)} /> : null}
              {section === "cloud" ? <CloudSection ctx={ctx} /> : null}
              {section === "network" ? <NetworkSection ctx={ctx} /> : null}
              {section === "shortcuts" ? <ShortcutsSection /> : null}
              {section === "manga" ? <MangaSection ctx={ctx} /> : null}
              {section === "about" ? <AboutSection ctx={ctx} dbPath={stats?.db_path ?? null} /> : null}
            </div>
          </div>
        </div>

        <div className="wr-settings-foot">
          <span className="wr-settings-foot-note">点遮罩或按 Esc 关闭</span>
          <button type="button" className="wr-btn wr-btn-primary" onClick={requestClose}>
            关闭
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────── 外观 ─────────────────────────

function AppearanceSection({ ctx }: { ctx: SettingsCtx }) {
  const theme = useThemeSelection();
  const bg = normalizeReaderBackground(ctx.map.reader_bg);
  const veil = normalizeBgVeil(ctx.map.bg_veil);
  const closeBehavior = resolveCloseAction(ctx.map.close_action);
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgError, setBgError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBackgroundUrl(bg)
      .then((url) => {
        if (!cancelled) setBgUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bg]);

  // 换背景：后端覆写同一路径，旧 blob 必须作废；写完再广播，壳读到的是新值
  async function pickBackground() {
    if (bgBusy) return;
    setBgError(null);
    setBgBusy(true);
    try {
      const picked = await open({ filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      if (typeof picked !== "string") return;
      const path = await saveReaderBackground(picked);
      resetBackgroundCache();
      await ctx.put("reader_bg", JSON.stringify({ type: "image", path }));
      notifyBackgroundChanged();
    } catch (e) {
      setBgError(String(e));
    } finally {
      setBgBusy(false);
    }
  }

  async function resetBackground() {
    resetBackgroundCache();
    await ctx.put("reader_bg", JSON.stringify({ type: "preset" }));
    notifyBackgroundChanged();
  }

  return (
    <>
      <SectionHeader id="appearance" />

      <SettingsGroup title="主题">
        <div className="wr-settings-themes" role="group" aria-label="主题">
          {THEME_SWATCHES.map((s) => (
            <button
              key={s.value}
              type="button"
              className="wr-settings-theme"
              aria-pressed={theme === s.value}
              aria-label={s.label}
              onClick={() => setTheme(s.value)}
            >
              <span className="wr-settings-theme-chip" style={{ background: s.color }} aria-hidden="true" />
              <span className="wr-settings-theme-label">{s.label}</span>
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="背景">
        <SettingsRow label="背景图" hint="应用于书架与阅读纸面；书架和阅读页里也可以随时更换">
          <button type="button" className="wr-btn" onClick={() => void pickBackground()} disabled={bgBusy}>
            选择图片…
          </button>
          {bg.type === "image" ? (
            <button type="button" className="wr-btn" onClick={() => void resetBackground()} disabled={bgBusy}>
              恢复默认
            </button>
          ) : null}
          {bgUrl ? (
            <span className="wr-settings-bg-thumb" aria-hidden="true" style={{ backgroundImage: `url("${bgUrl}")` }} />
          ) : null}
        </SettingsRow>
        {bgError ? (
          <div className="wr-settings-hint" role="alert">
            {bgError}
          </div>
        ) : null}
        <SettingsRow label="纱浓度" hint={bg.type === "image" ? "背景图上覆盖的纸色薄纱，越高背景越淡" : "设置背景图后生效"}>
          <Slider
            label="纱浓度"
            value={veil}
            min={60}
            max={95}
            step={1}
            format={(n) => `${n}%`}
            disabled={bg.type !== "image"}
            onCommit={(v) => void ctx.put("bg_veil", String(v)).then(notifyBackgroundChanged)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="窗口">
        <SettingsRow label="关闭按钮行为" hint="点标题栏 ✕ 时的默认动作">
          <WrSelect
            ariaLabel="关闭按钮行为"
            value={closeBehavior}
            options={CLOSE_OPTIONS}
            onChange={(v) => {
              const next = resolveCloseAction(v);
              setCloseBehavior(next); // 自带写库 + 同步缓存，下次点 ✕ 立即生效
              ctx.patch({ close_action: next === "ask" ? "" : next }); // ask 在表里存空串
            }}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

// ───────────────────────── 云书架 ─────────────────────────

function CloudSection({ ctx }: { ctx: SettingsCtx }) {
  const navigate = useNavigate();
  const [account, setAccount] = useState<{ loaded: boolean; saved: boolean; name: string }>({ loaded: false, saved: false, name: "" });
  const [shelves, setShelves] = useState<Shelf[]>([]);

  // 账号状态要走一次网络探测：只在本分区挂载时查
  useEffect(() => {
    let cancelled = false;
    wenku8Status()
      .then((s) => {
        if (!cancelled) setAccount({ loaded: true, saved: s.has_saved, name: s.username ?? "" });
      })
      .catch(() => {
        if (!cancelled) setAccount({ loaded: true, saved: false, name: "" });
      });
    listShelves()
      .then((list) => {
        if (!cancelled) setShelves(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Radix Select 不接受空串作选项值，而设置表里"根书架"存的就是空串：界面上用占位值代替，读写时互换
  const ROOT = "__root__";
  const shelfOptions = [
    { value: ROOT, label: "书库（根）" },
    ...shelfTreeRows(shelves).map((r) => ({ value: String(r.id), label: `${"　".repeat(r.depth)}${r.name}` })),
  ];
  const storedShelf = ctx.map[CLOUD_DEST_SHELF_KEY] ?? "";
  // 记住的书架已被删除：显示回落到根，不留下拉空白
  const destShelf = shelfOptions.some((o) => o.value === storedShelf) ? storedShelf : ROOT;

  return (
    <>
      <SectionHeader id="cloud" />

      <SettingsGroup title="账号">
        <SettingsRow
          label="wenku8 账号"
          hint={
            !account.loaded
              ? "正在检查登录状态…"
              : account.saved
                ? `已登录${account.name ? `：${account.name}` : ""}`
                : "未登录——登录后可把云端书架拉取到本地"
          }
        >
          <button
            type="button"
            className="wr-btn"
            onClick={() => {
              ctx.close(); // 浮窗盖在书架页上：先收浮窗再切页
              navigate("/cloud-shelf");
            }}
          >
            {account.saved ? "打开云书架" : "前往登录"}
          </button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="拉取偏好">
        <SettingsRow label="默认目标书架" hint="在云书架里拉取书目时默认落入的书架">
          <WrSelect
            ariaLabel="默认目标书架"
            value={destShelf}
            options={shelfOptions}
            onChange={(v) => void ctx.put(CLOUD_DEST_SHELF_KEY, v === ROOT ? "" : v)}
          />
        </SettingsRow>
        <SettingsRow label="排序" hint="云书架页的显示顺序">
          <WrSelect
            ariaLabel="云书架排序"
            value={normalizeCloudSort(ctx.map[CLOUD_SORT_KEY])}
            options={CLOUD_SORT_OPTIONS}
            onChange={(v) => void ctx.put(CLOUD_SORT_KEY, v)}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

// ───────────────────────── 网络与更新 ─────────────────────────

function NetworkSection({ ctx }: { ctx: SettingsCtx }) {
  const update = useSyncExternalStore(subscribeUpdateAvailable, getUpdateAvailable, () => null);
  // 沿原弹窗口径：带着"发现新版本"红点进来时直接弹更新窗（侧栏红点钮会直达本分区）
  const [updateOpen, setUpdateOpen] = useState(() => getUpdateAvailable() != null);
  const autoCheck = ctx.map.update_check !== "off";

  return (
    <>
      <SectionHeader id="network" />
      <SettingsGroup title="网络">
        <NetworkSettings />
      </SettingsGroup>

      <SettingsGroup title="更新">
        <SettingsRow label="检查更新" hint={update ? `发现新版本 v${update.latest}` : `当前版本 v${ctx.version || "…"}`}>
          <button type="button" className="wr-btn wr-btn-primary" onClick={() => setUpdateOpen(true)}>
            <IconUpdate />
            检查更新
          </button>
        </SettingsRow>
        <SettingsRow label="自动检查">
          <Check
            text="启动时静默检查，发现新版在设置入口提示"
            checked={autoCheck}
            onChange={(on) => void ctx.put("update_check", on ? "on" : "off")}
          />
        </SettingsRow>
      </SettingsGroup>

      {updateOpen ? <UpdateModal onClose={() => setUpdateOpen(false)} /> : null}
    </>
  );
}

// ───────────────────────── 快捷键 ─────────────────────────

function KeyList({ keys }: { keys: [string, string][] }) {
  return (
    <div className="wr-settings-keys">
      {keys.map(([k, v]) => (
        <div className="wr-settings-key" key={k}>
          <span className="wr-kbd">{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

function ShortcutsSection() {
  return (
    <>
      <SectionHeader id="shortcuts" />
      <SettingsGroup title="阅读">
        <KeyList keys={READER_KEYS} />
      </SettingsGroup>
      <SettingsGroup title="书库">
        <KeyList keys={LIBRARY_KEYS} />
      </SettingsGroup>
    </>
  );
}

// ───────────────────────── 关于 ─────────────────────────

function AboutSection({ ctx, dbPath }: { ctx: SettingsCtx; dbPath: string | null }) {
  function openProject() {
    openUrl(PROJECT_URL).catch(() => void showAlert("打开网页失败", PROJECT_URL));
  }

  return (
    <>
      <SectionHeader id="about" />
      <SettingsGroup title="应用">
        <SettingsRow label="版本">
          <span className="wr-settings-value">BookReading v{ctx.version || "…"}</span>
        </SettingsRow>
        <SettingsRow label="项目主页" hint="问题反馈与发布记录">
          <button type="button" className="wr-btn" onClick={openProject}>
            GitHub ↗
          </button>
        </SettingsRow>
        <SettingsRow label="开源许可">
          <span className="wr-settings-value">MIT</span>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="数据">
        <SettingsRow label="数据库位置" hint="书籍信息、阅读进度与设置都在这个文件里">
          <span className="wr-settings-value wr-settings-path" title={dbPath ?? undefined}>
            {dbPath ?? "…"}
          </span>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
