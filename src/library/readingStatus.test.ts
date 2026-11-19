import { describe, expect, test } from "vitest";

import type { Book } from "../tauri/invoke";
import { effectiveStatus, readingStatus } from "./readingStatus";

describe("readingStatus（S-3 新语义：打开过即在读）", () => {
  test("从未打开且无进度为未读", () => {
    expect(readingStatus(null, null)).toBe("unread");
    expect(readingStatus(0, null)).toBe("unread");
  });

  test("打开过但进度为 0 也算在读（刚开的书立即出现）", () => {
    expect(readingStatus(0, 1700000000)).toBe("reading");
    expect(readingStatus(null, 1)).toBe("reading");
  });

  test("0 < percent < 0.95 为在读（无论是否记录打开时间）", () => {
    expect(readingStatus(0.001, null)).toBe("reading");
    expect(readingStatus(0.25, 1700000000)).toBe("reading");
    expect(readingStatus(0.949, 1700000000)).toBe("reading");
  });

  test(">= 0.95 为已读（含 1）", () => {
    expect(readingStatus(0.95, null)).toBe("finished");
    expect(readingStatus(0.99, 1700000000)).toBe("finished");
    expect(readingStatus(1, null)).toBe("finished");
  });
});

describe("effectiveStatus（S-4/S-5 手动优先）", () => {
  const book = (partial: Partial<Pick<Book, "reading_percent" | "last_opened_at" | "manual_status">>) =>
    partial as Pick<Book, "reading_percent" | "last_opened_at" | "manual_status">;

  test("manual_status 优先，压过推导值（已读判定不因手动在读被 percent 顶掉）", () => {
    expect(effectiveStatus(book({ reading_percent: 0.96, last_opened_at: 1, manual_status: "reading" }))).toBe("reading");
    expect(effectiveStatus(book({ reading_percent: 0, last_opened_at: null, manual_status: "finished" }))).toBe("finished");
    expect(effectiveStatus(book({ reading_percent: 0.5, last_opened_at: 1, manual_status: "unread" }))).toBe("unread");
  });

  test("缺省走自动推导（openedAt + percent）", () => {
    expect(effectiveStatus(book({ reading_percent: 0, last_opened_at: null, manual_status: null }))).toBe("unread");
    expect(effectiveStatus(book({ reading_percent: 0, last_opened_at: 1, manual_status: undefined }))).toBe("reading");
    expect(effectiveStatus(book({ reading_percent: 0.97, last_opened_at: 1 }))).toBe("finished");
  });
});
