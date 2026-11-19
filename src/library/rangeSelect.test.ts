import { describe, expect, test } from "vitest";

import { applyRangeSelect } from "./rangeSelect";

const LIST = ["a", "b", "c", "d", "e"];

describe("applyRangeSelect（R-2 Shift 范围多选）", () => {
  test("普通点击=切换并更新锚点", () => {
    const r1 = applyRangeSelect(LIST, "b", new Set(), false, null);
    expect([...r1.selected]).toEqual(["b"]);
    expect(r1.lastId).toBe("b");
    const r2 = applyRangeSelect(LIST, "b", r1.selected, false, "b");
    expect(r2.selected.size).toBe(0);
    expect(r2.lastId).toBe("b");
  });

  test("Shift 闭区间全加入；锚点不动", () => {
    const r = applyRangeSelect(LIST, "d", new Set(["b"]), true, "b");
    expect([...r.selected]).toEqual(["b", "c", "d"]);
    expect(r.lastId).toBe("b");
  });

  test("Shift 反向（从后往前）同样闭区间", () => {
    const r = applyRangeSelect(LIST, "a", new Set(["d"]), true, "d");
    expect([...r.selected].sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("范围内已全选 → 全部移除；部分选中 → 补齐全选", () => {
    const off = applyRangeSelect(LIST, "d", new Set(["b", "c", "d"]), true, "b");
    expect(off.selected.size).toBe(0);
    const fill = applyRangeSelect(LIST, "d", new Set(["c"]), true, "b");
    expect([...fill.selected].sort()).toEqual(["b", "c", "d"]);
  });

  test("锚点缺失 / 锚点不在当前过滤列表 → 退化为普通切换", () => {
    const noAnchor = applyRangeSelect(LIST, "c", new Set(), true, null);
    expect([...noAnchor.selected]).toEqual(["c"]);
    expect(noAnchor.lastId).toBe("c");
    const crossFilter = applyRangeSelect(["x", "y"], "y", new Set(["a"]), true, "a");
    expect([...crossFilter.selected]).toEqual(["a", "y"]);
    expect(crossFilter.lastId).toBe("y");
  });

  test("相邻/同项/空列表边界", () => {
    const adj = applyRangeSelect(LIST, "c", new Set(["b"]), true, "b");
    expect([...adj.selected]).toEqual(["b", "c"]);
    const same = applyRangeSelect(LIST, "b", new Set(["b"]), true, "b");
    expect([...same.selected]).toEqual([]);
    const empty = applyRangeSelect([], "a", new Set(), false, null);
    expect([...empty.selected]).toEqual(["a"]);
  });

  test("不修改入参 selected（纯函数）", () => {
    const input = new Set(["b"]);
    applyRangeSelect(LIST, "e", input, true, "b");
    expect([...input]).toEqual(["b"]);
  });
});
