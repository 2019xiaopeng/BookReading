import { appDataDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";

import { coerceToLibraryRelPath } from "./libraryPath";

let basePromise: Promise<string> | null = null;

export function getAppDataBase(): Promise<string> {
  basePromise ??= appDataDir();
  return basePromise;
}

export function normalizeAppDataRelPath(rel: string): string {
  let v = rel.split("\\").join("/");
  while (v.startsWith("/")) v = v.slice(1);
  return v;
}

export function isSafeRelPath(rel: string): boolean {
  const v = normalizeAppDataRelPath(rel);
  if (v.split("/").some((seg) => seg === "..")) return false;
  if (/^[a-zA-Z]:/.test(v)) return false;
  return v.length > 0;
}

// 库根可配置后，"library/..." 相对路径必须由主进程按当前库根解析（AppData baseDir 只在默认根下成立）
export async function readAppDataFile(rel: string): Promise<Uint8Array> {
  const base = await getAppDataBase();
  const coerced = coerceToLibraryRelPath(rel, base);
  const v = coerced ? normalizeAppDataRelPath(coerced) : normalizeAppDataRelPath(rel);
  if (!isSafeRelPath(v)) throw new Error(`invalid relative path: ${rel}`);
  const res = await invoke<ArrayBuffer | number[]>("read_library_file", { rel: v });
  return new Uint8Array(res);
}

export function extToMime(ext: string | null): string {
  const e = (ext ?? "").toLowerCase();
  if (e === "png") return "image/png";
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "webp") return "image/webp";
  return "application/octet-stream";
}

export function revokeObjectUrl(url?: string | null): void {
  if (!url) return;
  URL.revokeObjectURL(url);
}

export async function readAppDataBlobUrl(rel: string, mime: string): Promise<string> {
  const bytes = await readAppDataFile(rel);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
