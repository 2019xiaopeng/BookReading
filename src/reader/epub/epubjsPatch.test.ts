import { describe, expect, test, vi } from "vitest";

// 对补丁函数做契约测试：伪实例直接调 prototype 方法，不依赖模块单副本
import { patchEpubjsBook } from "./epubjsPatch";

type Settings = { replacements?: string; resolver?: (url: string) => string };

/** 仿真 Archive.getBlob 的查找口径：先去掉开头的斜杠，再按压缩包内文件名找——传相对路径必然"找不到" */
class FakeResources {
  settings: Settings;
  urls: string[];
  replacementUrls: (string | null)[] = [];
  seen: string[] = [];

  constructor(
    /** 压缩包内真实文件名（不带开头斜杠） */
    readonly files: string[],
    failName?: string,
  ) {
    // manifest 里的 href 是相对路径（不带开头斜杠）；book.resolve 负责变成书内绝对路径
    this.urls = files.slice();
    this.settings = { replacements: "blobUrl", resolver: (href) => `/${href}` };
    this.createUrl = (url: string) => {
      this.seen.push(url);
      const name = url.startsWith("/") ? url.slice(1) : "";
      if (!name || !files.includes(name) || name === failName) {
        return Promise.reject(new Error("File not found in the epub: " + url));
      }
      return Promise.resolve(`blob:${name}`);
    };
  }

  createUrl(url: string): Promise<string> {
    return Promise.resolve(`blob:${url}`);
  }
}

async function runPatcheds(res: FakeResources) {
  const proto = Object.getPrototypeOf(res) as unknown as {
    replacements: (this: FakeResources) => Promise<(string | null)[]>;
  };
  return proto.replacements.call(res);
}

describe("epubjs replacementUrls 对齐补丁", () => {
  test("回归：createUrl 收到的是解析后的书内绝对路径（曾直接传 manifest 相对 href → 同一会话第二本书插图全破）", async () => {
    const files = ["OEBPS/Images/logo.jpg", "OEBPS/css/a.css", "OEBPS/Text/ch1.xhtml"];
    const first = new FakeResources(files);
    patchEpubjsBook({ resources: first });
    const second = new FakeResources(files); // 同一个类 → 同一个 prototype（补丁装在类上，从第二个实例起才生效）
    const out = await runPatcheds(second);
    expect(out).toEqual(["blob:OEBPS/Images/logo.jpg", "blob:OEBPS/css/a.css", "blob:OEBPS/Text/ch1.xhtml"]);
    expect(second.replacementUrls).toEqual(out);
    expect(second.seen).toEqual(["/OEBPS/Images/logo.jpg", "/OEBPS/css/a.css", "/OEBPS/Text/ch1.xhtml"]);
  });

  test("失败条目保留 null 占位：后续 index 不前移", async () => {
    const res = new FakeResources(["OEBPS/css/a.css", "OEBPS/Images/logo.png", "OEBPS/Images/note.png"], "OEBPS/css/a.css");
    patchEpubjsBook({ resources: res });
    expect(await runPatcheds(res)).toEqual([null, "blob:OEBPS/Images/logo.png", "blob:OEBPS/Images/note.png"]);
    expect(res.replacementUrls).toEqual([null, "blob:OEBPS/Images/logo.png", "blob:OEBPS/Images/note.png"]);
  });

  test("replacements=none：原样返回 url，不生成 blob", async () => {
    const res = new FakeResources(["OEBPS/css/a.css"]);
    res.settings.replacements = "none";
    patchEpubjsBook({ resources: res });
    expect(await runPatcheds(res)).toEqual(["OEBPS/css/a.css"]);
    expect(res.seen).toEqual([]);
  });

  test("幂等：重复打补丁不叠加", () => {
    const res = new FakeResources(["OEBPS/css/a.css"]);
    patchEpubjsBook({ resources: res });
    const patched = Object.getPrototypeOf(res).replacements;
    patchEpubjsBook({ resources: res });
    expect((Object.getPrototypeOf(res) as { __wrAligned?: boolean }).__wrAligned).toBe(true);
    expect(Object.getPrototypeOf(res).replacements).toBe(patched);
  });

  test("空 book / 无 resources 安全跳过", () => {
    expect(() => patchEpubjsBook(null)).not.toThrow();
    expect(() => patchEpubjsBook({})).not.toThrow();
  });
});

describe("epubjs blob 释放补丁（E1：关书时按值 revoke）", () => {
  /** vitest 的 node 环境里 URL 没有 revokeObjectURL：装一个可观察的替身，用完还原 */
  function stubRevoke() {
    const prev = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const fn = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { value: fn, writable: true, configurable: true });
    return {
      fn,
      restore: () => {
        if (prev) Object.defineProperty(URL, "revokeObjectURL", prev);
        else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      },
    };
  }

  class FakeArchive {
    urlCache: Record<string, string> = { "/OEBPS/images/a.jpg": "blob:a", "/OEBPS/fonts/f.woff": "blob:f" };
    destroyed = 0;
    destroy() {
      this.destroyed += 1;
      this.urlCache = {};
    }
  }
  class FakeBlobResources {
    replacementUrls: (string | null)[] | undefined = ["blob:a", null, "blob:css", "data:image/png;base64,xxxx"];
    destroyed = 0;
    destroy() {
      this.destroyed += 1;
      this.replacementUrls = undefined;
    }
  }

  test("两处 destroy 前按值 revoke：键 / null / 非 blob 地址不动，原 destroy 照常执行", () => {
    const { fn: revoke, restore } = stubRevoke();
    try {
      const archive = new FakeArchive();
      const resources = new FakeBlobResources();
      patchEpubjsBook({ archive, resources });
      archive.destroy();
      resources.destroy();
      expect(revoke.mock.calls.map((c) => c[0])).toEqual(["blob:a", "blob:f", "blob:a", "blob:css"]);
      expect(archive.destroyed).toBe(1);
      expect(resources.destroyed).toBe(1);
      expect(archive.urlCache).toEqual({});
      expect(resources.replacementUrls).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("幂等：重复打补丁不叠加，原 destroy 只执行一次", () => {
    const { fn: revoke, restore } = stubRevoke();
    try {
      const archive = new FakeArchive();
      patchEpubjsBook({ archive });
      patchEpubjsBook({ archive });
      archive.destroy();
      expect(archive.destroyed).toBe(1);
      expect(revoke).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  test("类上没有 destroy：安全跳过，不往 Object.prototype 上写标记", () => {
    patchEpubjsBook({ archive: { destroy: undefined } });
    expect((Object.prototype as { __wrRevoke?: boolean }).__wrRevoke).toBeUndefined();
  });
});
