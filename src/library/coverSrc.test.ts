// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import {
  getCoverLibraryRootForTests,
  persistentCoverSrc,
  primeCoverLibraryRoot,
} from "./coverSrc";

afterEach(() => {
  primeCoverLibraryRoot(null);
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function stubConvertFileSrc(map: (p: string) => string): void {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    convertFileSrc: map,
  };
}

describe("persistentCoverSrc（U-19 封面持久通道）", () => {
  test("相对 cover_path 拼预热库根 → convertFileSrc；反斜杠/首斜杠归一", () => {
    stubConvertFileSrc((p) => `http://asset.localhost/${encodeURIComponent(p)}`);
    primeCoverLibraryRoot("C:/Users/me/AppData/Roaming/com.root.bookreading/");
    expect(persistentCoverSrc("library/covers/b1.jpg")).toBe(
      `http://asset.localhost/${encodeURIComponent("C:/Users/me/AppData/Roaming/com.root.bookreading/library/covers/b1.jpg")}`,
    );
    expect(persistentCoverSrc("library\\covers\\b2.png")).toBe(
      `http://asset.localhost/${encodeURIComponent(
        "C:/Users/me/AppData/Roaming/com.root.bookreading/library/covers/b2.png",
      )}`,
    );
  });

  test("绝对路径封面（原地引用漫画）直接转换，不依赖库根", () => {
    stubConvertFileSrc((p) => `asset:${p}`);
    expect(persistentCoverSrc("F:\\comics\\cover.jpg")).toBe("asset:F:/comics/cover.jpg");
  });

  test("库根未预热 / 非 Tauri 环境 → null（回退 blob 通道）", () => {
    stubConvertFileSrc((p) => `asset:${p}`);
    primeCoverLibraryRoot(null);
    expect(persistentCoverSrc("library/covers/b1.jpg")).toBeNull();
    primeCoverLibraryRoot("C:/data");
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    expect(persistentCoverSrc("library/covers/b1.jpg")).toBeNull();
  });

  test("convertFileSrc 抛错不冒泡（通道损坏时静默回退）", () => {
    stubConvertFileSrc(() => {
      throw new Error("boom");
    });
    primeCoverLibraryRoot("C:/data");
    expect(persistentCoverSrc("library/covers/b1.jpg")).toBeNull();
    expect(getCoverLibraryRootForTests()).toBe("C:/data");
  });

  test("预热空串视作未设置", () => {
    primeCoverLibraryRoot("   ");
    expect(getCoverLibraryRootForTests()).toBeNull();
  });
});
