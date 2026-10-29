import { describe, expect, test } from "vitest";

import { formatReadingTime } from "./readingTime";

describe("E3 formatReadingTime", () => {
  test("不足 1 分钟返回 null（含 0/负数/小数截断）", () => {
    expect(formatReadingTime(0)).toBeNull();
    expect(formatReadingTime(59)).toBeNull();
    expect(formatReadingTime(-30)).toBeNull();
    expect(formatReadingTime(59.9)).toBeNull();
  });

  test("1 分钟起显示分钟", () => {
    expect(formatReadingTime(60)).toBe("1 分");
    expect(formatReadingTime(3599)).toBe("59 分");
  });

  test("满小时显示小时（整小时不带 0 分）", () => {
    expect(formatReadingTime(3600)).toBe("1 小时");
    expect(formatReadingTime(7200)).toBe("2 小时");
    expect(formatReadingTime(3660)).toBe("1 小时 1 分");
    expect(formatReadingTime(90000)).toBe("25 小时"); // 25h 整
    expect(formatReadingTime(12345)).toBe("3 小时 25 分");
  });
});
