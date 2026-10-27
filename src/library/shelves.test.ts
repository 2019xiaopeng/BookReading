import { describe, expect, test } from "vitest";

import type { Shelf } from "../tauri/invoke";
import {
  countByShelf,
  descendantIds,
  shelfPath,
  shelfTreeRows,
  sortShelves,
  trashRemainingDays,
} from "./shelves";

function s(id: number, name: string, parentId: number | null, sortOrder = 0): Shelf {
  return { id, name, parent_id: parentId, sort_order: sortOrder, created_at: 0 };
}

describe("sortShelves", () => {
  test("sort_order first, then name for stable display", () => {
    const out = sortShelves([s(1, "乙", null), s(2, "甲", null), s(3, "丙", null, -1)]);
    expect(out.map((x) => x.name)).toEqual(["丙", "甲", "乙"]);
  });
});

describe("shelfPath", () => {
  const shelves = [s(1, "A", null), s(2, "B", 1), s(3, "C", 2)];

  test("root is empty chain", () => {
    expect(shelfPath(shelves, null)).toEqual([]);
  });

  test("walks ancestors root-first", () => {
    expect(shelfPath(shelves, 3).map((x) => x.name)).toEqual(["A", "B", "C"]);
  });

  test("unknown id degrades to root", () => {
    expect(shelfPath(shelves, 99)).toEqual([]);
  });
});

describe("shelfTreeRows", () => {
  test("depth-first order with depth for indentation", () => {
    const shelves = [s(1, "A", null), s(2, "B", null), s(3, "A1", 1), s(4, "A1a", 3)];
    const rows = shelfTreeRows(shelves);
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ["A", 0],
      ["A1", 1],
      ["A1a", 2],
      ["B", 0],
    ]);
  });
});

describe("descendantIds", () => {
  test("collects full subtree excluding self", () => {
    const shelves = [s(1, "A", null), s(2, "B", 1), s(3, "C", 2), s(4, "D", null)];
    expect(descendantIds(shelves, 1)).toEqual(new Set([2, 3]));
    expect(descendantIds(shelves, 4)).toEqual(new Set());
  });
});

describe("countByShelf", () => {
  test("counts books per shelf id, root books skipped", () => {
    const m = countByShelf([
      { shelf_id: 1 } as never,
      { shelf_id: 1 } as never,
      { shelf_id: 2 } as never,
      { shelf_id: null } as never,
    ]);
    expect(m.get(1)).toBe(2);
    expect(m.get(2)).toBe(1);
    expect(m.size).toBe(2);
  });
});

describe("trashRemainingDays", () => {
  const now = 1_000_000_000;

  test("never for retention 0", () => {
    expect(trashRemainingDays(now - 100 * 86400, 0, now)).toBeNull();
  });

  test("elapsed days subtracted, floored, clamped at 0", () => {
    expect(trashRemainingDays(now - 86400 * 3, 30, now)).toBe(27);
    // 3 天又 1 小时仍算 3 整天（floor），不会多扣
    expect(trashRemainingDays(now - 86400 * 3 - 3600, 30, now)).toBe(27);
    expect(trashRemainingDays(now - 86400 * 4, 30, now)).toBe(26);
    expect(trashRemainingDays(now - 86400 * 99, 30, now)).toBe(0);
  });
});
