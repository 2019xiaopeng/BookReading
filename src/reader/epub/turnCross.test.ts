import { describe, expect, test } from "vitest";

import { turnCrossesSection } from "./reader";

function loc(start: { index: number; page?: number; total?: number }, end?: { index: number; page?: number; total?: number }) {
  return {
    start: {
      index: start.index,
      displayed: start.page !== undefined ? { page: start.page, total: start.total ?? 20 } : undefined,
    },
    end: end
      ? {
          index: end.index,
          displayed: end.page !== undefined ? { page: end.page, total: end.total ?? 20 } : undefined,
        }
      : undefined,
  };
}

describe("turnCrossesSection：V-1 翻页是否跨章（闪白只在跨章清屏处）", () => {
  test("章中翻页不跨章（epubjs 只平移列，不清屏）", () => {
    expect(turnCrossesSection(loc({ index: 3, page: 5 }, { index: 3, page: 6 }), "next")).toBe(false);
    expect(turnCrossesSection(loc({ index: 3, page: 5 }), "prev")).toBe(false);
  });
  test("next 到章尾页才跨章", () => {
    expect(turnCrossesSection(loc({ index: 3, page: 20, total: 20 }, { index: 3, page: 20, total: 20 }), "next")).toBe(true);
    // 双栏跨章：end 已在下一章
    expect(turnCrossesSection(loc({ index: 3, page: 19 }, { index: 4, page: 20 }), "next")).toBe(true);
  });
  test("prev 在章首页跨章", () => {
    expect(turnCrossesSection(loc({ index: 3, page: 1 }), "prev")).toBe(true);
    expect(turnCrossesSection(loc({ index: 3, page: 2 }), "prev")).toBe(false);
  });
  test("位置未知按跨章兜底（多挂一次快照不闪白）", () => {
    expect(turnCrossesSection(undefined, "next")).toBe(true);
    expect(turnCrossesSection({ start: {} }, "prev")).toBe(true);
  });
});
