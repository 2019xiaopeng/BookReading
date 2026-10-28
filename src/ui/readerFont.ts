import { readAppDataBlobUrl, revokeObjectUrl } from "../tauri/appDataPaths";
import type { ReaderFont } from "../reader/settings/types";

// 自定义正文字体单槽缓存（仿 appBackground）：换字体/回 preset 时回收旧 objectURL 与 <style>，
// 全应用至多一个 @font-face("wr-custom")；壳与 epub iframe 共用同一 family 名（FONT_STACKS.custom）
let cache: { path: string; url: string; style: HTMLStyleElement } | null = null;

// 后端固定写 library/fonts/font.<ext>：同扩展名换字体后 path 不变、内容已变，写入方须显式失效
export function resetFontCache() {
  if (cache) {
    revokeObjectUrl(cache.url);
    cache.style.remove();
    cache = null;
  }
}

export async function applyReaderFont(font: ReaderFont): Promise<void> {
  if (font.type !== "custom" || typeof document === "undefined") {
    resetFontCache();
    return;
  }
  if (cache?.path === font.path) return;
  const ext = font.path.split(".").pop() ?? "";
  const mime = ext === "ttf" ? "font/ttf" : ext === "otf" ? "font/otf" : "font/woff2";
  const url = await readAppDataBlobUrl(font.path, mime);
  resetFontCache();
  const style = document.createElement("style");
  style.textContent = `@font-face{font-family:"wr-custom";src:url("${url}");}`;
  document.head.appendChild(style);
  cache = { path: font.path, url, style };
}
