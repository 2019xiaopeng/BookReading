// U-3 密度闪帧根修：settings 键值模块级缓存。AppShell 启动流程的 getSettings 预热写缓存，
// LibraryPage 密度/排序等首帧初始化同步读——未命中（DB 未达）回退各处默认行为，与原状一致。
// 写穿由调用方负责（setCachedSetting）：setSetting 落库成功的页面同步改缓存，防下次挂载读到旧值再闪一次。

type SettingsMap = Record<string, string>;

let cache: SettingsMap | null = null;

export function primeSettingsCache(map: SettingsMap): void {
  cache = { ...map };
}

export function getCachedSetting(key: string): string | undefined {
  return cache?.[key];
}

/** setSetting 成功后写穿；缓存未预热（null）时不冷启动建缓存——等启动预热全量到达 */
export function setCachedSetting(key: string, value: string): void {
  if (cache) cache[key] = value;
}

export function resetSettingsCacheForTests(): void {
  cache = null;
}
