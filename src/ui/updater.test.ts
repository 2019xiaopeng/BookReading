import { describe, expect, test } from "vitest";

// U 前端：asset 下载链接 → 发布页链接（打开发布页兜底入口）
import { releasePageFromAssetUrl } from "./updater";

describe("releasePageFromAssetUrl", () => {
  test("剥掉 /download/… 尾巴得到 releases 页", () => {
    expect(releasePageFromAssetUrl("https://github.com/o/r/releases/download/v2.7.0/bookreading-setup.exe")).toBe(
      "https://github.com/o/r/releases",
    );
  });

  test("无 download 段原样返回", () => {
    expect(releasePageFromAssetUrl("https://github.com/o/r/releases")).toBe("https://github.com/o/r/releases");
  });
});
