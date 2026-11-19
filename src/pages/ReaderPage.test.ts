import { describe, expect, test } from "vitest";

import { bigEpubGuard } from "./ReaderPage";

describe("bigEpubGuard（B-2 大书守卫判据）", () => {
  test(">64MB 的库内 EPUB 触发；64MB 整、非 .epub、路径大小写不触发", () => {
    expect(bigEpubGuard(64_000_001, "library/epub/abc.epub")).toBe(true);
    expect(bigEpubGuard(169_000_000, "library/epub/极品家丁.epub")).toBe(true);
    expect(bigEpubGuard(64_000_000, "library/epub/abc.epub")).toBe(false);
    expect(bigEpubGuard(169_000_000, "library/images/abc")).toBe(false);
    expect(bigEpubGuard(169_000_000, "library/epub/ABC.EPUB")).toBe(false); // 与 reader.ts 探测同口径（仅小写）
  });

  test("null/未知大小不触发（缺数据宁走正常路径）", () => {
    expect(bigEpubGuard(null, "library/epub/abc.epub")).toBe(false);
    expect(bigEpubGuard(undefined as unknown as null, "library/epub/abc.epub")).toBe(false);
  });
});
