import { describe, expect, test } from "vitest";

import { defaultSettings } from "./defaults";
import {
  normalizeLineHeight,
  normalizePageAnimation,
  normalizeReaderBackground,
  normalizeReadingMode,
  normalizeTheme,
} from "./normalize";

describe("normalize", () => {
  test("normalizeTheme defaults to light", () => {
    expect(normalizeTheme(undefined)).toBe("light");
    expect(normalizeTheme("")).toBe("light");
    expect(normalizeTheme("weird")).toBe("light");
  });

  test("normalizeTheme accepts valid values", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("sepia")).toBe("sepia");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("green")).toBe("green");
    expect(normalizeTheme("gray")).toBe("gray");
    expect(normalizeTheme("darkcontrast")).toBe("darkcontrast");
  });

  test("normalizeReadingMode defaults to paginated", () => {
    expect(normalizeReadingMode(undefined)).toBe("paginated");
    expect(normalizeReadingMode("")).toBe("paginated");
    expect(normalizeReadingMode("weird")).toBe("paginated");
  });

  test("normalizeReadingMode accepts valid values", () => {
    expect(normalizeReadingMode("paginated")).toBe("paginated");
    expect(normalizeReadingMode("scrolled")).toBe("scrolled");
  });

  test("normalizeReaderBackground defaults to preset on invalid shapes", () => {
    expect(normalizeReaderBackground(undefined)).toEqual({ type: "preset" });
    expect(normalizeReaderBackground("not json")).toEqual({ type: "preset" });
    expect(normalizeReaderBackground({ path: "library/bg/bg.png" })).toEqual({ type: "preset" });
    expect(normalizeReaderBackground({ type: "image" })).toEqual({ type: "preset" });
    expect(normalizeReaderBackground({ type: "image", path: 1 })).toEqual({ type: "preset" });
  });

  test("normalizeReaderBackground accepts valid values", () => {
    expect(normalizeReaderBackground({ type: "preset" })).toEqual({ type: "preset" });
    expect(normalizeReaderBackground({ type: "image", path: "library/bg/bg.png" })).toEqual({
      type: "image",
      path: "library/bg/bg.png",
    });
    expect(normalizeReaderBackground('{"type":"image","path":"library/bg/bg.webp"}')).toEqual({
      type: "image",
      path: "library/bg/bg.webp",
    });
  });

  test("normalizePageAnimation defaults to none", () => {
    expect(normalizePageAnimation(undefined)).toBe("none");
    expect(normalizePageAnimation("")).toBe("none");
    expect(normalizePageAnimation("weird")).toBe("none");
  });

  test("normalizePageAnimation accepts valid values", () => {
    expect(normalizePageAnimation("none")).toBe("none");
    expect(normalizePageAnimation("fade")).toBe("fade");
    expect(normalizePageAnimation("slide")).toBe("slide");
  });

  test("normalizeLineHeight clamps to 1.5-2.2 with 0.1 step", () => {
    expect(normalizeLineHeight(undefined)).toBe(1.9);
    expect(normalizeLineHeight("1.7")).toBe(1.7);
    expect(normalizeLineHeight(9)).toBe(2.2);
    expect(normalizeLineHeight(1)).toBe(1.5);
  });

  test("batch2-era stored settings (no new keys) normalize to paginated + preset", () => {
    const stored: Record<string, string> = { theme: "dark", fontSizePercent: "120" };
    expect(normalizeReadingMode(stored.readingMode)).toBe("paginated");
    expect(normalizeReaderBackground(stored.reader_bg)).toEqual({ type: "preset" });
  });

  test("defaultSettings includes the new keys with their defaults", () => {
    expect(defaultSettings.readingMode).toBe("paginated");
    expect(defaultSettings.reader_bg).toEqual({ type: "preset" });
  });
});
