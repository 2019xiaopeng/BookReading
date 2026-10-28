// PDF 阅读器纯函数层：cfi 约定；几何/缩放钳制复用漫画 layout。
// 批次15：PDF 与漫画共用 image_reader_settings（独立 pdf_reader_settings 已删），
// 连续滚动沿用 webtoon 枚举（PdfReader 内 mode === "webtoon" 即连续滚动）。
export { clampPage, clampZoomScale, pagePercent, panClamp, ZOOM_MIN, ZOOM_MAX, turnKeyDirection } from "../image/layout";
export type { TurnDirection } from "../image/layout";

/** 进度约定：reading_state.cfi = "pdf:<页号0起>"（对齐漫画 img:N） */
export function pdfCfi(page: number): string {
  return `pdf:${page}`;
}

export function parsePdfCfi(cfi: string | null | undefined): number | null {
  if (!cfi || !cfi.startsWith("pdf:")) return null;
  const n = Number.parseInt(cfi.slice(4), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
