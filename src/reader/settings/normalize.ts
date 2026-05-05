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

