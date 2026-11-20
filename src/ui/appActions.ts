// P-1 轻事件总线：侧栏底部固定「刷新」钮与各视图解耦——页面挂载订阅自己的刷新逻辑，壳不依赖页面注册动作
const listeners = new Set<() => void>();

export function emitAppRefresh(): void {
  for (const l of listeners) l();
}

export function subscribeAppRefresh(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
