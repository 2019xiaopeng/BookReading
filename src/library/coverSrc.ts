// U-19 继续阅读封面跨重启死链：封面改走持久通道（cover_path → asset 协议直读绝对路径），
// 会话级 blob: URL 只作缓存命中加速，未命中回退这里——重启后冷缓存也能立即出图。
// 依赖 app.security.assetProtocol（tauri.conf.json 启用 + scope 覆盖库根，待主控接线；
// 未启用时本通道返回的 URL 加载失败，表现等同原“封面未到”，无回归）。
import { convertFileSrc } from "@tauri-apps/api/core";

// 绝对库根（library/ 的父目录）：AppShell 启动 settings 顺带预热——settings.library_root（自定义根）或 appDataDir（默认根）
let libraryRootAbs: string | null = null;

export function primeCoverLibraryRoot(root: string | null | undefined): void {
  const r = (root ?? "").trim().replace(/[\\/]+$/, "");
  libraryRootAbs = r || null;
}

export function getCoverLibraryRootForTests(): string | null {
  return libraryRootAbs;
}

function tauriConvertFileSrc(absPath: string): string | null {
  // convertFileSrc 委托 window.__TAURI_INTERNALS__（测试/浏览器环境没有）——缺失即视为无持久通道
  try {
    if (typeof window === "undefined" || !(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      return null;
    }
    return convertFileSrc(absPath);
  } catch {
    return null;
  }
}

/** cover_path（library/... 相对或绝对路径）→ 持久 asset src；库根未知 / 非 Tauri 环境 / 不明形态 → null（回退 blob 通道） */
export function persistentCoverSrc(coverPath: string): string | null {
  const rel = coverPath.trim().replace(/\\/g, "/");
  if (!rel) return null;
  const abs = /^[a-zA-Z]:\//.test(rel) || rel.startsWith("\\\\") || rel.startsWith("//")
    ? rel
    : libraryRootAbs
      ? `${libraryRootAbs}/${rel.replace(/^\/+/, "")}`
      : null;
  if (!abs) return null;
  return tauriConvertFileSrc(abs);
}
