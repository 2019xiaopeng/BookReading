// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";

import { createPageSnapshot, foldCrease, foldSpec, playFold, smoothFold } from "./foldTurn";

describe("foldSpec：视觉方向 → 轴与终角", () => {
  test("单页：next=左轴右页向左翻（-180°），prev=右轴镜像（+180°）", () => {
    expect(foldSpec("next", false)).toEqual({ originX: "left", to: -180 });
    expect(foldSpec("prev", false)).toEqual({ originX: "right", to: 180 });
  });
  test("双页：中缝为轴，方向决定翻向", () => {
    expect(foldSpec("next", true)).toEqual({ originX: "center", to: -180 });
    expect(foldSpec("prev", true)).toEqual({ originX: "center", to: 180 });
  });
});

describe("折痕强度曲线", () => {
  test("0° 无 → 90° 最大 → 180° 消失", () => {
    expect(foldCrease(0)).toBeCloseTo(0);
    expect(foldCrease(0.5)).toBeCloseTo(1);
    expect(foldCrease(1)).toBeCloseTo(0);
    // 峰值两侧对称渐变
    expect(foldCrease(0.25)).toBeCloseTo(Math.sin(Math.PI * 0.25));
    expect(foldCrease(0.75)).toBeCloseTo(foldCrease(0.25));
  });
  test("smoothFold 端点归位且单调（起手缓、收尾缓）", () => {
    expect(smoothFold(0)).toBe(0);
    expect(smoothFold(1)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = smoothFold(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("playFold：rAF 折页与中断", () => {
  function stubFrames() {
    const rafs: FrameRequestCallback[] = [];
    let now = 0;
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafs.push(cb);
      return rafs.length;
    });
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    const tick = (ms: number) => {
      now += ms;
      rafs.splice(0).forEach((cb) => cb(now));
    };
    return {
      tick,
      restore: () => {
        rafSpy.mockRestore();
        cancelSpy.mockRestore();
        perfSpy.mockRestore();
      },
    };
  }

  test("自然结束：角度/折痕随帧插值，done 后 transform 复位", async () => {
    const f = stubFrames();
    try {
      const el = document.createElement("div");
      const h = playFold(el, { durationMs: 100, spec: foldSpec("next", false) });
      f.tick(50); // 半程：90°、折痕峰值
      expect(el.style.transform).toContain("rotateY(-90");
      expect(el.style.getPropertyValue("--fold-crease")).toBe("1.000");
      expect(el.style.transformOrigin).toBe("left center");
      expect(el.dataset.foldAxis).toBe("left");
      f.tick(50); // 终态
      await h.done;
      expect(el.style.transform).toBe("");
      expect(el.style.getPropertyValue("--fold-crease")).toBe("");
    } finally {
      f.restore();
    }
  });
  test("finish() 中断：立即 resolve 且终止 rAF 循环", async () => {
    const el = document.createElement("div");
    const h = playFold(el, { durationMs: 5000, spec: foldSpec("next", false) });
    const spy = vi.fn();
    void h.done.then(spy);
    h.finish();
    await Promise.resolve();
    expect(spy).toHaveBeenCalled();
    // 中断后 rAF 不再写帧
    const frozen = el.style.transform;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(el.style.transform).toBe(frozen);
    // 幂等：重复 finish 不抛错
    expect(() => h.finish()).not.toThrow();
  });
});

describe("createPageSnapshot：双缓冲覆盖层", () => {
  test("img 保持同 src、canvas 位图回填、结构克隆", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = document.createElement("div");
    host.appendChild(root);
    const inner = document.createElement("div");
    inner.className = "epub-container";
    root.appendChild(inner);
    const img = document.createElement("img");
    img.src = "blob:snapshot-test";
    inner.appendChild(img);
    // jsdom 无 canvas 实现：原型级 mock（createPageSnapshot 操作的是克隆出的 canvas）
    const drawImage = vi.fn();
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const canvas = document.createElement("canvas");
    canvas.width = 12;
    canvas.height = 8;
    inner.appendChild(canvas);

    try {
      const overlay = createPageSnapshot(root);
      expect(overlay).not.toBeNull();
      expect(overlay!.className).toBe("wr-fold-layer");
      expect(host.lastElementChild).toBe(overlay);
      expect(overlay!.querySelector("img")?.getAttribute("src")).toBe("blob:snapshot-test");
      const cloned = overlay!.querySelector("canvas");
      expect(cloned!.width).toBe(12);
      expect(cloned!.height).toBe(8);
      expect(drawImage).toHaveBeenCalledWith(canvas, 0, 0);
    } finally {
      getContextSpy.mockRestore();
      host.remove();
    }
  });

  test("iframe 文档整棵克隆（cloneNode 不复制内容，须 importNode 回填）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = document.createElement("div");
    host.appendChild(root);
    const inner = document.createElement("div");
    root.appendChild(inner);
    const frame = document.createElement("iframe");
    inner.appendChild(frame);
    const frameDoc = frame.contentDocument!;
    frameDoc.body.innerHTML = "<p>第 3 页正文</p>";

    try {
      const overlay = createPageSnapshot(root);
      const clonedFrame = overlay!.querySelector("iframe")!;
      expect(clonedFrame.contentDocument!.body.querySelector("p")?.textContent).toBe("第 3 页正文");
    } finally {
      host.remove();
    }
  });

  test("空容器/无宿主返回 null（首屏未渲染等场景安全跳过）", () => {
    expect(createPageSnapshot(null)).toBeNull();
    const empty = document.createElement("div");
    document.body.appendChild(empty);
    try {
      expect(createPageSnapshot(empty)).toBeNull();
    } finally {
      empty.remove();
    }
  });
});
