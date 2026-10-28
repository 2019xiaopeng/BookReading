import { describe, expect, test } from "vitest";

import { DENSITY_PRESETS, normalizeLibraryDensity } from "./density";

describe("normalizeLibraryDensity", () => {
  test("valid values pass, legacy compact migrates to standard, anything else falls back", () => {
    expect(normalizeLibraryDensity("standard")).toBe("standard");
    expect(normalizeLibraryDensity("large")).toBe("large");
    expect(normalizeLibraryDensity("xl")).toBe("xl");
    expect(normalizeLibraryDensity("compact")).toBe("standard");
    expect(normalizeLibraryDensity(undefined)).toBe("standard");
    expect(normalizeLibraryDensity("")).toBe("standard");
    expect(normalizeLibraryDensity("huge")).toBe("standard");
    expect(normalizeLibraryDensity({})).toBe("standard");
  });
});

describe("DENSITY_PRESETS", () => {
  test("covers exactly the three densities with distinct grids and labels", () => {
    expect(Object.keys(DENSITY_PRESETS)).toEqual(["standard", "large", "xl"]);
    expect(new Set(Object.values(DENSITY_PRESETS).map((p) => p.grid)).size).toBe(3);
    for (const p of Object.values(DENSITY_PRESETS)) expect(p.label.length).toBeGreaterThan(0);
  });
});
