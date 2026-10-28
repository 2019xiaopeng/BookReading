// PDF 加载链：复用 readAppDataFile 读库内 pdf 字节 → pdfjs getDocument（禁自动 fetch）。
// pdfjs 主库 + worker 均为按需 chunk（首个 PDF 打开才加载），不拖慢书库启动。
// worker：?url 引 pdfjs-dist 的 hashed 资产，dev/生产均与页面同源（tauri 生产走 http://tauri.localhost）。
// 若未来 worker 在生产环境失败：回退路径 = 不设 workerSrc 且 getDocument({ ..., disableWorker: true })
// （pdfjs 走主线程 fake worker，无需同源脚本），代价是解析/渲染占用 UI 线程。
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

import { readAppDataFile } from "../../tauri/appDataPaths";

let libPromise: Promise<typeof import("pdfjs-dist")> | null = null;

function pdfjs(): Promise<typeof import("pdfjs-dist")> {
  libPromise ??= (async () => {
    const lib = await import("pdfjs-dist");
    lib.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    return lib;
  })();
  return libPromise;
}

// pdfjs v6：销毁句柄在 loadingTask 上（doc.destroy 已移除），随句柄一并返回
export type PdfHandle = { doc: PDFDocumentProxy; destroy: () => Promise<void> };

export async function loadPdf(libraryPath: string): Promise<PdfHandle> {
  const lib = await pdfjs();
  const bytes = await readAppDataFile(libraryPath);
  const task = lib.getDocument({ data: bytes, disableAutoFetch: true });
  const doc = await task.promise;
  return { doc, destroy: () => task.destroy() };
}

/** 密码/损坏等加载失败归类：受密码保护的 PDF 明确提示，其余原样抛出 */
export function pdfLoadErrorMessage(e: unknown): string {
  if (e && typeof e === "object" && (e as { name?: string }).name === "PasswordException") {
    return "受密码保护的 PDF 暂不支持";
  }
  return String(e);
}

/** 渲染单页到离屏位图 canvas（devicePixelRatio 适配清晰度）；RenderTask 由调用方持有以便取消 */
export async function renderPdfPage(
  doc: PDFDocumentProxy,
  pageNumber1: number,
  scale: number,
): Promise<{ canvas: HTMLCanvasElement; renderTask: RenderTask }> {
  const page = await doc.getPage(pageNumber1);
  const viewport = page.getViewport({ scale });
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  const renderTask = page.render({
    canvas,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  });
  return { canvas, renderTask };
}
