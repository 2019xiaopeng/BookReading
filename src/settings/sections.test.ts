import { describe, expect, test } from "vitest";

import { SETTINGS_SECTIONS, normalizeSettingsSection } from "./sections";

describe("SETTINGS_SECTIONS（V-3 设置页八分区登记表）", () => {
  test("恰好八分区、顺序即导航顺序（用户 2026-11-24 拍板的八个）", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual([
      "外观",
      "阅读",
      "书库",
      "云书架",
      "网络与更新",
      "快捷键",
      "漫画增强",
      "关于",
    ]);
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size).toBe(8);
    for (const s of SETTINGS_SECTIONS) expect(s.desc.length).toBeGreaterThan(0);
  });

  test("normalizeSettingsSection：合法 id 原样；缺省 / 空串 / 非法 / 大小写变体一律回外观", () => {
    for (const s of SETTINGS_SECTIONS) expect(normalizeSettingsSection(s.id)).toBe(s.id);
    expect(normalizeSettingsSection(null)).toBe("appearance");
    expect(normalizeSettingsSection(undefined)).toBe("appearance");
    expect(normalizeSettingsSection("")).toBe("appearance");
    expect(normalizeSettingsSection("Network")).toBe("appearance");
    expect(normalizeSettingsSection("constructor")).toBe("appearance");
  });
});
