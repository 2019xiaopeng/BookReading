import { describe, expect, test } from "vitest";

import type { Shelf } from "../tauri/invoke";
import { logicalBackTarget } from "./useLogicalBack";

const sh = (id: number, parent_id: number | null): Shelf => ({
  id,
  name: `s${id}`,
  parent_id,
  sort_order: id,
  created_at: 0,
});

// 树：1 根 → 2 → 3；4 独立根级
const SHELVES = [sh(1, null), sh(2, 1), sh(3, 2), sh(4, null)];

describe("logicalBackTarget（M-3 侧键逻辑回溯目标）", () => {
  test("阅读页：有 fromShelf → 来源书架；无 state → 书库根", () => {
    expect(logicalBackTarget("/read/b1", "", SHELVES, { fromShelf: 3 })).toBe("/?shelf=3");
    expect(logicalBackTarget("/read/b1", "?cfi=x", SHELVES, null)).toBe("/");
    expect(logicalBackTarget("/read/b1", "", SHELVES, { fromShelf: null })).toBe("/");
  });

  test("书库：子架 → 父架；根级架/根视图 → 无操作", () => {
    expect(logicalBackTarget("/", "?shelf=3", SHELVES, null)).toBe("/?shelf=2");
    expect(logicalBackTarget("/", "?shelf=2", SHELVES, null)).toBe("/?shelf=1");
    expect(logicalBackTarget("/", "?shelf=4", SHELVES, null)).toBeNull();
    expect(logicalBackTarget("/", "", SHELVES, null)).toBeNull();
    // 已删除的架（树里查无此 id）→ 无操作，交给 LibraryPage 悬空回根纠偏
    expect(logicalBackTarget("/", "?shelf=99", SHELVES, null)).toBeNull();
  });

  test("收藏 / 回收站 → 书库根；其它路径无操作", () => {
    expect(logicalBackTarget("/favorites", "", SHELVES, null)).toBe("/");
    expect(logicalBackTarget("/", "?trash=1", SHELVES, null)).toBe("/");
    expect(logicalBackTarget("/favorites", "?x=1", SHELVES, null)).toBe("/");
    expect(logicalBackTarget("/whatever", "", SHELVES, null)).toBeNull();
  });
});
