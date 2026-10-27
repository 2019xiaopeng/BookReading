import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { IconBook, IconPalette, IconSearch, IconStar } from "./icons";
import { getBackgroundUrl, subscribeBackground } from "./appBackground";
import { applyPersistedTheme, setTheme, THEME_SWATCHES, useTheme } from "./theme";
import { getSettings, listBooks } from "../tauri/invoke";
import { normalizeReaderBackground } from "../reader/settings/normalize";

// 六个 30px 色块 + 5*8 间距 + 12 内边距 + 2 边框
const THEME_MENU_WIDTH = 234;

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
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [themeMenu, setThemeMenu] = useState<{ x: number; y: number } | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);
  const [searchParams] = useSearchParams();
  const activeGroup = props.active === "library" ? searchParams.get("group") : null;

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

  // 侧栏分组：与书库 chips 同源（books.group_name）；挂载+窗口聚焦刷新，会话新建的空组不入侧栏
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await listBooks();
        if (cancelled) return;
        setGroups(
          [...new Set(list.map((b) => b.group_name).filter((g): g is string => !!g))].sort((a, b) =>
            a.localeCompare(b, "zh"),
          ),
        );
      } catch {
        // DB 不可达：侧栏不渲染分组
      }
    };
    void load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
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
            <span style={{ fontSize: 12 }}>本地库</span>
          </div>
        </div>

        <div className="wr-nav" role="navigation">
          <button className="wr-nav-btn" data-active={props.active === "library"} aria-current={props.active === "library" ? "page" : undefined} onClick={() => navigate("/")}>
            <div className="wr-nav-title">
              <IconBook />
              书架
            </div>
            <div className="wr-nav-sub">最近阅读、导入与管理</div>
          </button>
          {groups.length > 0 ? (
            <div className="wr-nav-groups" role="group" aria-label="书架分组">
              <button
                className="wr-nav-group-btn"
                aria-current={!activeGroup ? "page" : undefined}
                onClick={() => navigate("/")}
              >
                全部
              </button>
              <button
                className="wr-nav-group-btn"
                aria-current={activeGroup === "未分组" ? "page" : undefined}
                onClick={() => navigate(`/?group=${encodeURIComponent("未分组")}`)}
              >
                未分组
              </button>
              {groups.map((g) => (
                <button
                  key={g}
                  className="wr-nav-group-btn"
                  title={g}
                  aria-current={activeGroup === g ? "page" : undefined}
                  onClick={() => navigate(`/?group=${encodeURIComponent(g)}`)}
                >
                  {g}
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
        </div>

        {props.sidebarFooter ? <div className="wr-side-bottom">{props.sidebarFooter}</div> : null}
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
    </div>
  );
}
