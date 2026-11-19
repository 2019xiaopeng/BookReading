import { useSyncExternalStore } from "react";

import { setSetting } from "../tauri/invoke";
import { normalizeTheme } from "../reader/settings/normalize";
import type { Theme } from "../reader/settings/types";

/** H-8：壳层可选主题 = reader 八主题 + auto（跟随系统；仅壳层解析，传给 reader 前已落地为 ink/ink-dark） */
export type ShellTheme = Theme | "auto";

/** 全局主题色块：壳顶栏菜单与阅读设置面板共用同一份；auto 格为纸墨/墨夜半分色 */
export const THEME_SWATCHES: { value: ShellTheme; label: string; color: string }[] = [
  { value: "auto", label: "跟随系统", color: "linear-gradient(135deg, #EDECE7 0 50%, #242321 50% 100%)" },
  { value: "light", label: "白色", color: "#ffffff" },
  { value: "sepia", label: "米黄", color: "#fffaf0" },
  { value: "green", label: "护眼", color: "#c8e6c4" },
  { value: "gray", label: "纸灰", color: "#d9d9d6" },
  // dark 的纸面 token 是半透明白，色块用壳底色代表夜间阅读面
  { value: "dark", label: "夜间", color: "#0f1214" },
  { value: "darkcontrast", label: "夜间高对比", color: "#050505" },
  // M2 纸墨双主题色块展示的是"墨"本身（纸墨=碳墨、墨夜=米白墨），与上面纸面色块语义相反
  { value: "ink", label: "纸墨", color: "#242321" },
  { value: "ink-dark", label: "墨夜", color: "#EDECE7" },
];

const LS_KEY = "wr-theme"; // 首帧缓存：import 时同步应用，避免启动闪白

/** 纯映射：auto → 系统深色 ? 墨夜 : 纸墨；具体主题原样透传（reader 侧 THEME_STYLES 只见八主题） */
export function resolveShellTheme(t: ShellTheme, prefersDark: boolean): Theme {
  return t === "auto" ? (prefersDark ? "ink-dark" : "ink") : t;
}

/** 壳层归一化：接受 auto；其余走 reader 侧 normalizeTheme（默认纸墨） */
export function normalizeShellTheme(v: unknown): ShellTheme {
  return String(v ?? "").trim().toLowerCase() === "auto" ? "auto" : normalizeTheme(v);
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

// node 测试环境无 document/localStorage，守卫模块顶层访问
let current: ShellTheme = normalizeShellTheme(
  typeof localStorage !== "undefined" ? localStorage.getItem(LS_KEY) : null,
);
let touched = false; // 本会话用户改过主题后，不再用 DB 旧值覆盖（写库可能仍在途）
const listeners = new Set<() => void>();

function applyDom(t: ShellTheme) {
  if (typeof document === "undefined") return;
  const resolved = resolveShellTheme(t, systemPrefersDark());
  document.documentElement.dataset.theme = resolved;
  // 原生弹层（select option 列表/滚动条）跟随 color-scheme；个别 WebView2 运行时对样式表里的
  // color-scheme 缓存不稳，内联直写兜底（tokens.css/weread.css 已有六主题映射，此处双保险）
  const style = document.documentElement.style;
  if (style) style.colorScheme = resolved === "dark" || resolved === "darkcontrast" || resolved === "ink-dark" ? "dark" : "light";
}

function commit(t: ShellTheme) {
  current = t;
  if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, t);
  applyDom(t);
  for (const l of listeners) l();
}

applyDom(current); // 启动即应用：html[data-theme] 驱动 tokens.css/weread.css 全套变量

// H-8：auto 档跟随系统切换——系统深浅色变更时重解析并广播（useTheme 订阅方拿到新的落地主题）
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (current !== "auto") return;
    applyDom(current);
    for (const l of listeners) l();
  });
}

/** 落地主题（auto 已解析）：reader THEME_STYLES / 页面消费此契约，永不见 "auto" */
export function getTheme(): Theme {
  return resolveShellTheme(current, systemPrefersDark());
}

/** 用户的选择值（含 auto）：壳顶栏菜单选中态用 */
export function getThemeSelection(): ShellTheme {
  return current;
}

/** 用户切换（壳菜单 / 阅读设置面板色块）：即时生效，双写 localStorage + DB */
export function setTheme(t: ShellTheme) {
  touched = true;
  applyDom(t);
  if (t !== current) commit(t);
  void setSetting("theme", t);
}

/** getSettings 回填纠偏：DB 与缓存不一致时以 DB 为准（用户已改则跳过） */
export function applyPersistedTheme(v: unknown) {
  if (touched) return;
  const t = normalizeShellTheme(v);
  if (t !== current) commit(t);
}

/** 落地主题（auto 已解析）——页面/阅读器订阅契约不变 */
export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getTheme,
    getTheme,
  );
}

/** 选择值（含 auto）——壳顶栏主题菜单选中态 */
export function useThemeSelection(): ShellTheme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getThemeSelection,
    getThemeSelection,
  );
}
