import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion } from "@tauri-apps/api/app";
import * as Menu from "@radix-ui/react-menu";
import { IconBook, IconCloud, IconImage, IconMenu, IconPalette, IconRefresh, IconSearch, IconSettings, IconStar, IconTrash, IconClose } from "./icons";
import { PointMenu, Tooltip, TooltipProvider } from "./radix";
import { useCompactSearch, useViewportTier } from "./viewportTier";
import { getCachedBackgroundUrl, getBackgroundUrl, subscribeBackground } from "./appBackground";
import { emitAppRefresh } from "./appActions";
import { importBooks, importImages } from "./importService";
import { installDesktopChrome } from "./desktopChrome";
import TitleBar from "./TitleBar";
import { applyPersistedTheme, setTheme, THEME_SWATCHES, useThemeSelection } from "./theme";
import {
  createShelf,
  deleteShelf,
  getSettings,
  listBooks,
  listShelves,
  renameShelf,
  setSetting,
  type Book,
  type Shelf,
} from "../tauri/invoke";
import { getAppDataBase } from "../tauri/appDataPaths";
import { primeSettingsCache } from "../library/settingsCache";
import { primeCoverLibraryRoot } from "../library/coverSrc";
import { normalizeBgVeil, normalizeReaderBackground } from "../reader/settings/normalize";
import { countByShelf, descendantIds, shelfPath, shelfTreeRows, type ShelfTreeRow } from "../library/shelves";
import type { ReadingStatus } from "../library/readingStatus";
import { BOOKS_CHANGED_EVENT, runImports, subscribeImportProgress, type ImportProgress } from "../library/importRunner";
import { primeCloseAction } from "./closeAction";
import { startSilentUpdateCheck, subscribeUpdateAvailable, getUpdateAvailable } from "./updater";
import { showAlert, showConfirm, showPrompt } from "./dialog";
import { ToastHost } from "./toast";
import SettingsDialog from "./SettingsDialog";
import type { SettingsSectionId } from "../settings/sections";

// 色块 30px + 块间 8 间距 + 12 内边距 + 2 边框（H-8 加 auto 格后 9 格，宽度随格数算）
const THEME_MENU_WIDTH = THEME_SWATCHES.length * 30 + (THEME_SWATCHES.length - 1) * 8 + 12 * 2 + 2;

/** 壳纱浓度：本项目 settings 以空串表示"无值"（如 library_status），空串不能当 0 钳到 60 */
export function parseBgVeil(raw: string | undefined): number {
  return raw === "" ? 88 : normalizeBgVeil(raw);
}

// 侧栏书架树数据模块级单例（批次12b）：批次8 起壳由 AppLayout 常驻（切页不重挂），数据仍居模块层——
// 进阅读页壳卸载、返回重挂时首帧即有旧值；LibraryPage.refresh 推写，导入事件兜底
// v2.7.0 K-4：同一次加载顺带拉 books 算每架递归计数（countByShelf 上卷到祖先），books 失败不拖垮树
let shelvesCache: Shelf[] = [];
let shelfCountsCache: Map<number, number> = new Map();
let shelvesLoaded = false;
let shelvesInflight: Promise<void> | null = null;
const shelvesListeners = new Set<() => void>();
let shelvesEventBound = false;

export function setShelvesCache(list: Shelf[]): void {
  shelvesCache = list;
  shelvesLoaded = true;
  for (const l of shelvesListeners) l();
}

/** M-3 侧键逻辑回溯要用 shelves 树（事件时刻取值，非渲染期） */
export function getShelvesCache(): Shelf[] {
  return shelvesCache;
}

// ---- S-1 侧栏书架树折叠：模块级缓存（会话内跨页立即生效）+ settings 键 shelf_collapsed（JSON 数字数组）跨会话 ----
let shelfCollapsedCache = new Set<number>();
let shelfCollapsedLoaded = false;
let shelfCollapsedTouched = false; // settings 恢复晚到时不覆盖用户刚点的折叠
let shelfCollapsedPersistTimer = 0;

function persistShelfCollapsed(ids: Set<number>): void {
  window.clearTimeout(shelfCollapsedPersistTimer);
  shelfCollapsedPersistTimer = window.setTimeout(() => {
    void setSetting("shelf_collapsed", JSON.stringify([...ids])).catch(() => {});
  }, 500);
}

/** 纯：祖先链上任一书架折叠则隐藏该行（顺序无关，环由深度守卫兜底——与 shelfPath 同口径） */
export function filterCollapsedRows(rows: ShelfTreeRow[], collapsed: Set<number>): ShelfTreeRow[] {
  if (collapsed.size === 0) return rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows.filter((r) => {
    let cur = r.parent_id ?? null;
    let guard = 0;
    while (cur != null && guard++ < 100) {
      if (collapsed.has(cur)) return false;
      cur = byId.get(cur)?.parent_id ?? null;
    }
    return true;
  });
}

/** 纯：books 按直接归属计数后上卷到祖先书架（父架计数含全部后代的书） */
export function rollupShelfCounts(shelves: Shelf[], books: Book[]): Map<number, number> {
  const direct = countByShelf(books);
  const out = new Map<number, number>();
  for (const s of shelves) {
    let n = direct.get(s.id) ?? 0;
    for (const d of descendantIds(shelves, s.id)) n += direct.get(d) ?? 0;
    out.set(s.id, n);
  }
  return out;
}

function loadShelves(): Promise<void> {
  shelvesInflight ??= Promise.all([listShelves(), listBooks().catch((): Book[] => [])])
    .then(([shelves, books]) => {
      setShelvesCache(shelves);
      shelfCountsCache = rollupShelfCounts(shelves, books);
      for (const l of shelvesListeners) l();
    })
    .catch(() => {
      // DB 不可达：侧栏不渲染书架树
    })
    .finally(() => {
      shelvesInflight = null;
    });
  return shelvesInflight;
}

function subscribeShelves(fn: () => void): () => void {
  shelvesListeners.add(fn);
  if (!shelvesEventBound && typeof window !== "undefined") {
    shelvesEventBound = true;
    window.addEventListener(BOOKS_CHANGED_EVENT, () => void loadShelves());
  }
  return () => {
    shelvesListeners.delete(fn);
  };
}

export function useShellShelves(): Shelf[] {
  useEffect(() => {
    if (!shelvesLoaded) void loadShelves();
  }, []);
  return useSyncExternalStore(subscribeShelves, () => shelvesCache, () => shelvesCache);
}

/** K-4 侧栏每架递归计数（与书架树同一数据源同一订阅；LibraryPage 推写 setShelvesCache 不带 books，靠 books-changed 事件纠偏） */
export function useShelfCounts(): Map<number, number> {
  useShellShelves();
  return useSyncExternalStore(subscribeShelves, () => shelfCountsCache, () => shelfCountsCache);
}

// H-9 升级亮点：硬编码当前版要点（不读 md）；比较纯函数 + 一次性展示
export const HIGHLIGHT_LINES = [
  "设置改为居中浮窗：左侧分类、右侧配置，八个分区即改即存",
  "新增 EPUB / 漫画 / PDF 的默认阅读设置，云书架默认书架与排序",
  "书库体检：失链与重复导入可勾选批量处理，只确认一次；重复项显示所在位置",
  "修复：同一本书退出后再打开，章内插图与内嵌字体丢失",
  "修复：窗口右缘多出的一道底色；圆角弹窗的滚动条不再压进圆角",
];

/** 纯：上次见过版本存在且 ≠ 当前 → 展示亮点（首启 last_seen 不存在只落库不弹窗） */
export function shouldShowHighlights(lastSeen: unknown, current: string): boolean {
  const s = String(lastSeen ?? "").trim();
  return s !== "" && current !== "" && s !== current;
}

// H-9 + U-3 启动一次性（模块哨兵保证全会话只跑一次）
let shellStartupDone = false;
async function runShellStartupOnce(): Promise<void> {
  if (shellStartupDone) return;
  shellStartupDone = true;
  startSilentUpdateCheck();
  try {
    const [map, version] = await Promise.all([getSettings(), getVersion()]);
    if (shouldShowHighlights(map.last_seen_version, version)) {
      await showAlert(`已更新到 v${version}`, `本版要点：\n${HIGHLIGHT_LINES.map((l) => `· ${l}`).join("\n")}`);
    }
    if (map.last_seen_version !== version) void setSetting("last_seen_version", version);
  } catch {
    // DB 不可达：下次启动再试
  }
}

export default function AppShell(props: {
  active: "library" | "favorites" | "cloud" | "reader";
  title: string;
  search?: {
    value: string;
    placeholder: string;
    onChange: (v: string) => void;
    onSubmit?: () => void;
  };
  seg?: {
    items: { key: string; label: string }[];
    active: string;
    onChange: (key: string) => void;
  };
  /** 侧栏顶部快捷筛选（全部藏书/在读/未读）：与工具行状态过滤菜单同一 state 源，双向同步 */
  quickFilter?: {
    value: "all" | ReadingStatus;
    onChange: (v: "all" | ReadingStatus) => void;
  };
  /** v3.0 D3：非书库视图的上下文信息行（quickFilter 缺席时渲染于同一常驻行容器） */
  contextRow?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const themeSelection = useThemeSelection();
  // 首帧命中背景单槽缓存：路由切换重挂不再闪回无背景（DB 纠偏仍走下方 load）
  const [bgUrl, setBgUrl] = useState<string | null>(getCachedBackgroundUrl);
  // 壳纱浓度（bg_veil）：默认 88%，与主题/背景同一次 settings 读取顺带解析
  const [veil, setVeil] = useState(88);
  const [themeMenu, setThemeMenu] = useState<{ x: number; y: number } | null>(null);
  // E-1（U-14 分区）：侧栏书架树右键菜单——新建子书架/重命名/删除，动作与书库页同源
  const [shelfMenu, setShelfMenu] = useState<{ x: number; y: number; shelf: Shelf } | null>(null);
  const shelves = useShellShelves();
  const shelfCounts = useShelfCounts();
  // S-1 树折叠：state 驱动重渲，模块缓存保证路由切换（重挂）不丢
  const [collapsed, setCollapsed] = useState(() => new Set(shelfCollapsedCache));
  const updateAvailable = useSyncExternalStore(subscribeUpdateAvailable, getUpdateAvailable, () => null);
  // v3.2（V-3）：设置是浮在当前页上的居中浮窗（不切页，书架状态原样保留）。带着"发现新版本"红点进来时
  // 直达「网络与更新」——那一分区挂载时发现红点亮着会直接弹更新窗（沿原口径：关掉弹窗仍留在设置里）
  const [settings, setSettings] = useState<{ section: SettingsSectionId } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress>(null);
  // V-4 窄窗：档位（JS 驱动树过滤/抽屉/搜索收起；宽度与视觉由 CSS 断点接管）+ 抽屉开关 + 紧凑搜索展开态
  const tier = useViewportTier();
  const compactSearch = useCompactSearch();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState(false);
  // U-18 搜索清理叉：清空后回焦输入框（mousedown preventDefault 保住鼠标路径的焦点）
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchToggleRef = useRef<HTMLButtonElement | null>(null);
  const [searchParams] = useSearchParams();
  const activeShelf = props.active === "library" ? searchParams.get("shelf") : null;
  const trashActive = props.active === "library" && searchParams.get("trash") === "1";
  // 批次18：拖拽导入落到书库页当前书架（与 LibraryPage.currentShelfId 同口径；回收站/其它页=根）
  const dropShelfParam = props.active === "library" && !trashActive ? searchParams.get("shelf") : null;
  const dropShelfParsed = dropShelfParam ? Number(dropShelfParam) : null;
  const dropShelfId =
    dropShelfParsed != null && Number.isFinite(dropShelfParsed) ? dropShelfParsed : null;

  // 启动纠偏：DB 主题覆盖 localStorage 缓存；同一份 settings 顺带解析全局背景；书架换背景后广播重读，即时换肤
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const map = await getSettings();
        if (cancelled) return;
        // U-3 密度闪帧：settings 到达即预热模块缓存——LibraryPage 等首帧初始化同步读，不再回退默认档
        primeSettingsCache(map);
        // U-19 持久封面通道：库根（settings.library_root 自定义根，缺省 appdata）随同一次读取预热
        primeCoverLibraryRoot(map.library_root || (await getAppDataBase()));
        applyPersistedTheme(map.theme);
        primeCloseAction(map.close_action); // C-1：✕ 行为记忆与主题共用这一次 settings 读
        setVeil(parseBgVeil(map.bg_veil));
        setBgUrl(await getBackgroundUrl(normalizeReaderBackground(map.reader_bg)));
      } catch {
        // DB 不可达：维持缓存主题与默认底色
      }
    };
    void load();
    const off = subscribeBackground(() => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // v2.7.0 启动一次性：静默更新检查（U-3）+ 升级亮点（H-9）
  useEffect(() => {
    void runShellStartupOnce();
  }, []);

  // S-1 折叠态跨会话恢复（全会话一次；用户已手点则不覆盖）
  useEffect(() => {
    if (shelfCollapsedLoaded) return;
    shelfCollapsedLoaded = true;
    getSettings()
      .then((m) => {
        if (shelfCollapsedTouched) return;
        try {
          const ids = JSON.parse(m.shelf_collapsed ?? "[]") as unknown;
          if (Array.isArray(ids)) {
            shelfCollapsedCache = new Set(ids.filter((n): n is number => typeof n === "number"));
            setCollapsed(new Set(shelfCollapsedCache));
          }
        } catch {
          // 非法存量：当未设置处理
        }
      })
      .catch(() => {});
  }, []);

  // 批量/拖拽导入进度条（importRunner 模块单例广播）
  useEffect(() => subscribeImportProgress(setImportProgress), []);

  // OS 文件拖入：Tauri 2 默认接管 webview 拖放（HTML5 drop 不触发，浏览器"打开文件"默认行为被拦），
  // 拿到的是绝对路径——文件走统一导入流，目录按"一本漫画文件夹"
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop") {
        setDragOver(false);
        if (e.payload.paths.length > 0) void runImports(e.payload.paths, { targetShelfId: dropShelfId });
      } else {
        setDragOver(e.payload.type !== "leave");
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [dropShelfId]);

  // E 线全局纯化（右键/拖影/残留快捷键）：壳与阅读页各装一次，幂等（全会话一条）
  useEffect(() => installDesktopChrome(), []);

  // V-4：<900 Ctrl+F 展开图标版搜索并聚焦；≥900 直接聚焦常驻输入框（阅读器书内搜索路由隔离不受影响）
  useEffect(() => {
    if (!props.search) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (compactSearch) {
          setSearchExpanded(true);
          window.setTimeout(() => searchInputRef.current?.focus(), 0);
        } else {
          searchInputRef.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.search, compactSearch]);

  // 回到宽屏：展开态归位（常驻输入框一直在 DOM）
  useEffect(() => {
    if (!compactSearch) setSearchExpanded(false);
  }, [compactSearch]);

  // V-4 抽屉：Esc 关闭
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  function onMenuNewShelf(parent: Shelf) {
    setShelfMenu(null);
    void showPrompt(`在“${parent.name}”内新建书架`, "").then((name) => {
      if (!name?.trim()) return;
      createShelf(name.trim(), parent.id)
        .then(() => loadShelves())
        .catch((e) => void showAlert("新建书架失败", String(e)));
    });
  }

  function onMenuRenameShelf(shelf: Shelf) {
    setShelfMenu(null);
    void showPrompt("书架名称", shelf.name).then((name) => {
      if (name == null || !name.trim() || name === shelf.name) return;
      renameShelf(shelf.id, name.trim())
        .then(() => loadShelves())
        .catch((e) => void showAlert("重命名失败", String(e)));
    });
  }

  async function onMenuDeleteShelf(shelf: Shelf) {
    setShelfMenu(null);
    const ok = await showConfirm(
      "删除书架",
      `删除书架“${shelf.name}”？其中的书移到上级书架，子书架一并删除。`,
      { danger: true, confirmText: "删除" },
    );
    if (!ok) return;
    try {
      await deleteShelf(shelf.id);
      // 删的是书库当前视图（或其视图已在别处失效）→ 回根，与 LibraryPage.onDeleteShelf 同口径
      if (activeShelf === String(shelf.id)) navigate("/");
      await loadShelves();
    } catch (e) {
      await showAlert("删除书架失败", String(e));
    }
  }

  function openThemeMenu(btn: HTMLElement | null) {
    const r = btn?.getBoundingClientRect();
    setThemeMenu(
      r
        ? { x: Math.max(8, r.right - THEME_MENU_WIDTH), y: r.bottom + 6 }
        : { x: 8, y: 8 },
    );
  }

  // ---- S-1/S-2 树折叠 ----
  // 有子书架的节点（= 某书的 parent_id 出现过）才给折叠箭头
  const parentIds = new Set<number>();
  for (const s of shelves) if (s.parent_id != null) parentIds.add(s.parent_id);
  const anyCollapsed = [...collapsed].some((id) => parentIds.has(id));

  function applyCollapsed(next: Set<number>) {
    shelfCollapsedTouched = true;
    shelfCollapsedCache = next;
    setCollapsed(new Set(next));
    persistShelfCollapsed(next);
  }

  // 全局背景：cover 居中铺满 + 半透明主题色纱保证八主题下内容对比度（底色 var(--wr-bg) 仍兜底）；
  // §8 静态铺法（cover/center）迁入 .wr-shell--userbg，动态 url 留内联；纱浓度读 bg_veil（F1-6）
  const shellStyle: CSSProperties | undefined = bgUrl
    ? {
        backgroundImage: `linear-gradient(color-mix(in srgb, var(--wr-bg) ${veil}%, transparent), color-mix(in srgb, var(--wr-bg) ${veil}%, transparent)), url("${bgUrl}")`,
      }
    : undefined;

  // V-4 图标栏（600–799）：书架树只留根级 + 当前激活链（根→当前书架路径），其余折叠
  const railMode = tier === "rail";
  const activeShelfNum = activeShelf != null && Number.isFinite(Number(activeShelf)) ? Number(activeShelf) : null;
  const activeChain = new Set<number>(shelfPath(shelves, activeShelfNum).map((s) => s.id));
  const navRows = filterCollapsedRows(shelfTreeRows(shelves), collapsed).filter(
    (r) => !railMode || r.depth === 0 || activeChain.has(r.id),
  );
  // 抽屉档点任何导航即收抽屉
  const nav = (to: string) => {
    setDrawerOpen(false);
    navigate(to);
  };

  return (
    <TooltipProvider>
    <div className={`wr-shell${bgUrl ? " wr-shell--userbg" : ""}`} style={shellStyle}>
      <TitleBar title={props.title} />
      <div className="wr-shell-body">
      <div className="wr-panel wr-side" data-open={drawerOpen || undefined}>
        <div className="wr-side-top">
          <div className="wr-brand">
            <div className="wr-brand-name">BookReading</div>
            <div className="wr-brand-sub">weread-inspired</div>
          </div>
          <div className="wr-pill" title="状态">
            <span className="wr-live-dot" aria-hidden="true" />
            <span style={{ fontSize: 12 }}>本地库</span>
          </div>
        </div>

        {/* M-2 + D3：行常驻——书库视图渲染快捷筛选 chips；其它视图渲染各自 contextRow（收藏/云书架/回收站）；
            两者皆无才隐藏占位，保高度消灭切页布局跳动 */}
        <div
          className="wr-quick-row"
          role="group"
          aria-label={props.quickFilter ? "快捷筛选" : undefined}
          style={props.quickFilter || props.contextRow ? undefined : { visibility: "hidden" }}
        >
          {props.quickFilter ? (
            <>
              <button
                type="button"
                className="wr-quick-chip"
                data-active={props.quickFilter.value === "all"}
                aria-pressed={props.quickFilter.value === "all"}
                onClick={() => props.quickFilter?.onChange("all")}
              >
                全部藏书
              </button>
              <button
                type="button"
                className="wr-quick-chip"
                data-active={props.quickFilter.value === "reading"}
                aria-pressed={props.quickFilter.value === "reading"}
                onClick={() => props.quickFilter?.onChange("reading")}
              >
                在读
              </button>
              <button
                type="button"
                className="wr-quick-chip"
                data-active={props.quickFilter.value === "unread"}
                aria-pressed={props.quickFilter.value === "unread"}
                onClick={() => props.quickFilter?.onChange("unread")}
              >
                未读
              </button>
            </>
          ) : (
            props.contextRow
          )}
        </div>

        <div className="wr-nav" role="navigation">
          <Tooltip content={railMode ? "书架" : null}>
            <button
              className="wr-nav-btn"
              data-drop="shelf"
              data-shelf-id=""
              data-active={props.active === "library" && !trashActive}
              aria-current={props.active === "library" && !trashActive ? "page" : undefined}
              onClick={() => nav("/")}
            >
              <div className="wr-nav-title">
                <IconBook />
                <span className="wr-nav-label">书架</span>
              </div>
              <div className="wr-nav-sub">层级书架、导入与管理</div>
            </button>
          </Tooltip>
          {shelves.length > 0 ? (
            <>
              {/* S-2 全部收起/展开：有折叠 → 全部展开；否则全部收起（收起=折叠全部有子架的节点） */}
              <div className="wr-nav-tree-tools">
                <button
                  type="button"
                  className="wr-nav-tree-tool"
                  onClick={() => applyCollapsed(anyCollapsed ? new Set() : new Set(parentIds))}
                >
                  {anyCollapsed ? "全部展开" : "全部收起"}
                </button>
              </div>
              <div className="wr-nav-groups" role="group" aria-label="书架">
                {navRows.map((row) => (
                  <button
                    key={row.id}
                    className="wr-nav-group-btn"
                    data-drop="shelf"
                    data-shelf-id={row.id}
                    title={row.name}
                    aria-current={activeShelf === String(row.id) ? "page" : undefined}
                    style={{ paddingLeft: 10 + row.depth * 12 }}
                    onClick={() => nav(`/?shelf=${row.id}`)}
                    onContextMenu={(e) => {
                      // E-1：侧栏书架树右键 = 新建/重命名/删除（贴光标）
                      e.preventDefault();
                      const shelf = shelves.find((s) => s.id === row.id);
                      if (shelf) setShelfMenu({ x: e.clientX, y: e.clientY, shelf });
                    }}
                  >
                    {row.name}
                    {shelfCounts.get(row.id) ? <span className="wr-nav-count">{shelfCounts.get(row.id)}</span> : null}
                    {parentIds.has(row.id) ? (
                      // span 而非 button：行本身是 button，嵌套交互元素非法；stopPropagation 防触发进入书架
                      // shortcut: 折叠箭头仅鼠标可达，键盘折叠需求出现时再升级为独立 focusable 控件
                      <span
                        className="wr-nav-toggle"
                        aria-hidden="true"
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = new Set(collapsed);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          applyCollapsed(next);
                        }}
                      >
                        {collapsed.has(row.id) ? "▸" : "▾"}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <Tooltip content={railMode ? "收藏" : null}>
            <button className="wr-nav-btn" data-active={props.active === "favorites"} aria-current={props.active === "favorites" ? "page" : undefined} onClick={() => nav("/favorites")}>
              <div className="wr-nav-title">
                <IconStar />
                <span className="wr-nav-label">收藏</span>
              </div>
              <div className="wr-nav-sub">书籍与收藏句子</div>
            </button>
          </Tooltip>
          <Tooltip content={railMode ? "云书架" : null}>
            <button className="wr-nav-btn" data-active={props.active === "cloud"} aria-current={props.active === "cloud" ? "page" : undefined} onClick={() => nav("/cloud-shelf")}>
              <div className="wr-nav-title">
                <IconCloud />
                <span className="wr-nav-label">云书架</span>
              </div>
              <div className="wr-nav-sub">wenku8 在线书架，可拉取入库</div>
            </button>
          </Tooltip>
          <Tooltip content={railMode ? "回收站" : null}>
            <button
              className="wr-nav-btn"
              data-drop="trash"
              data-active={trashActive}
              aria-current={trashActive ? "page" : undefined}
              onClick={() => nav("/?trash=1")}
            >
              <div className="wr-nav-title">
                <IconTrash />
                <span className="wr-nav-label">回收站</span>
              </div>
              <div className="wr-nav-sub">已删除书籍、保留期内可恢复</div>
            </button>
          </Tooltip>
        </div>

        {/* P-1 底部动作区：写死的固定四钮（刷新/导入漫画/导入图书/设置），任何视图都不重挂载、不变色；
            刷新走 appActions 事件由当前视图自消化，导入走 importService（落架=当前书架）。
            V-4：<800 转 2×2 图标宫格（文字走 Tooltip） */}
        <div className="wr-side-bottom">
          <Tooltip content={railMode ? "刷新当前视图" : null}>
            <button type="button" className="wr-small-btn" aria-label="刷新当前视图" onClick={emitAppRefresh}>
              <IconRefresh />
              <span>刷新</span>
            </button>
          </Tooltip>
          <Tooltip content={railMode ? "导入漫画" : null}>
            <button type="button" className="wr-small-btn wr-primary" aria-label="选择漫画文件夹导入" onClick={() => void importImages()}>
              <IconImage />
              <span>导入漫画</span>
            </button>
          </Tooltip>
          <Tooltip content={railMode ? "导入图书" : null}>
            <button type="button" className="wr-small-btn wr-primary" aria-label="选择 EPUB / TXT / CBZ / PDF 导入" onClick={() => void importBooks()}>
              <IconBook />
              <span>导入图书</span>
            </button>
          </Tooltip>
          {/* v3.2（V-3）：设置改为浮在当前页上的居中浮窗，见上方 settings 状态 */}
          <Tooltip content={railMode ? (updateAvailable ? `设置（发现新版本 v${updateAvailable.latest}）` : "设置") : null}>
            <button
              className="wr-small-btn"
              data-badge={updateAvailable ? "true" : undefined}
              aria-haspopup="dialog"
              aria-expanded={settings != null}
              aria-label={updateAvailable ? `发现新版本 v${updateAvailable.latest}，在设置中查看` : "设置"}
              onClick={() => setSettings({ section: updateAvailable ? "network" : "appearance" })}
            >
              <IconSettings />
              <span>设置</span>
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="wr-panel wr-main">
        <div className="wr-main-topbar">
          {/* V-4 <600：汉堡钮唤出侧栏抽屉（CSS 断点控制可见性） */}
          {tier === "drawer" ? (
            <button
              type="button"
              className="wr-btn wr-icon-btn wr-nav-drawer-btn"
              aria-label="打开侧栏"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <IconMenu />
            </button>
          ) : null}

          {props.search ? (
            compactSearch && !searchExpanded ? (
              /* V-4 <900：搜索收为图标钮，点击展开浮层输入框（Ctrl+F 同效） */
              <button
                ref={searchToggleRef}
                type="button"
                className="wr-btn wr-icon-btn"
                aria-label="搜索"
                onClick={() => setSearchExpanded(true)}
              >
                <IconSearch />
              </button>
            ) : (
              <div
                className={`wr-search${props.search.value ? " wr-search--clearable" : ""}${compactSearch ? " wr-search--float" : ""}`}
                onBlur={(e) => {
                  if (compactSearch && !e.currentTarget.contains(e.relatedTarget)) setSearchExpanded(false);
                }}
              >
                <span className="wr-search-icon" aria-hidden>
                  <IconSearch />
                </span>
                <input
                  ref={searchInputRef}
                  className="wr-search-input"
                  autoFocus={compactSearch}
                  value={props.search.value}
                  onChange={(e) => props.search?.onChange(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") props.search?.onSubmit?.();
                    if (e.key === "Escape" && compactSearch) {
                      setSearchExpanded(false);
                      searchToggleRef.current?.focus();
                    }
                  }}
                  placeholder={props.search.placeholder}
                  aria-label={props.search.placeholder}
                />
                {props.search.value ? (
                  <button
                    type="button"
                    className="wr-search-clear"
                    aria-label="清空搜索"
                    title="清空搜索"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      props.search?.onChange("");
                      searchInputRef.current?.focus();
                    }}
                  >
                    <IconClose />
                  </button>
                ) : null}
              </div>
            )
          ) : (
            <h1 style={{ fontWeight: 750, margin: 0, fontSize: "inherit" }}>{props.title}</h1>
          )}

          {props.seg ? (
            <div className="wr-seg" aria-label="视图切换">
              {props.seg.items.map((it) => (
                <button
                  key={it.key}
                  className="wr-seg-btn"
                  data-active={props.seg?.active === it.key}
                  aria-pressed={props.seg?.active === it.key}
                  onClick={() => props.seg?.onChange(it.key)}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ) : null}

          <button
            className="wr-btn wr-icon-btn"
            aria-label="切换主题"
            aria-expanded={!!themeMenu}
            title="切换主题"
            style={{ marginLeft: props.search ? undefined : "auto" }}
            onClick={(e) => openThemeMenu(e.currentTarget)}
          >
            <IconPalette />
          </button>
        </div>
        <div className="wr-main-scroll" style={{ minHeight: 0, overflow: "auto" }}>
          {props.children}
        </div>
      </div>
      </div>

      {themeMenu ? (
        <PointMenu
          point={themeMenu}
          onClose={() => setThemeMenu(null)}
          label="主题"
          contentStyle={{ display: "grid", gridTemplateColumns: `repeat(${THEME_SWATCHES.length}, 30px)`, gap: 8 }}
        >
          {THEME_SWATCHES.map((s) => (
            <Menu.Item asChild key={s.value}>
              <button
                type="button"
                className="wr-swatch-btn"
                data-selected={themeSelection === s.value}
                aria-label={s.label}
                aria-pressed={themeSelection === s.value}
                onClick={() => setTheme(s.value)}
                style={{ background: s.color }}
              />
            </Menu.Item>
          ))}
        </PointMenu>
      ) : null}

      {shelfMenu ? (
        <PointMenu point={shelfMenu} onClose={() => setShelfMenu(null)} label={`书架 ${shelfMenu.shelf.name}`}>
          <Menu.Item asChild>
            <button type="button" className="wr-menu-item" onClick={() => onMenuNewShelf(shelfMenu.shelf)}>
              新建子书架
            </button>
          </Menu.Item>
          <Menu.Item asChild>
            <button type="button" className="wr-menu-item" onClick={() => onMenuRenameShelf(shelfMenu.shelf)}>
              重命名书架
            </button>
          </Menu.Item>
          <Menu.Item asChild>
            <button
              type="button"
              className="wr-menu-item"
              data-danger="true"
              onClick={() => void onMenuDeleteShelf(shelfMenu.shelf)}
            >
              删除书架
            </button>
          </Menu.Item>
        </PointMenu>
      ) : null}

      {/* V-4 抽屉遮罩（<600 档） */}
      {tier === "drawer" && drawerOpen ? (
        <div className="wr-side-drawer-scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />
      ) : null}

      {dragOver ? (
        <div className="wr-drop-overlay" role="status">
          <div className="wr-drop-hint">松开导入 · EPUB / TXT / CBZ / 漫画文件夹</div>
        </div>
      ) : null}

      {importProgress ? (
        <div className="wr-import-bar" role="status" aria-live="polite">
          <div
            className="wr-import-bar-fill"
            style={{ width: `${(importProgress.done / importProgress.total) * 100}%` }}
          />
          <span className="wr-import-bar-text">
            导入 {importProgress.done}/{importProgress.total} · {importProgress.current}（大部头含插图优化可能需数分钟）
          </span>
        </div>
      ) : null}

      {settings ? (
        <SettingsDialog initialSection={settings.section} onClose={() => setSettings(null)} />
      ) : null}

      <ToastHost />
    </div>
    </TooltipProvider>
  );
}
