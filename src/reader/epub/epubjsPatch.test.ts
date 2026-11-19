import { describe, expect, test } from "vitest";

// 对补丁函数做配对语义测试（伪实例直接调 prototype 方法，不依赖模块单副本）
import { patchEpubjsBook } from "./epubjsPatch";

type AnyResources = {
  settings: { replacements?: string };
  urls: string[];
  createUrl(url: string): Promise<string>;
  replacementUrls: (string | null)[];
};

function makeResources(urls: string[], failIdx: number): AnyResources {
  return {
    settings: { replacements: "blobUrl" },
    urls,
    createUrl: (url: string) => {
      const i = urls.indexOf(url);
      if (i === failIdx) return Promise.reject(new Error("boom"));
      return Promise.resolve(`blob:${i}`);
    },
    replacementUrls: [],
  };
}

describe("epubjs replacementUrls 对齐补丁", () => {
  test("失败条目保留 null 占位：后续 index 不前移", async () => {
    const res = makeResources(["a.css", "logo.png", "note.png"], 0);
    const fakeBook = { resources: res };
    patchEpubjsBook(fakeBook);
    const proto = Object.getPrototypeOf(res) as unknown as {
      replacements: (this: AnyResources) => Promise<(string | null)[]>;
    };
    const out = await proto.replacements.call(res);
    expect(out).toEqual([null, "blob:1", "blob:2"]);
    expect(res.replacementUrls).toEqual([null, "blob:1", "blob:2"]);
  });

  test("无失败时与原行为等价", async () => {
    const res = makeResources(["a.css", "b.png"], -1);
    patchEpubjsBook({ resources: res });
    const proto = Object.getPrototypeOf(res) as unknown as {
      replacements: (this: AnyResources) => Promise<(string | null)[]>;
    };
    expect(await proto.replacements.call(res)).toEqual(["blob:0", "blob:1"]);
  });

  test("幂等：重复打补丁不叠加", () => {
    const res = makeResources(["a"], -1);
    patchEpubjsBook({ resources: res });
    patchEpubjsBook({ resources: res });
    expect((Object.getPrototypeOf(res) as { __wrAligned?: boolean }).__wrAligned).toBe(true);
  });

  test("空 book / 无 resources 安全跳过", () => {
    expect(() => patchEpubjsBook(null)).not.toThrow();
    expect(() => patchEpubjsBook({})).not.toThrow();
  });
});
