import { describe, expect, test } from "vitest";

import type { Book } from "../tauri/invoke";
import { filterTrash, viewKey } from "./LibraryPage";

describe("viewKey（F1-5 滚动记忆视图键）", () => {
  test("回收站 / 根书架 / 各书架互不串位", () => {
    expect(viewKey(true, null)).toBe("trash");
    // 回收站视图忽略书架参数（?trash=1&shelf=3 不存在该组合，防御）
    expect(viewKey(true, 3)).toBe("trash");
    expect(viewKey(false, null)).toBe("root");
    expect(viewKey(false, 3)).toBe("s3");
    expect(viewKey(false, 0)).toBe("s0");
  });

  test("不同书架键不同，同书架键稳定", () => {
    expect(viewKey(false, 3)).not.toBe(viewKey(false, 4));
    expect(viewKey(false, 3)).toBe(viewKey(false, 3));
  });
});

describe("filterTrash（T-4 回收站过滤=全选口径）", () => {
  const t = (id: string, title: string, author: string | null): Book =>
    ({ id, title, author, library_path: `library/${id}.epub` }) as Book;
  const list = [t("a", "白龙吟", "甲"), t("b", "三体", "乙"), t("c", "白夜行", null)];

  test("无搜索词返回全量（引用同数组）", () => {
    expect(filterTrash(list, "")).toBe(list);
    expect(filterTrash(list, "   ")).toBe(list);
  });

  test("按书名/作者过滤，大小写不敏感——全选即选中可见过滤集而非全库", () => {
    expect(filterTrash(list, "白").map((b) => b.id)).toEqual(["a", "c"]);
    expect(filterTrash(list, "乙").map((b) => b.id)).toEqual(["b"]);
    expect(filterTrash(list, "SAN TI").map((b) => b.id)).toEqual([]);
  });
});

