import { describe, expect, test } from "vitest";

import { defaultSettings } from "../reader/settings/defaults";
import { readerSettingsFromMap, readerSettingsToMap, visualSettingsFromMap } from "./readerDefaults";

// 与 ReaderPage.persistSettings 写的键逐一对照（两处映射须同步——见 readerDefaults.ts 头注释）
const PERSIST_KEYS = [
  "fontSizePercent",
  "pageAnimation",
  "turnSpeedMs",
  "layoutMode",
  "lineHeight",
  "fontFamily",
  "fontWeight",
  "letterSpacing",
  "paragraphSpacing",
  "textIndent",
  "pageMargin",
  "justify",
  "readingMode",
  "reader_bg",
  "reader_font",
];

describe("readerSettingsFromMap（settings 表 → 全局阅读默认）", () => {
  test("空表 → 全部默认档", () => {
    expect(readerSettingsFromMap({})).toEqual(defaultSettings);
  });

  test("读：按 reader 侧 normalizer 钳位 / 回默认", () => {
    const s = readerSettingsFromMap({
      fontSizePercent: "999",
      lineHeight: "9",
      turnSpeedMs: "10",
      pageAnimation: "bogus",
      layoutMode: "single",
      fontFamily: "kaiti",
      fontWeight: "700",
      justify: "true",
      readingMode: "scrolled",
      reader_bg: JSON.stringify({ type: "image", path: "library/bg/bg.png" }),
    });
    expect(s.fontSizePercent).toBe(200);
    expect(s.lineHeight).toBe(2.2);
    expect(s.turnSpeedMs).toBe(150);
    expect(s.pageAnimation).toBe("none");
    expect(s.layoutMode).toBe("single");
    expect(s.fontFamily).toBe("kaiti");
    expect(s.fontWeight).toBe(700);
    expect(s.justify).toBe(true);
    expect(s.readingMode).toBe("scrolled");
    expect(s.reader_bg).toEqual({ type: "image", path: "library/bg/bg.png" });
  });

  test("坏值回默认而不是 NaN / 垃圾", () => {
    const s = readerSettingsFromMap({
      fontSizePercent: "abc",
      lineHeight: "abc",
      pageMargin: "not-a-number",
      justify: "yes",
      reader_bg: "{broken json",
      reader_font: JSON.stringify({ type: "custom" }),
    });
    expect(s.fontSizePercent).toBe(defaultSettings.fontSizePercent);
    expect(s.lineHeight).toBe(defaultSettings.lineHeight);
    expect(s.pageMargin).toBe(defaultSettings.pageMargin);
    expect(s.justify).toBe(false);
    expect(s.reader_bg).toEqual({ type: "preset" });
    expect(s.reader_font).toEqual({ type: "preset" });
  });

  test("空串行距钳到下限 1.5——与 ReaderPage 开书回填同一口径（reader 侧 normalizer 把空串当 0），这里如实镜像不另行纠偏", () => {
    expect(readerSettingsFromMap({ lineHeight: "" }).lineHeight).toBe(1.5);
  });
});

describe("readerSettingsToMap（全局阅读默认 → settings 表）", () => {
  test("写的键与 ReaderPage.persistSettings 完全同一组（15 个）", () => {
    expect(Object.keys(readerSettingsToMap(defaultSettings)).sort()).toEqual([...PERSIST_KEYS].sort());
  });

  test("字符串编码口径一致：数字 String()、justify 布尔字面量、背景/字体 JSON", () => {
    const m = readerSettingsToMap({
      ...defaultSettings,
      fontSizePercent: 135,
      lineHeight: 2.1,
      justify: true,
      reader_font: { type: "custom", path: "library/fonts/font.ttf" },
    });
    expect(m).toMatchObject({
      fontSizePercent: "135",
      lineHeight: "2.1",
      pageMargin: "24",
      justify: "true",
      pageAnimation: "none",
      readingMode: "paginated",
      reader_bg: JSON.stringify({ type: "preset" }),
      reader_font: JSON.stringify({ type: "custom", path: "library/fonts/font.ttf" }),
    });
  });

  test("读写往返恒等", () => {
    expect(readerSettingsFromMap(readerSettingsToMap(defaultSettings))).toEqual(defaultSettings);
  });
});

describe("visualSettingsFromMap（漫画 / PDF 全局默认）", () => {
  const manga = { mode: "webtoon", rtl: true, autoScrollSpeed: 120 };

  test("漫画键各读各的", () => {
    expect(visualSettingsFromMap({ image_reader_settings: JSON.stringify(manga) }, "image_reader_settings")).toMatchObject(manga);
  });

  test("PDF 键缺失时继承漫画键（批次16 旧数据迁移口径）", () => {
    expect(visualSettingsFromMap({ image_reader_settings: JSON.stringify(manga) }, "pdf_reader_settings")).toMatchObject(manga);
  });

  test("PDF 键存在时不再继承；坏 JSON 回默认档", () => {
    const map = { image_reader_settings: JSON.stringify(manga), pdf_reader_settings: JSON.stringify({ mode: "paged" }) };
    expect(visualSettingsFromMap(map, "pdf_reader_settings").mode).toBe("paged");
    expect(visualSettingsFromMap({ pdf_reader_settings: "{oops" }, "pdf_reader_settings").mode).toBe("paged");
  });
});
