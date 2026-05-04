import { describe, expect, test } from "vitest";

import { shouldIgnoreWindowErrorMessage } from "./frontendLogFilters";

describe("frontendLogFilters", () => {
  test("ignores ResizeObserver loop errors", () => {
    expect(shouldIgnoreWindowErrorMessage("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(shouldIgnoreWindowErrorMessage("ResizeObserver loop limit exceeded")).toBe(true);
  });

  test("does not ignore ordinary errors", () => {
    expect(shouldIgnoreWindowErrorMessage("EPUB 打开失败：xxx")).toBe(false);
  });
});

