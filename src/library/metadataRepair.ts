import type { Book } from "../tauri/invoke";

export function needsMetadataRepair(book: Book): boolean {
  const t = book.title?.trim() ?? "";
  const c = book.cover_path?.trim() ?? "";
  return !t || !c;
}
