import { useSyncExternalStore } from "react";

import { setSetting } from "../tauri/invoke";
import { normalizeTheme } from "../reader/settings/normalize";
import type { Theme } from "../reader/settings/types";

/** 全局主题八色块：壳顶栏菜单与阅读设置面板共用同一份 */
export const THEME_SWATCHES: { value: Theme; label: string; color: string }[] = [
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

// node 测试环境无 document/localStorage，守卫模块顶层访问
let current: Theme = normalizeTheme(typeof localStorage !== "undefined" ? localStorage.getItem(LS_KEY) : null);
let touched = false; // 本会话用户改过主题后，不再用 DB 旧值覆盖（写库可能仍在途）
const listeners = new Set<() => void>();

function applyDom(t: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = t;
  // 原生弹层（select option 列表/滚动条）跟随 color-scheme；个别 WebView2 运行时对样式表里的
  // color-scheme 缓存不稳，内联直写兜底（tokens.css/weread.css 已有六主题映射，此处双保险）
  const style = document.documentElement.style;
  if (style) style.colorScheme = t === "dark" || t === "darkcontrast" || t === "ink-dark" ? "dark" : "light";
}

function commit(t: Theme) {
  current = t;
  if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, t);
  applyDom(t);
  for (const l of listeners) l();
}

applyDom(current); // 启动即应用：html[data-theme] 驱动 tokens.css/weread.css 全套变量

export function getTheme(): Theme {
  return current;
}

/** 用户切换（壳菜单 / 阅读设置面板色块）：即时生效，双写 localStorage + DB */
export function setTheme(t: Theme) {
  touched = true;
  applyDom(t);
  if (t !== current) commit(t);
  void setSetting("theme", t);
}

/** getSettings 回填纠偏：DB 与缓存不一致时以 DB 为准（用户已改则跳过） */
export function applyPersistedTheme(v: unknown) {
  if (touched) return;
  const t = normalizeTheme(v);
  if (t !== current) commit(t);
}

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
