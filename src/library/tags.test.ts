import { describe, expect, test } from "vitest";

import { formatFileSize, tagDotColor } from "./tags";

describe("formatFileSize", () => {
  test("null 显示占位符", () => {
    expect(formatFileSize(null)).toBe("—");
  });

  test("B/KB/MB 边界", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
    expect(formatFileSize(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
  });
});

describe("tagDotColor", () => {
  test("预设色直传，null 落主题强调色", () => {
    expect(tagDotColor("#1971c2")).toBe("#1971c2");
    expect(tagDotColor(null)).toBe("var(--wr-accent)");
  });
});
