import { appDataDir } from "@tauri-apps/api/path";
import { readLibraryFile } from "./invoke";

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
  if (v.includes("..")) return false;
  if (v.startsWith("//")) return false;
  if (/^[a-zA-Z]:/.test(v)) return false;
  return v.length > 0;
}

export async function readAppDataFile(rel: string): Promise<Uint8Array> {
  const input = rel;
  const v0 = normalizeAppDataRelPath(input);
  if (v0.toLowerCase().startsWith("library/")) {
    if (!isSafeRelPath(v0)) throw new Error(`invalid relative path: ${input}`);
    const bytes = await readLibraryFile(v0);
    return new Uint8Array(bytes);
  }

  const base = await getAppDataBase();
  const baseNorm = base.split("\\").join("/").replace(/\/+$/, "");
  const inputNorm = input.split("\\").join("/");

  if (inputNorm.toLowerCase().startsWith(baseNorm.toLowerCase())) {
    const sliced = normalizeAppDataRelPath(inputNorm.slice(baseNorm.length));
    if (!isSafeRelPath(sliced)) throw new Error(`invalid relative path: ${input}`);
    const bytes = await readLibraryFile(sliced);
    return new Uint8Array(bytes);
  }

  const idx = inputNorm.toLowerCase().indexOf("/library/");
  if (idx !== -1) {
    const sliced = normalizeAppDataRelPath(inputNorm.slice(idx + 1));
    if (!isSafeRelPath(sliced)) throw new Error(`invalid relative path: ${input}`);
    const bytes = await readLibraryFile(sliced);
    return new Uint8Array(bytes);
  }

  throw new Error(`无法访问文件（不在应用数据目录内）：${input}`);
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
