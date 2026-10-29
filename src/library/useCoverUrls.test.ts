import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { readAppDataBlobUrlMock, revokeObjectUrlMock } = vi.hoisted(() => ({
  readAppDataBlobUrlMock: vi.fn(),
  revokeObjectUrlMock: vi.fn(),
}));

vi.mock("../tauri/appDataPaths", () => ({
  readAppDataBlobUrl: readAppDataBlobUrlMock,
  revokeObjectUrl: revokeObjectUrlMock,
  extToMime: (ext: string | null) => `mime/${ext ?? "bin"}`,
}));

vi.mock("../tauri/frontendLog", () => ({ logFrontend: vi.fn() }));

import {
  COVER_MAX_ATTEMPTS,
  NOTIFY_COALESCE_MS,
  coverRetryDelayMs,
  coverThumbCandidates,
  getCoverUrl,
  invalidateCoverUrl,
  requestCoverUrl,
  seedCoverUrls,
  subscribeCoverNotifications,
} from "./useCoverUrls";
import { MAX_CONCURRENT_COVER_LOADS } from "./coverScheduler";

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
    revokeObjectUrlMock.mockClear();
  });

  afterEach(async () => {
    // 冲掉 pending 通知/重试定时器，避免模块级 notifyTimer 残留跨用例
    await vi.advanceTimersByTimeAsync(1000);
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

  test("invalidateCoverUrl revokes the blob, clears the cache and forces a re-fetch", async () => {
    readAppDataBlobUrlMock.mockResolvedValue("blob:c1");
    requestCoverUrl("library/covers/c.jpg");
    await vi.advanceTimersByTimeAsync(0);
    expect(getCoverUrl("library/covers/c.jpg")).toBe("blob:c1");

    invalidateCoverUrl("library/covers/c.jpg");
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:c1");
    expect(getCoverUrl("library/covers/c.jpg")).toBeUndefined();

    readAppDataBlobUrlMock.mockResolvedValue("blob:c2");
    requestCoverUrl("library/covers/c.jpg");
    await vi.advanceTimersByTimeAsync(0);
    expect(readAppDataBlobUrlMock).toHaveBeenCalledTimes(2);
    expect(getCoverUrl("library/covers/c.jpg")).toBe("blob:c2");
  });

  test("requests thumb candidates (.jpg then .webp) when id is provided, falls back to the original path", async () => {
    readAppDataBlobUrlMock.mockImplementation((p: string) =>
      p.includes("/thumbs/") ? Promise.reject(new Error("missing")) : Promise.resolve("blob:full"),
    );
    requestCoverUrl("library/covers/b7.jpg", { id: "b7" });
    await vi.advanceTimersByTimeAsync(0);
    expect(readAppDataBlobUrlMock.mock.calls[0]).toEqual([coverThumbCandidates("b7")[0], "image/jpeg"]);
    expect(readAppDataBlobUrlMock.mock.calls[1]).toEqual([coverThumbCandidates("b7")[1], "image/webp"]);
    expect(readAppDataBlobUrlMock.mock.calls[2]).toEqual(["library/covers/b7.jpg", "mime/jpg"]);
    expect(getCoverUrl("library/covers/b7.jpg")).toBe("blob:full");
  });

  test("uses the first existing thumb candidate and stops probing", async () => {
    readAppDataBlobUrlMock.mockImplementation((p: string) =>
      Promise.resolve(p.endsWith(".webp") ? "blob:thumb-w" : "blob:thumb-j"),
    );
    requestCoverUrl("library/covers/b8.png", { id: "b8" });
    await vi.advanceTimersByTimeAsync(0);
    expect(readAppDataBlobUrlMock).toHaveBeenCalledTimes(1);
    expect(getCoverUrl("library/covers/b8.png")).toBe("blob:thumb-j");

    readAppDataBlobUrlMock.mockImplementation((p: string) =>
      p.includes("/thumbs/") && p.endsWith(".jpg")
        ? Promise.reject(new Error("missing"))
        : Promise.resolve("blob:thumb-w"),
    );
    requestCoverUrl("library/covers/b9.png", { id: "b9" });
    await vi.advanceTimersByTimeAsync(0);
    const callsB9 = readAppDataBlobUrlMock.mock.calls.filter((c) => c[0].includes("b9"));
    expect(callsB9[callsB9.length - 1]).toEqual([coverThumbCandidates("b9")[1], "image/webp"]);
    expect(getCoverUrl("library/covers/b9.png")).toBe("blob:thumb-w");
  });

  test(`caps concurrent fetches at ${MAX_CONCURRENT_COVER_LOADS} and starts the next when one settles`, async () => {
    const resolvers: Array<(v: string) => void> = [];
    readAppDataBlobUrlMock.mockImplementation(() => new Promise<string>((res) => resolvers.push(res)));
    for (let i = 0; i < 8; i++) requestCoverUrl(`library/covers/cap${i}.jpg`);
    expect(readAppDataBlobUrlMock).toHaveBeenCalledTimes(MAX_CONCURRENT_COVER_LOADS);
    resolvers.shift()!("blob:cap0");
    await vi.advanceTimersByTimeAsync(0);
    expect(readAppDataBlobUrlMock).toHaveBeenCalledTimes(MAX_CONCURRENT_COVER_LOADS + 1);
    // 排空剩余请求，避免 in-flight 泄漏到后续用例
    for (let guard = 0; guard < 12 && resolvers.length > 0; guard++) {
      for (const res of resolvers.splice(0)) res("blob:drain");
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(resolvers.length).toBe(0);
  });

  test("coalesces notifications within the window into one flush", async () => {
    const received: string[] = [];
    const unsub = subscribeCoverNotifications((p) => received.push(p));
    readAppDataBlobUrlMock.mockResolvedValue("blob:n");
    requestCoverUrl("library/covers/n1.jpg");
    requestCoverUrl("library/covers/n2.jpg");
    await vi.advanceTimersByTimeAsync(0); // 两张 IPC 都已完成，各自 notify 已入窗
    expect(received).toEqual([]); // 未到合帧窗口不广播
    await vi.advanceTimersByTimeAsync(NOTIFY_COALESCE_MS);
    expect([...received].sort()).toEqual(["library/covers/n1.jpg", "library/covers/n2.jpg"]);
    // 窗口外的新到达进入下一个窗口
    requestCoverUrl("library/covers/n3.jpg");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(NOTIFY_COALESCE_MS);
    expect(received).toHaveLength(3);
    unsub();
  });

  test("seedCoverUrls seeds initial state from the module cache", async () => {
    readAppDataBlobUrlMock.mockResolvedValue("blob:seed");
    requestCoverUrl("library/covers/seed.jpg");
    await vi.advanceTimersByTimeAsync(0);
    expect(
      seedCoverUrls([{ cover_path: "library/covers/seed.jpg" }, { cover_path: "library/covers/none.jpg" }]),
    ).toEqual({ "library/covers/seed.jpg": "blob:seed" });
  });
});
