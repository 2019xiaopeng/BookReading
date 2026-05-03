import { appDataDir } from "@tauri-apps/api/path";
import { BaseDirectory, readFile } from "@tauri-apps/plugin-fs";

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
  if (v.includes("..")) return false;
  if (v.startsWith("//")) return false;
  if (/^[a-zA-Z]:/.test(v)) return false;
  return v.length > 0;
}

export async function readAppDataFile(rel: string): Promise<Uint8Array> {
  const input = rel;

  const base = await getAppDataBase();
  const coerced = coerceToLibraryRelPath(input, base);
  const v = coerced ? normalizeAppDataRelPath(coerced) : normalizeAppDataRelPath(input);
  if (!isSafeRelPath(v)) throw new Error(`invalid relative path: ${input}`);
  return readFile(v, { baseDir: BaseDirectory.AppData });
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
