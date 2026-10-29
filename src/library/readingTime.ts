/** E3 阅读时长格式化：不足 1 分钟返回 null（书卡省略该行，详情页回退“不足 1 分钟”）。 */
export function formatReadingTime(seconds: number): string | null {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h <= 0) return `${m} 分`;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}
