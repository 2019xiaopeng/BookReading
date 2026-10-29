import type { Book } from "../tauri/invoke";

// 书卡/回收站行/菜单共用的展示文案（LibraryPage 与 BookCard 同源，避免各写一份漂移）
export function formatTitle(book: Book): string {
  return book.title?.trim() || "未命名";
}

export function formatAuthor(book: Book): string {
  return book.author?.trim() || "未知作者";
}

export function progressText(book: Book): string {
  return typeof book.reading_percent === "number" ? `读到 ${Math.round(book.reading_percent * 100)}%` : "未读";
}
