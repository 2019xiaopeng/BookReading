import type { Book } from "../tauri/invoke";

export function needsMetadataRepair(book: Book): boolean {
  const t = book.title?.trim() ?? "";
  return !t;
}
