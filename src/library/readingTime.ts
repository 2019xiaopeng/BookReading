/** E3/S-2 阅读时长格式化：0 秒返回 null（不显示）；>0 且不足 1 分钟显示“<1 分钟”。 */
export function formatReadingTime(seconds: number): string | null {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return null;
  if (s < 60) return "<1 分钟";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h <= 0) return `${m} 分`;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}
