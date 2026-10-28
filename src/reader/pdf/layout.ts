// PDF 阅读器纯函数层：cfi 约定、设置规范化；几何/缩放钳制复用漫画 layout（同一语义，单一实现）
import type { ImageFit } from "../image/layout";

export { clampPage, clampZoomScale, pagePercent, panClamp, ZOOM_MIN, ZOOM_MAX, turnKeyDirection } from "../image/layout";
export type { TurnDirection } from "../image/layout";

export type PdfReadMode = "paged" | "scroll";

export type PdfReaderSettings = {
  fit: ImageFit; // 适高/适宽/原始（分页模式）
  mode: PdfReadMode; // 分页 / 连续滚动
};

export const defaultPdfReaderSettings: PdfReaderSettings = { fit: "height", mode: "paged" };

export function normalizePdfReaderSettings(raw: unknown): PdfReaderSettings {
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
    mode: o.mode === "scroll" ? "scroll" : "paged",
  };
}

/** 进度约定：reading_state.cfi = "pdf:<页号0起>"（对齐漫画 img:N） */
export function pdfCfi(page: number): string {
  return `pdf:${page}`;
}

export function parsePdfCfi(cfi: string | null | undefined): number | null {
  if (!cfi || !cfi.startsWith("pdf:")) return null;
  const n = Number.parseInt(cfi.slice(4), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
