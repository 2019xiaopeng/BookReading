import { describe, expect, test, vi } from "vitest";

import { applySpreadMode, spineIndexFromCfi } from "./reader";

describe("applySpreadMode", () => {
  test("uses rendition.spread when available", () => {
    const spread = vi.fn();
    const rendition: any = { spread };
    applySpreadMode(rendition, "always");
    expect(spread).toHaveBeenCalledWith("always");
  });

  test("does nothing when spread is missing", () => {
    const rendition: any = {};
    expect(() => applySpreadMode(rendition, "none")).not.toThrow();
  });

  test("re-displays the captured CFI after switching (no mid-seam clipping)", () => {
    const spread = vi.fn();
    const clear = vi.fn();
    const display = vi.fn();
    const rendition: any = { spread, clear, display };
    applySpreadMode(rendition, "always", "epubcfi(/6/4!/4/2)");
    expect(spread).toHaveBeenCalledWith("always");
    expect(clear).toHaveBeenCalled();
    expect(display).toHaveBeenCalledWith("epubcfi(/6/4!/4/2)");
  });

  test("falls back to resize when nothing is displayed yet", () => {
    const spread = vi.fn();
    const resize = vi.fn();
    const rendition: any = { spread, resize };
    applySpreadMode(rendition, "none");
    expect(spread).toHaveBeenCalledWith("none");
    expect(resize).toHaveBeenCalled();
  });
});

describe("spineIndexFromCfi", () => {
  test("maps /6/<2N>! to spine index N-1", () => {
    expect(spineIndexFromCfi("epubcfi(/6/2!/4/2/1:0)")).toBe(0);
    expect(spineIndexFromCfi("epubcfi(/6/4!/4/2)")).toBe(1);
    expect(spineIndexFromCfi("epubcfi(/6/14!/4/2)")).toBe(6);
  });

  test("returns null for cfi without a spine-item segment", () => {
    expect(spineIndexFromCfi("epubcfi(/6/4)")).toBeNull();
    expect(spineIndexFromCfi("")).toBeNull();
    expect(spineIndexFromCfi(undefined)).toBeNull();
  });
});
