import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { readAppDataBlobUrlMock } = vi.hoisted(() => ({ readAppDataBlobUrlMock: vi.fn() }));

vi.mock("../tauri/appDataPaths", () => ({
  readAppDataBlobUrl: readAppDataBlobUrlMock,
  extToMime: (ext: string | null) => `mime/${ext ?? "bin"}`,
}));

vi.mock("../tauri/frontendLog", () => ({ logFrontend: vi.fn() }));

import { COVER_MAX_ATTEMPTS, coverRetryDelayMs, getCoverUrl, requestCoverUrl } from "./useCoverUrls";

describe("coverRetryDelayMs", () => {
  test("backoff is 200/400/800", () => {
    expect(coverRetryDelayMs(1)).toBe(200);
    expect(coverRetryDelayMs(2)).toBe(400);
    expect(coverRetryDelayMs(3)).toBe(800);
  });
});

describe("requestCoverUrl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readAppDataBlobUrlMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("caches on success and dedupes repeat requests", async () => {
    readAppDataBlobUrlMock.mockResolvedValue("blob:ok");
    requestCoverUrl("library/covers/ok.jpg");
    await vi.advanceTimersByTimeAsync(0);
    requestCoverUrl("library/covers/ok.jpg");
    await vi.advanceTimersByTimeAsync(0);
    expect(readAppDataBlobUrlMock).toHaveBeenCalledTimes(1);
    expect(getCoverUrl("library/covers/ok.jpg")).toBe("blob:ok");
  });

  test("retries with backoff after failure then resets attempts on success", async () => {
    readAppDataBlobUrlMock.mockRejectedValueOnce(new Error("io")).mockResolvedValue("blob:retry");
    requestCoverUrl("library/covers/retry.jpg");
    await vi.advanceTimersByTimeAsync(0);
    expect(getCoverUrl("library/covers/retry.jpg")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(readAppDataBlobUrlMock).toHaveBeenCalledTimes(2);
    expect(getCoverUrl("library/covers/retry.jpg")).toBe("blob:retry");
  });

  test("gives up after COVER_MAX_ATTEMPTS failures", async () => {
    readAppDataBlobUrlMock.mockRejectedValue(new Error("io"));
    requestCoverUrl("library/covers/dead.jpg");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    expect(readAppDataBlobUrlMock).toHaveBeenCalledTimes(COVER_MAX_ATTEMPTS);
    await vi.advanceTimersByTimeAsync(800);
    expect(readAppDataBlobUrlMock).toHaveBeenCalledTimes(COVER_MAX_ATTEMPTS);
    expect(getCoverUrl("library/covers/dead.jpg")).toBeUndefined();
  });
});
