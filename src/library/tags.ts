// 标签预设 8 色（管理换色 + 新建默认色共用）；null = 跟随主题强调色
export const TAG_COLORS = [
  "#1971c2",
  "#2f9e44",
  "#e8590c",
  "#e03131",
  "#9c36b5",
  "#f08c00",
  "#0c8599",
  "#5f3dc4",
] as const;

export const DEFAULT_TAG_COLOR: string = TAG_COLORS[0];

export function tagDotColor(color: string | null): string {
  return color ?? "var(--wr-accent)";
}

// 文件大小：KB/MB 格式化（详情页与统计行共用）
export function formatFileSize(bytes: number | null): string {
  if (bytes == null || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
