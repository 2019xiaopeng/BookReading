import { describe, expect, test } from "vitest";

import { baseFitSize, zoomAnchored } from "./ImageLightbox";

describe("zoomAnchored（P-1 光标锚点缩放）", () => {
  test("放大 1x→1.1x 后光标下内容点保持不动（视图中心坐标系）", () => {
    // 内容与视图同尺寸 800x600，锚点 (100, 50)：k 后 tx = px-(px-tx)*k
    const z = zoomAnchored({ scale: 1, tx: 0, ty: 0 }, 1.1, 100, 50, 800, 600, 800, 600);
    expect(z.scale).toBeCloseTo(1.1, 10);
    expect(z.tx).toBeCloseTo(-10, 10); // 100 - 100*1.1 = -10（内容超界前 panClamp 不拦）
    expect(z.ty).toBeCloseTo(-5, 10);
  });

  test("缩放钳在 0.5–4x（超界因子返回原状态）", () => {
    const at4 = { scale: 4, tx: 0, ty: 0 };
    expect(zoomAnchored(at4, 1.1, 0, 0, 800, 600, 800, 600)).toBe(at4);
    const at05 = { scale: 0.5, tx: 0, ty: 0 };
    expect(zoomAnchored(at05, 1 / 1.1, 0, 0, 800, 600, 800, 600)).toBe(at05);
  });

  test("panClamp 收口：内容缩放后小于视口的轴锁 0（居中）", () => {
    // 内容 200x150 缩到 2.2x 仍小于 800x600 视口：平移被钳回 0
    const z = zoomAnchored({ scale: 2, tx: 999, ty: 999 }, 1.1, 300, 200, 800, 600, 200, 150);
    expect(z.tx).toBe(0);
    expect(z.ty).toBe(0);
  });
});

describe("baseFitSize（基础适配尺寸）", () => {
  test("大图缩到视口内（取宽高比约束的较小侧），小图不放大", () => {
    expect(baseFitSize(1600, 800, 800, 600)).toEqual({ w: 800, h: 400 });
    expect(baseFitSize(800, 1600, 800, 600)).toEqual({ w: 300, h: 600 });
    expect(baseFitSize(100, 50, 800, 600)).toEqual({ w: 100, h: 50 });
  });

  test("非法尺寸回 0（不参与 panClamp，锁居中）", () => {
    expect(baseFitSize(0, 100, 800, 600)).toEqual({ w: 0, h: 0 });
    expect(baseFitSize(100, 100, 0, 0)).toEqual({ w: 0, h: 0 });
  });
});
