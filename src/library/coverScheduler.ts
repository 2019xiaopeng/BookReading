// 封面请求调度（纯逻辑，useCoverUrls 的模块级队列消费）：
// 并发上限 + 视口优先——封面经独立 IPC 宏任务逐张到达，全量立即并发会挤爆 IPC 并触发逐张整页重渲
export const MAX_CONCURRENT_COVER_LOADS = 6;

export type CoverRequest = { path: string; id?: string };

/**
 * 从等待队列选出最多 max 个启动项：视口命中（isPreferred）的优先，同级保持入队顺序（稳定 FIFO）。
 */
export function pickNextCoverRequests<T>(
  queue: readonly T[],
  max: number,
  isPreferred: (item: T) => boolean,
): T[] {
  if (max <= 0 || queue.length === 0) return [];
  const preferred: T[] = [];
  const rest: T[] = [];
  for (const item of queue) (isPreferred(item) ? preferred : rest).push(item);
  return preferred.concat(rest).slice(0, max);
}
