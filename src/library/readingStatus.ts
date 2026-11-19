import type { Book } from "../tauri/invoke";

// 阅读状态判定（S-3）：从未打开且无进度 = 未读；打开过（或已有进度）且 <95% = 在读；>=95% = 已读。
// "未读"=没碰过的书，"在读"=翻开过没读完的——刚打开进度仍为 0 的书立即算在读。
export type ReadingStatus = "unread" | "reading" | "finished";

export function readingStatus(percent: number | null, openedAt: number | null): ReadingStatus {
  const p = percent ?? 0;
  if (p >= 0.95) return "finished";
  return p > 0 || openedAt != null ? "reading" : "unread";
}

/** S-4/S-5 合并口径：手动状态优先，缺省按打开记录+进度推导。过滤与统计一律走它。 */
export function effectiveStatus(
  book: Pick<Book, "reading_percent" | "last_opened_at" | "manual_status">,
): ReadingStatus {
  return book.manual_status ?? readingStatus(book.reading_percent, book.last_opened_at);
}

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  unread: "未读",
  reading: "在读",
  finished: "已读",
};
