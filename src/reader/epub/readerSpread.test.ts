import { describe, expect, test, vi } from "vitest";

import { applySpreadMode, cfiRangesOverlap, scrollEdgeDirection, spineIndexFromCfi } from "./reader";

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

describe("cfiRangesOverlap", () => {
  const A = "epubcfi(/6/4!/4/2,/1:0,/1:10)"; // charOffset 形态

  test("相交（端点错开）", () => {
    expect(cfiRangesOverlap(A, "epubcfi(/6/4!/4/2,/1:5,/1:15)")).toBe(true);
  });

  test("相邻（端点重合算相交，整段错开不算）", () => {
    expect(cfiRangesOverlap(A, "epubcfi(/6/4!/4/2,/1:10,/1:20)")).toBe(true);
    expect(cfiRangesOverlap(A, "epubcfi(/6/4!/4/2,/1:11,/1:20)")).toBe(false);
    expect(cfiRangesOverlap("epubcfi(/6/4!/4/2,/1:0,/1:9)", "epubcfi(/6/4!/4/2,/1:10,/1:20)")).toBe(false);
  });

  test("包含与被包含", () => {
    expect(cfiRangesOverlap(A, "epubcfi(/6/4!/4/2,/1:2,/1:5)")).toBe(true);
    expect(cfiRangesOverlap(A, "epubcfi(/6/4!/4/2,/1:0,/1:100)")).toBe(true);
  });

  test("跨 spine 不相交", () => {
    expect(cfiRangesOverlap(A, "epubcfi(/6/6!/4/2,/1:0,/1:10)")).toBe(false);
    expect(cfiRangesOverlap(A, "epubcfi(/6/2!/4/2,/1:0,/1:10)")).toBe(false);
  });

  test("同 range / 非 range 点退化", () => {
    expect(cfiRangesOverlap(A, A)).toBe(true);
    expect(cfiRangesOverlap(A, "epubcfi(/6/4!/4/2/1:5)")).toBe(true);
    expect(cfiRangesOverlap(A, "epubcfi(/6/4!/4/2/1:50)")).toBe(false);
  });

  test("非法输入按不相交处理", () => {
    expect(cfiRangesOverlap("junk", A)).toBe(false);
    expect(cfiRangesOverlap("", A)).toBe(false);
    expect(cfiRangesOverlap("epubcfi(/6/4)", A)).toBe(false);
  });
});

describe("scrollEdgeDirection（B13 滚动模式章续读）", () => {
  test("章中为 null；距端 <40px 判到边", () => {
    // scrollHeight=2000, clientHeight=600：可视 [scrollTop, scrollTop+600]
    expect(scrollEdgeDirection(500, 600, 2000, 1)).toBeNull();
    expect(scrollEdgeDirection(1300, 600, 2000, 1)).toBeNull(); // bottomGap=100
    expect(scrollEdgeDirection(1400, 600, 2000, 1)).toBe(1); // bottomGap=0
    expect(scrollEdgeDirection(1361, 600, 2000, 1)).toBe(1); // bottomGap=39
    expect(scrollEdgeDirection(1360, 600, 2000, 1)).toBeNull(); // bottomGap=40
    expect(scrollEdgeDirection(39, 600, 2000, -1)).toBe(-1); // topGap=39
    expect(scrollEdgeDirection(40, 600, 2000, -1)).toBeNull(); // topGap=40
    expect(scrollEdgeDirection(0, 600, 2000, -1)).toBe(-1);
  });

  test("短章（整章可见）按滚动方向续读", () => {
    expect(scrollEdgeDirection(0, 600, 500, 1)).toBe(1);
    expect(scrollEdgeDirection(0, 600, 500, -1)).toBe(-1);
  });
});
