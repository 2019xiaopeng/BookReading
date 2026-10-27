// 阅读状态判定：null 或 0 = 未读；0 < percent < 0.95 = 在读；>= 0.95 = 已读
export type ReadingStatus = "unread" | "reading" | "finished";

export function readingStatus(percent: number | null): ReadingStatus {
  if (percent == null || percent <= 0) return "unread";
  return percent >= 0.95 ? "finished" : "reading";
}

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  unread: "未读",
  reading: "在读",
  finished: "已读",
};
