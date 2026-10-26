import { describe, expect, test } from "vitest";

import { normalizeLineHeight, normalizePageAnimation, normalizeTheme } from "./normalize";

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
});
