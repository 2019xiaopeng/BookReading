import type { FontFamily, PageAnimation, ReaderBackground, ReaderFont, ReadingMode, Theme } from "./types";

const FONT_FAMILIES = ["default", "songti", "heiti", "kaiti", "fangsong", "custom"] as const;

export function normalizeFontFamily(v: unknown): FontFamily {
  const s = String(v ?? "").trim().toLowerCase();
  return (FONT_FAMILIES as readonly string[]).includes(s) ? (s as FontFamily) : "default";
}

export function normalizeTheme(v: unknown): Theme {
  const s = String(v ?? "").trim().toLowerCase();
  if (
    s === "light" ||
    s === "dark" ||
    s === "sepia" ||
    s === "green" ||
    s === "gray" ||
    s === "darkcontrast" ||
    s === "ink" ||
    s === "ink-dark"
  ) {
    return s;
  }
  return "ink"; // M2 起新默认=纸墨
}

export function normalizeReadingMode(v: unknown): ReadingMode {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "paginated" || s === "scrolled") return s;
  return "paginated";
}

export function normalizeReaderBackground(v: unknown): ReaderBackground {
  let parsed: unknown = v;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { type: "preset" };
    }
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as { type?: unknown; path?: unknown };
    if (o.type === "preset") return { type: "preset" };
    if (o.type === "image" && typeof o.path === "string" && o.path.length > 0) {
      return { type: "image", path: o.path };
    }
  }
  return { type: "preset" };
}

/** B11 自定义字体槽位：与背景同构，type 为 custom */
export function normalizeReaderFont(v: unknown): ReaderFont {
  let parsed: unknown = v;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { type: "preset" };
    }
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as { type?: unknown; path?: unknown };
    if (o.type === "custom" && typeof o.path === "string" && o.path.length > 0) {
      return { type: "custom", path: o.path };
    }
  }
  return { type: "preset" };
}

export function normalizePageAnimation(v: unknown): PageAnimation {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "none" || s === "slide" || s === "fade") return s;
  return "none";
}

export function normalizeLineHeight(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1.9;
  return Math.min(2.2, Math.max(1.5, Math.round(n * 10) / 10));
}

/** 翻页动画时长钳制 150-600ms，默认 260（=slide 入场基准） */
export function normalizeTurnSpeedMs(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 260;
  return Math.min(600, Math.max(150, Math.round(n)));
}

/** 滑杆 commit：拖动草稿值落定时与已提交值相同（或未拖动）返回 null=不触发提交 */
export function sliderCommitValue(draft: number | null, committed: number): number | null {
  return draft !== null && draft !== committed ? draft : null;
}

// ---- #2 排版细项（v2.6.0）：步进钳位（toFixed 消 0.05/0.1 步进的浮点尾差） ----

function clampStep(v: unknown, min: number, max: number, step: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const snapped = Math.round(n / step) * step;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(2));
}

/** 字重三档 400|500|700，其余值回 400 */
export function normalizeFontWeight(v: unknown): number {
  const n = Number(v);
  return n === 500 || n === 700 ? n : 400;
}

export function normalizeLetterSpacing(v: unknown): number {
  return clampStep(v, 0, 2, 0.1, 0);
}

export function normalizeParagraphSpacing(v: unknown): number {
  // 默认 0=不注入（存量书观感零变化），>0 才注入 margin-bottom
  return clampStep(v, 0, 1, 0.05, 0);
}

export function normalizeTextIndent(v: unknown): number {
  return clampStep(v, 0, 2, 0.1, 0);
}

/** 纸面四边内边距 12-48px 步 2 */
export function normalizePageMargin(v: unknown): number {
  return clampStep(v, 12, 48, 2, 24);
}

/** #5 TTS 语速 0.5-2 步 0.1 */
export function normalizeTtsRate(v: unknown): number {
  return clampStep(v, 0.5, 2, 0.1, 1);
}

/** #7 背景纱浓度 60-95（settings 键 bg_veil，字符串存储；空串/垃圾回 88——壳侧同契约，见 AppShell.test.ts） */
export function normalizeBgVeil(v: unknown): number {
  // Number("") 会得 0 被钳成 60：字符串走 parseFloat 让空串落 NaN 回默认
  const n = typeof v === "string" ? Number.parseFloat(v) : Number(v);
  if (!Number.isFinite(n)) return 88;
  return Math.min(95, Math.max(60, Math.round(n)));
}
