import { describe, expect, test } from "vitest";

import type { Book, Shelf } from "../tauri/invoke";
import {
  countByShelf,
  countByShelfDeep,
  descendantIds,
  filterShelvesBySearch,
  firstBooksByShelf,
  shelfPath,
  shelfTreeRows,
  sortShelves,
  trashRemainingDays,
} from "./shelves";

function s(id: number, name: string, parentId: number | null, sortOrder = 0): Shelf {
  return { id, name, parent_id: parentId, sort_order: sortOrder, created_at: 0 };
}

const bk = (id: string, shelfId: number | null, extra?: Partial<Book>): Book =>
  ({ id, shelf_id: shelfId, title: id, library_path: `library/${id}.epub`, ...extra }) as Book;

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

describe("countByShelfDeep（K-3 含子孙递归计数）", () => {
  // 树：A ← B ← C；D 独立
  const shelves = [s(1, "A", null), s(2, "B", 1), s(3, "C", 2), s(4, "D", null)];
  const books = [bk("a", 1), bk("b", 2), bk("c", 3), bk("d", 4), bk("root", null)];

  test("祖先链各记一次：A=3（直属+后代）、B=2、C=1；根书不入任何架", () => {
    const m = countByShelfDeep(shelves, books);
    expect(m.get(1)).toBe(3);
    expect(m.get(2)).toBe(2);
    expect(m.get(3)).toBe(1);
    expect(m.get(4)).toBe(1);
    expect(m.size).toBe(4);
  });

  test("直属口径（countByShelf）不含后代，供 +N 徽章对照", () => {
    const m = countByShelf(books);
    expect(m.get(1)).toBe(1);
    expect(m.get(2)).toBe(1);
  });
});

describe("filterShelvesBySearch（W-1 搜索×文件夹）", () => {
  // 树：漫画(1) ← yuuhui玉汇(2)；小说(3)
  const shelves = [s(1, "漫画", null), s(2, "yuuhui玉汇", 1), s(3, "小说", null)];
  const books = [
    bk("白龙吟", 2, { title: "白龙吟", author: "甲" }),
    bk("三体", 3, { title: "三体", author: "乙" }),
  ];

  test("无搜索词全保留 hits=0", () => {
    const out = filterShelvesBySearch(shelves, null, books, "");
    expect(out.map((e) => [e.shelf.name, e.hits])).toEqual([
      ["漫画", 0],
      ["小说", 0],
    ]);
  });

  test("子树有命中书：祖先保留（hits 计子树全部命中），无命中的架隐藏", () => {
    const out = filterShelvesBySearch(shelves, null, books, "白龙吟");
    expect(out.map((e) => [e.shelf.name, e.hits])).toEqual([["漫画", 1]]);
  });

  test("架名匹配：本架保留；嵌套架名命中时祖先链保留（根视图可达），命中判定与书卡同口径", () => {
    // 根视图搜“玉汇”：yuuhui玉汇 非根直属，靠祖先“漫画”保留路径（hits=0 无角标）
    const atRoot = filterShelvesBySearch(shelves, null, books, "玉汇");
    expect(atRoot.map((e) => [e.shelf.name, e.hits])).toEqual([["漫画", 0]]);
    // 漫画视图内：yuuhui玉汇 本架名命中
    const inside = filterShelvesBySearch(shelves, 1, books, "玉汇");
    expect(inside.map((e) => [e.shelf.name, e.hits])).toEqual([["yuuhui玉汇", 0]]);
    const byAuthor = filterShelvesBySearch(shelves, null, books, "乙");
    expect(byAuthor.map((e) => [e.shelf.name, e.hits])).toEqual([["小说", 1]]);
  });

  test("只在当前层的子架中过滤（parentId）", () => {
    const out = filterShelvesBySearch(shelves, 1, books, "白龙吟");
    expect(out.map((e) => e.shelf.name)).toEqual(["yuuhui玉汇"]);
  });
});

describe("firstBooksByShelf", () => {
  test("fixed first 4 per shelf in library order, root books skipped", () => {
    const m = firstBooksByShelf([
      bk("a", 1),
      bk("b", 2),
      bk("c", 1),
      bk("d", 1),
      bk("e", 1),
      bk("f", 1), // 第 5 本，不入架 1 的四宫格
      bk("g", null),
      bk("h", 1),
    ]);
    // 选择与封面加载状态无关：固定 a/c/d/e，不随到达顺序洗牌
    expect(m.get(1)!.map((b) => b.id)).toEqual(["a", "c", "d", "e"]);
    expect(m.get(2)!.map((b) => b.id)).toEqual(["b"]);
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
