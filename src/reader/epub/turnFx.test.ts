import { describe, expect, test } from "vitest";

import type { PageAnimation } from "../settings/types";
import {
  TURN_EFFECT_MS,
  TURN_FX_ENABLED,
  effectivePageAnimation,
  turnFrame,
  visiblePageAnimations,
} from "./turnFx";

describe("翻页矩阵总开关 TURN_FX_ENABLED（v3.1.9 发版态=关）", () => {
  const ALL: PageAnimation[] = ["none", "slide", "cover", "fade", "paper"];

  test("关闭：选项恢复 v3.1.8 的三项与文案；已存的 cover / paper 按渐隐生效（下拉显示与实际翻页一致）", () => {
    if (TURN_FX_ENABLED) return;
    expect(visiblePageAnimations()).toEqual([
      { value: "none", label: "无" },
      { value: "fade", label: "淡入淡出" },
      { value: "slide", label: "滑动" },
    ]);
    expect(effectivePageAnimation("cover")).toBe("fade");
    expect(effectivePageAnimation("paper")).toBe("fade");
    expect(effectivePageAnimation("slide")).toBe("slide");
    expect(effectivePageAnimation("none")).toBe("none");
  });

  test("打开：五项齐全、存储值原样生效", () => {
    if (!TURN_FX_ENABLED) return;
    expect(visiblePageAnimations().map((o) => o.value)).toEqual(ALL);
    for (const a of ALL) expect(effectivePageAnimation(a)).toBe(a);
  });

  test("无论开关如何：每个存储值的生效值都在可见选项里（两处设置面板的下拉不会显示空白）", () => {
    const visible = visiblePageAnimations().map((o) => o.value);
    for (const a of ALL) expect(visible).toContain(effectivePageAnimation(a));
  });
});

const W = 1000;
const H = 800;

describe("turnFrame: slide（平移）", () => {
  test("t=0 新页在页外、旧页归位", () => {
    const f = turnFrame("slide", 1, 0, W, H);
    expect(f.oldTransform).toBe("translateX(0.00px)");
    expect(f.newTransform).toBe("translateX(1000.00px)");
  });
  test("t=1 旧页移出、新页归位", () => {
    const f = turnFrame("slide", 1, 1, W, H);
    expect(f.oldTransform).toBe("translateX(-1000.00px)");
    expect(f.newTransform).toBe("translateX(0.00px)");
  });
  test("后退方向镜像", () => {
    const f = turnFrame("slide", -1, 0.5, W, H);
    expect(f.oldTransform).toBe("translateX(500.00px)");
    expect(f.newTransform).toBe("translateX(-500.00px)");
  });
});

describe("turnFrame: cover（覆盖）", () => {
  test("旧叶恒静止，新叶自边缘滑入", () => {
    const f = turnFrame("cover", 1, 0.5, W, H);
    expect(f.oldTransform).toBe("");
    expect(f.newTransform).toBe("translateX(500.00px)");
  });
  test("前缘阴影带宽=min(22px, 5.5%w)·包络，峰值在中段出现、两端消失", () => {
    const mid = turnFrame("cover", 1, 0.5, W, H);
    expect(mid.underShadow?.width).toBeCloseTo(22, 5);
    expect(turnFrame("cover", 1, 0, W, H).underShadow).toBeNull();
    expect(turnFrame("cover", 1, 1, W, H).underShadow).toBeNull();
  });
  test("前进阴影带贴新叶前缘左侧", () => {
    const f = turnFrame("cover", 1, 0.5, W, H);
    expect(f.underShadow?.x).toBeCloseTo(500 - 22, 5);
    expect(f.underShadow?.toRight).toBe(true);
  });
});

describe("turnFrame: fade（渐隐）", () => {
  test("交叉淡化：旧 1-t / 新 t，恒等位移不裁剪", () => {
    const f = turnFrame("fade", 1, 0.25, W, H);
    expect(f.oldOpacity).toBeCloseTo(0.75);
    expect(f.newOpacity).toBeCloseTo(0.25);
    expect(f.oldTransform).toBe("");
    expect(f.oldClip).toBe("");
  });
});

describe("turnFrame: paper（纸页翻动）", () => {
  test("前进：折痕自右缘(=w)扫向左缘(=0)", () => {
    expect(turnFrame("paper", 1, 0, W, H).oldClip).toContain("M 1000.00 0");
    expect(turnFrame("paper", 1, 1, W, H).oldClip).toContain("M 0.00 0");
  });
  test("折痕中段有高光条与阴影带，两端消失", () => {
    const mid = turnFrame("paper", 1, 0.5, W, H);
    expect(mid.fold).not.toBeNull();
    expect(mid.fold?.width).toBeCloseTo(Math.min(28, W * 0.065), 5);
    expect(mid.creaseShadow?.width).toBeGreaterThan(50);
    expect(turnFrame("paper", 1, 0, W, H).fold).toBeNull();
    expect(turnFrame("paper", 1, 1, W, H).fold).toBeNull();
  });
  test("弧形 clip 含三次贝塞尔控制点（弯曲折痕而非直线）", () => {
    const f = turnFrame("paper", 1, 0.5, W, H);
    expect(f.oldClip).toMatch(/C \d+\.\d+ 200\.00, \d+\.\d+ 600\.00/);
  });
});

describe("TURN_EFFECT_MS", () => {
  test("四效果齐且为正", () => {
    expect(Object.keys(TURN_EFFECT_MS).sort()).toEqual(["cover", "fade", "paper", "slide"]);
    for (const v of Object.values(TURN_EFFECT_MS)) expect(v).toBeGreaterThan(0);
  });
});
