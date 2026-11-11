import { describe, expect, test } from "vitest";

import { defaultSettings } from "./defaults";
import { epubSettingsKey, EPUSET_FIELDS, parseEpubSettingsOverride, resolveEpubSettings } from "./epuset";

describe("epuset 排版按书记忆", () => {
  test("键名形如 epuset:<bookId>", () => {
    expect(epubSettingsKey("abc123")).toBe("epuset:abc123");
  });

  test("EPUSET_FIELDS 覆盖八个书级字段（不含字体族）", () => {
    expect([...EPUSET_FIELDS].sort()).toEqual(
      [
        "fontSizePercent",
        "lineHeight",
        "fontWeight",
        "letterSpacing",
        "paragraphSpacing",
        "textIndent",
        "pageMargin",
        "justify",
      ].sort(),
    );
  });

  test("resolveEpubSettings：合法覆盖生效，未覆盖字段沿用全局默认", () => {
    const merged = resolveEpubSettings(defaultSettings, { fontSizePercent: 150, fontWeight: 700, justify: true });
    expect(merged.fontSizePercent).toBe(150);
    expect(merged.fontWeight).toBe(700);
    expect(merged.justify).toBe(true);
    expect(merged.lineHeight).toBe(defaultSettings.lineHeight);
    expect(merged.fontFamily).toBe(defaultSettings.fontFamily);
    expect(merged.pageAnimation).toBe(defaultSettings.pageAnimation);
  });

  test("resolveEpubSettings：settings 表里的 JSON 字符串同样可解析", () => {
    const merged = resolveEpubSettings(defaultSettings, '{"lineHeight":2.0,"pageMargin":40}');
    expect(merged.lineHeight).toBe(2);
    expect(merged.pageMargin).toBe(40);
  });

  test("parseEpubSettingsOverride：非法值丢弃（不落到默认值——那是全局的事）、坏 JSON/空覆盖回空", () => {
    expect(parseEpubSettingsOverride("not json")).toEqual({});
    expect(parseEpubSettingsOverride(null)).toEqual({});
    expect(parseEpubSettingsOverride({ fontWeight: 600, justify: "yes", fontFamily: "heiti" })).toEqual({});
    expect(parseEpubSettingsOverride({ fontSizePercent: "150" })).toEqual({});
  });

  test("parseEpubSettingsOverride：越界值钳位（字号 80-200、页边距 12-48、段距 0-1）", () => {
    expect(parseEpubSettingsOverride({ fontSizePercent: 999 }).fontSizePercent).toBe(200);
    expect(parseEpubSettingsOverride({ fontSizePercent: 10 }).fontSizePercent).toBe(80);
    expect(parseEpubSettingsOverride({ pageMargin: 4 }).pageMargin).toBe(12);
    expect(parseEpubSettingsOverride({ paragraphSpacing: 5 }).paragraphSpacing).toBe(1);
    expect(parseEpubSettingsOverride({ lineHeight: 9 }).lineHeight).toBe(2.2);
  });

  test("parseEpubSettingsOverride：justify 两个方向都可钉", () => {
    expect(parseEpubSettingsOverride({ justify: true }).justify).toBe(true);
    expect(parseEpubSettingsOverride({ justify: false }).justify).toBe(false);
  });
});
