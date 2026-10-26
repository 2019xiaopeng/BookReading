import type { PageAnimation, Theme } from "./types";

export function normalizeTheme(v: unknown): Theme {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "light" || s === "dark" || s === "sepia") return s;
  return "light";
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
