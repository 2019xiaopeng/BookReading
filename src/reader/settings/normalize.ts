import type { FontFamily, PageAnimation, ReaderBackground, ReaderFont, ReadingMode, Theme } from "./types";

const FONT_FAMILIES = ["default", "songti", "heiti", "kaiti", "fangsong", "custom"] as const;

export function normalizeFontFamily(v: unknown): FontFamily {
  const s = String(v ?? "").trim().toLowerCase();
  return (FONT_FAMILIES as readonly string[]).includes(s) ? (s as FontFamily) : "default";
}

export function normalizeTheme(v: unknown): Theme {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "light" || s === "dark" || s === "sepia" || s === "green" || s === "gray" || s === "darkcontrast") {
    return s;
  }
  return "light";
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
