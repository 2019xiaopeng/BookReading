import { readAppDataBlobUrl, revokeObjectUrl } from "../../tauri/appDataPaths";
import type { ReaderFont } from "../settings/types";

// 自定义正文字体（wr-custom）的 iframe 侧 @font-face 源：正文渲染在 epubjs iframe 里，
// 宿主 document 的 @font-face（ui/readerFont.ts 注入的那份）对 iframe 完全无效。
// 本模块独立持有同一字体文件的 blob 单槽；安装/恢复字体时由 SettingsPanel 调 resetIframeFontCache 失效
// （后端固定覆写 library/fonts/font.<ext>，同 path 换内容必须显式作废旧 blob）。
let cache: { path: string; url: string } | null = null;

function faceCss(url: string): string {
  return `@font-face{font-family:"wr-custom";src:url("${url}");}`;
}

export function resetIframeFontCache(): void {
  if (cache) {
    revokeObjectUrl(cache.url);
    cache = null;
  }
}

/** 取当前自定义字体的 @font-face css；preset/加载失败返回 null（reader 按无自定义字体处理）。 */
export async function readerFontFaceCss(font: ReaderFont): Promise<string | null> {
  if (font.type !== "custom" || typeof document === "undefined") {
    resetIframeFontCache();
    return null;
  }
  if (cache?.path === font.path) return faceCss(cache.url);
  const ext = font.path.split(".").pop() ?? "";
  const mime = ext === "ttf" ? "font/ttf" : ext === "otf" ? "font/otf" : "font/woff2";
  const url = await readAppDataBlobUrl(font.path, mime);
  resetIframeFontCache();
  cache = { path: font.path, url };
  return faceCss(url);
}
