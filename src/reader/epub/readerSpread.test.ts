import { describe, expect, test, vi } from "vitest";

import { applySpreadMode } from "./reader";

describe("applySpreadMode", () => {
  test("uses rendition.spread when available", () => {
    const spread = vi.fn();
    const rendition: any = { spread };
    applySpreadMode(rendition, "both");
    expect(spread).toHaveBeenCalledWith("both");
  });

  test("does nothing when spread is missing", () => {
    const rendition: any = {};
    expect(() => applySpreadMode(rendition, "none")).not.toThrow();
  });
});

