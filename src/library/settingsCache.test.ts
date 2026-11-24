import { afterEach, describe, expect, test } from "vitest";

import {
  getCachedSetting,
  primeSettingsCache,
  resetSettingsCacheForTests,
  setCachedSetting,
} from "./settingsCache";

afterEach(() => resetSettingsCacheForTests());

describe("settingsCache（U-3 密度闪帧）", () => {
  test("预热后同步读命中；未预热回 undefined（回退默认行为）", () => {
    expect(getCachedSetting("library_density")).toBeUndefined();
    primeSettingsCache({ library_density: "xl" });
    expect(getCachedSetting("library_density")).toBe("xl");
    expect(getCachedSetting("nope")).toBeUndefined();
  });

  test("写穿只改单键且不影响其余；重复预热整体替换", () => {
    primeSettingsCache({ library_density: "standard", library_sort: '{"key":"title","asc":true}' });
    setCachedSetting("library_density", "large");
    expect(getCachedSetting("library_density")).toBe("large");
    expect(getCachedSetting("library_sort")).toBe('{"key":"title","asc":true}');
    primeSettingsCache({ folder_sort: "count-desc" });
    expect(getCachedSetting("library_density")).toBeUndefined(); // 整体替换，不带旧值
  });

  test("未预热时写穿不冷启动建缓存（等启动全量预热）", () => {
    setCachedSetting("library_density", "xl");
    expect(getCachedSetting("library_density")).toBeUndefined();
  });
});
