import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAppDataBlobUrl: vi.fn(),
  revokeObjectUrl: vi.fn(),
}));

vi.mock("../tauri/appDataPaths", () => ({
  readAppDataBlobUrl: mocks.readAppDataBlobUrl,
  revokeObjectUrl: mocks.revokeObjectUrl,
  extToMime: (e: string | null) => `mime/${e ?? "bin"}`,
}));

import { getBackgroundUrl, resetBackgroundCache } from "./appBackground";
import type { ReaderBackground } from "../reader/settings/types";

const IMAGE_A: ReaderBackground = { type: "image", path: "library/bg/a.png" };
const IMAGE_B: ReaderBackground = { type: "image", path: "library/bg/b.jpg" };
const PRESET: ReaderBackground = { type: "preset" };

describe("getBackgroundUrl single-slot cache", () => {
  beforeEach(() => {
    mocks.readAppDataBlobUrl.mockReset();
    mocks.revokeObjectUrl.mockReset();
  });

  test("loads an image and reuses the cache for the same path", async () => {
    mocks.readAppDataBlobUrl.mockResolvedValue("blob:a");
    expect(await getBackgroundUrl(IMAGE_A)).toBe("blob:a");
    expect(await getBackgroundUrl(IMAGE_A)).toBe("blob:a");
    expect(mocks.readAppDataBlobUrl).toHaveBeenCalledTimes(1);
    expect(mocks.revokeObjectUrl).not.toHaveBeenCalled();
  });

  test("swapping the image revokes exactly the previous url", async () => {
    mocks.readAppDataBlobUrl.mockResolvedValue("blob:b");
    expect(await getBackgroundUrl(IMAGE_A)).toBe("blob:a"); // cache hit from previous test
    expect(await getBackgroundUrl(IMAGE_B)).toBe("blob:b");
    expect(await getBackgroundUrl(IMAGE_B)).toBe("blob:b");
    expect(mocks.revokeObjectUrl).toHaveBeenCalledTimes(1);
    expect(mocks.revokeObjectUrl).toHaveBeenCalledWith("blob:a");
  });

  test("preset frees the resident url and is idempotent", async () => {
    expect(await getBackgroundUrl(PRESET)).toBeNull();
    expect(mocks.revokeObjectUrl).toHaveBeenCalledWith("blob:b");
    expect(await getBackgroundUrl(PRESET)).toBeNull();
    expect(mocks.revokeObjectUrl).toHaveBeenCalledTimes(1);
  });

  test("resetBackgroundCache forces a re-fetch when the path is unchanged (backend overwrites in place)", async () => {
    mocks.readAppDataBlobUrl.mockResolvedValueOnce("blob:a").mockResolvedValueOnce("blob:a2");
    expect(await getBackgroundUrl(IMAGE_A)).toBe("blob:a");
    resetBackgroundCache();
    expect(mocks.revokeObjectUrl).toHaveBeenCalledWith("blob:a");
    expect(await getBackgroundUrl(IMAGE_A)).toBe("blob:a2");
    expect(mocks.readAppDataBlobUrl).toHaveBeenCalledTimes(2); // 同路径也必须重新读取
  });
});
