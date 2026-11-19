import { describe, expect, test } from "vitest";

import { viewKey } from "./LibraryPage";

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
