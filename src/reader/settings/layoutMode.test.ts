import { describe, expect, test } from "vitest";

import { normalizeLayoutMode, resolveSpreadMode } from "./layoutMode";

describe("layoutMode", () => {
  test("normalizeLayoutMode defaults to auto", () => {
    expect(normalizeLayoutMode(undefined)).toBe("auto");
    expect(normalizeLayoutMode("")).toBe("auto");
    expect(normalizeLayoutMode("weird")).toBe("auto");
  });

  test("normalizeLayoutMode accepts valid values", () => {
    expect(normalizeLayoutMode("single")).toBe("single");
    expect(normalizeLayoutMode("double")).toBe("double");
    expect(normalizeLayoutMode("auto")).toBe("auto");
  });

  test("resolveSpreadMode maps layout+width to epubjs spread", () => {
    expect(resolveSpreadMode("single", 1600)).toBe("none");
    expect(resolveSpreadMode("double", 800)).toBe("both");
    expect(resolveSpreadMode("auto", 800)).toBe("none");
    expect(resolveSpreadMode("auto", 1200)).toBe("both");
  });
});

