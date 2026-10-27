import { describe, expect, test } from "vitest";

import { readingStatus } from "./readingStatus";

describe("readingStatus", () => {
  test("null 或 0 为未读", () => {
    expect(readingStatus(null)).toBe("unread");
    expect(readingStatus(0)).toBe("unread");
  });

  test("0 < percent < 0.95 为在读", () => {
    expect(readingStatus(0.001)).toBe("reading");
    expect(readingStatus(0.25)).toBe("reading");
    expect(readingStatus(0.949)).toBe("reading");
  });

  test(">= 0.95 为已读（含 1）", () => {
    expect(readingStatus(0.95)).toBe("finished");
    expect(readingStatus(0.99)).toBe("finished");
    expect(readingStatus(1)).toBe("finished");
  });
});
