import { describe, expect, test } from "vitest";

import { normalizePageAnimation, normalizeTheme } from "./normalize";

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
});

