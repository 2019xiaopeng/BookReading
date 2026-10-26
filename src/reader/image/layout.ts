export type ImageFit = "height" | "width" | "original";
export type ImagePageLayout = "single" | "double";
export type ImageReadMode = "paged" | "webtoon";

export type ImageReaderSettings = {
  fit: ImageFit;
  layout: ImagePageLayout;
  rtl: boolean;
  mode: ImageReadMode;
};

export type TurnDirection = "prev" | "next";

export const WIDE_PAGE_RATIO = 1.2;

export const defaultImageReaderSettings: ImageReaderSettings = {
  fit: "height",
  layout: "single",
  rtl: false,
  mode: "paged",
};

export function normalizeImageReaderSettings(raw: unknown): ImageReaderSettings {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      v = {};
    }
  }
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  return {
    fit: o.fit === "width" || o.fit === "original" ? o.fit : "height",
    layout: o.layout === "double" ? "double" : "single",
    rtl: o.rtl === true,
    mode: o.mode === "webtoon" ? "webtoon" : "paged",
  };
}

/** Pages grouped per screen; in double mode a wide page (ratio > WIDE_PAGE_RATIO) claims the full spread. */
export function buildSpreads(pageCount: number, widePages: boolean[], layout: ImagePageLayout): number[][] {
  const count = Math.max(0, Math.floor(pageCount));
  if (layout === "single") {
    const single: number[][] = [];
    for (let i = 0; i < count; i++) single.push([i]);
    return single;
  }
  const spreads: number[][] = [];
  let pending: number | null = null;
  for (let i = 0; i < count; i++) {
    if (widePages[i]) {
      if (pending !== null) {
        spreads.push([pending]);
        pending = null;
      }
      spreads.push([i]);
      continue;
    }
    if (pending === null) {
      pending = i;
      continue;
    }
    spreads.push([pending, i]);
    pending = null;
  }
  if (pending !== null) spreads.push([pending]);
  return spreads;
}

/** RTL spreads read right-to-left, so a 2-page spread renders in reverse order. */
export function displayOrder(spread: number[], rtl: boolean): number[] {
  return rtl && spread.length === 2 ? [spread[1], spread[0]] : spread;
}

export function spreadIndexForPage(spreads: number[][], page: number): number {
  const idx = spreads.findIndex((s) => s.includes(page));
  return idx === -1 ? 0 : idx;
}

/** Arrow keys follow the reading direction; PageUp/PageDown stay semantic in RTL. */
export function turnKeyDirection(key: string, rtl: boolean): TurnDirection | null {
  if (key === "PageUp") return "prev";
  if (key === "PageDown") return "next";
  if (key === "ArrowLeft") return rtl ? "next" : "prev";
  if (key === "ArrowRight") return rtl ? "prev" : "next";
  return null;
}

export function imageCfi(page: number): string {
  return `img:${page}`;
}

export function parseImageCfi(cfi: string | null | undefined): number | null {
  if (!cfi || !cfi.startsWith("img:")) return null;
  const n = Number.parseInt(cfi.slice(4), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Batch-2 contract: percent = page / pageCount. */
export function pagePercent(page: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(1, Math.max(0, page / pageCount));
}

export function clampPage(page: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(pageCount - 1, Math.max(0, Math.floor(page)));
}
