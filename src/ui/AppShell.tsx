import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { IconBook, IconPalette, IconSearch, IconSettings, IconStar, IconTrash } from "./icons";
import { getCachedBackgroundUrl, getBackgroundUrl, subscribeBackground } from "./appBackground";
import { applyPersistedTheme, setTheme, THEME_SWATCHES, useTheme } from "./theme";
import { getSettings, listShelves, type Shelf } from "../tauri/invoke";
import { normalizeReaderBackground } from "../reader/settings/normalize";
import { shelfTreeRows } from "../library/shelves";
import { BOOKS_CHANGED_EVENT, runImports, subscribeImportProgress, type ImportProgress } from "../library/importRunner";
import SettingsDialog from "./SettingsDialog";

// 六个 30px 色块 + 5*8 间距 + 12 内边距 + 2 边框
const THEME_MENU_WIDTH = 234;

// 侧栏书架树模块级单例（批次12b）：每页各渲染一个 AppShell，路由切换整树重挂曾是闪烁根因；
// 数据上提后重挂首帧即有旧值，LibraryPage.refresh 推写，导入事件兜底（LibraryPage 卸载时也能刷新）
let shelvesCache: Shelf[] = [];
let shelvesLoaded = false;
let shelvesInflight: Promise<void> | null = null;
const shelvesListeners = new Set<() => void>();
let shelvesEventBound = false;

export function setShelvesCache(list: Shelf[]): void {
  shelvesCache = list;
  shelvesLoaded = true;
  for (const l of shelvesListeners) l();
}

function loadShelves(): Promise<void> {
  shelvesInflight ??= listShelves()
    .then(setShelvesCache)
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

export default function AppShell(props: {
  active: "library" | "favorites" | "reader";
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
  sidebarFooter?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const theme = useTheme();
  // 首帧命中背景单槽缓存：路由切换重挂不再闪回无背景（DB 纠偏仍走下方 load）
  const [bgUrl, setBgUrl] = useState<string | null>(getCachedBackgroundUrl);
  const [themeMenu, setThemeMenu] = useState<{ x: number; y: number } | null>(null);
  const shelves = useShellShelves();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress>(null);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);
  const [searchParams] = useSearchParams();
  const activeShelf = props.active === "library" ? searchParams.get("shelf") : null;
  const trashActive = props.active === "library" && searchParams.get("trash") === "1";

  // 启动纠偏：DB 主题覆盖 localStorage 缓存；同一份 settings 顺带解析全局背景；书架换背景后广播重读，即时换肤
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const map = await getSettings();
        if (cancelled) return;
        applyPersistedTheme(map.theme);
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

  // 批量/拖拽导入进度条（importRunner 模块单例广播）
  useEffect(() => subscribeImportProgress(setImportProgress), []);

  // OS 文件拖入：Tauri 2 默认接管 webview 拖放（HTML5 drop 不触发，浏览器"打开文件"默认行为被拦），
  // 拿到的是绝对路径——文件走统一导入流，目录按"一本漫画文件夹"
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop") {
        setDragOver(false);
        if (e.payload.paths.length > 0) void runImports(e.payload.paths);
      } else {
        setDragOver(e.payload.type !== "leave");
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // close the theme menu on outside pointerdown / Escape
  useEffect(() => {
    if (!themeMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (themeBtnRef.current?.contains(e.target as Node)) return;
      if (themeMenuRef.current?.contains(e.target as Node)) return;
      setThemeMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setThemeMenu(null);
        themeBtnRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [themeMenu]);

  useLayoutEffect(() => {
    if (themeMenu) themeMenuRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [themeMenu]);

  function openThemeMenu() {
    const r = themeBtnRef.current?.getBoundingClientRect();
    setThemeMenu(
      r
        ? { x: Math.max(8, r.right - THEME_MENU_WIDTH), y: r.bottom + 6 }
        : { x: 8, y: 8 },
    );
  }

  // 全局背景：cover 居中铺满 + 半透明主题色纱保证六主题下内容对比度（底色 var(--wr-bg) 仍兜底）
  const shellStyle: CSSProperties | undefined = bgUrl
    ? {
        backgroundImage: `linear-gradient(color-mix(in srgb, var(--wr-bg) 88%, transparent), color-mix(in srgb, var(--wr-bg) 88%, transparent)), url("${bgUrl}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }
    : undefined;

  return (
    <div className="wr-shell" style={shellStyle}>
      <div className="wr-panel wr-side">
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

        <div className="wr-nav" role="navigation">
          <button className="wr-nav-btn" data-active={props.active === "library" && !trashActive} aria-current={props.active === "library" && !trashActive ? "page" : undefined} onClick={() => navigate("/")}>
            <div className="wr-nav-title">
              <IconBook />
              书架
            </div>
            <div className="wr-nav-sub">层级书架、导入与管理</div>
          </button>
          {shelves.length > 0 ? (
            <div className="wr-nav-groups" role="group" aria-label="书架">
              {shelfTreeRows(shelves).map((row) => (
                <button
                  key={row.id}
                  className="wr-nav-group-btn"
                  title={row.name}
                  aria-current={activeShelf === String(row.id) ? "page" : undefined}
                  style={{ paddingLeft: 10 + row.depth * 12 }}
                  onClick={() => navigate(`/?shelf=${row.id}`)}
                >
                  {row.name}
                </button>
              ))}
            </div>
          ) : null}
          <button className="wr-nav-btn" data-active={props.active === "favorites"} aria-current={props.active === "favorites" ? "page" : undefined} onClick={() => navigate("/favorites")}>
            <div className="wr-nav-title">
              <IconStar />
              收藏
            </div>
            <div className="wr-nav-sub">书籍与收藏句子</div>
          </button>
          <button className="wr-nav-btn" data-active={trashActive} aria-current={trashActive ? "page" : undefined} onClick={() => navigate("/?trash=1")}>
            <div className="wr-nav-title">
              <IconTrash />
              回收站
            </div>
            <div className="wr-nav-sub">已删除书籍、保留期内可恢复</div>
          </button>
        </div>

        <div className="wr-side-bottom">
          {props.sidebarFooter}
          <button className="wr-small-btn" onClick={() => setSettingsOpen(true)}>
            <IconSettings />
            <span>设置</span>
          </button>
        </div>
      </div>

      <div className="wr-panel wr-main">
        <div className="wr-main-topbar">
          {props.search ? (
            <div className="wr-search">
              <span className="wr-search-icon" aria-hidden>
                <IconSearch />
              </span>
              <input
                className="wr-search-input"
                value={props.search.value}
                onChange={(e) => props.search?.onChange(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") props.search?.onSubmit?.();
                }}
                placeholder={props.search.placeholder}
                aria-label={props.search.placeholder}
              />
            </div>
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
            ref={themeBtnRef}
            className="wr-btn wr-icon-btn"
            aria-label="切换主题"
            aria-expanded={!!themeMenu}
            title="切换主题"
            style={{ marginLeft: props.search ? undefined : "auto" }}
            onClick={openThemeMenu}
          >
            <IconPalette />
          </button>
        </div>
        <div style={{ minHeight: 0, overflow: "auto" }}>{props.children}</div>
      </div>

      {themeMenu ? (
        <div
          ref={themeMenuRef}
          className="wr-menu"
          role="group"
          aria-label="主题"
          style={{ left: themeMenu.x, top: themeMenu.y, display: "grid", gridTemplateColumns: "repeat(6, 30px)", gap: 8 }}
        >
          {THEME_SWATCHES.map((s) => (
            <button
              key={s.value}
              type="button"
              className="wr-swatch-btn"
              data-selected={theme === s.value}
              aria-label={s.label}
              aria-pressed={theme === s.value}
              title={s.label}
              onClick={() => {
                setTheme(s.value);
                setThemeMenu(null);
              }}
              style={{ background: s.color }}
            />
          ))}
        </div>
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
            导入 {importProgress.done}/{importProgress.total} · {importProgress.current}
          </span>
        </div>
      ) : null}

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
