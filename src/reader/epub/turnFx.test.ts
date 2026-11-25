import { describe, expect, test } from "vitest";

import type { PageAnimation } from "../settings/types";
import { TURN_EFFECT_MS, TURN_FX_ENABLED, createTurnQueue, effectivePageAnimation, turnKeyframes, visiblePageAnimations } from "./turnFx";

describe("翻页矩阵总开关 TURN_FX_ENABLED", () => {
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

  test("每种效果都有正的基准时长", () => {
    for (const ms of Object.values(TURN_EFFECT_MS)) expect(ms).toBeGreaterThan(0);
  });
});

// 关键帧 = 属性名到值的索引对象（WAAPI Keyframe）
type F = { offset?: number | null; [k: string]: string | number | null | undefined };
const kf = (frames: Keyframe[]) => frames as F[];
const at = (frames: Keyframe[], t: number) => kf(frames).find((f) => f.offset === t)!;
const nums = (v: unknown) => String(v).match(/-?\d+(\.\d+)?/g)!.map(Number);
const SAMPLES = 17;

const W = 760;
const H = 600;
const O = { dark: false, paperColor: "#fbfaf7" };

describe("turnKeyframes: slide（平移）", () => {
  test("新页自页外滑入，旧页同步滑出，两者始终首尾相接", () => {
    const k = turnKeyframes("slide", 1, W, H, O);
    expect(k.new).toEqual([{ transform: "translateX(760.00px)" }, { transform: "translateX(0px)" }]);
    expect(k.old).toEqual([{ transform: "translateX(0px)" }, { transform: "translateX(-760.00px)" }]);
    expect(k.bands).toEqual([]);
  });
  test("后退镜像：新页自左入", () => {
    const k = turnKeyframes("slide", -1, W, H, O);
    expect(k.new[0]).toEqual({ transform: "translateX(-760.00px)" });
    expect(k.old[1]).toEqual({ transform: "translateX(760.00px)" });
  });
});

describe("turnKeyframes: cover（覆盖）", () => {
  test("新页滑入压住旧页；旧页不动，被压住的部分同步裁掉（叶片底色半透明，不裁会透出新页文字）", () => {
    const k = turnKeyframes("cover", 1, W, H, O);
    expect(k.new[0]).toEqual({ transform: "translateX(760.00px)" });
    expect(k.old).toEqual([{ clipPath: "inset(0px)" }, { clipPath: "inset(0px 100% 0px 0px)" }]);
    const back = turnKeyframes("cover", -1, W, H, O);
    expect(back.old[1]).toEqual({ clipPath: "inset(0px 0px 0px 100%)" });
  });
  test("前缘软阴影：宽 min(22px, 5.5%w)、只贴在新页前缘后侧，强弱走 sin 包络（两端为 0）", () => {
    const k = turnKeyframes("cover", 1, W, H, O);
    expect(k.bands).toHaveLength(1);
    const band = k.bands[0];
    const width = Math.min(22, W * 0.055);
    expect(band.css).toContain(`left:${(W - width).toFixed(2)}px;width:${width.toFixed(2)}px`);
    expect(band.css).toContain("rgba(0,0,0,0.16)");
    expect(at(band.frames, 0)!.opacity).toBeCloseTo(0, 10);
    expect(at(band.frames, 0.5)!.opacity).toBeCloseTo(1, 10);
    expect(at(band.frames, 1)!.opacity).toBeCloseTo(0, 10);
    // 阴影条始终贴着前缘：t=1 时随新页一起移出页外
    expect(at(band.frames, 1)!.transform).toBe("translateX(-760.00px)");
    // 后退：阴影条贴在左缘、向右移动
    const back = turnKeyframes("cover", -1, W, H, O).bands[0];
    expect(back.css).toContain("left:0.00px");
    expect(at(back.frames, 1)!.transform).toBe("translateX(760.00px)");
  });
});

describe("turnKeyframes: fade（渐隐）", () => {
  test("旧 1→0 / 新 0→1，无位移无裁剪", () => {
    const k = turnKeyframes("fade", 1, W, H, O);
    expect(k.old).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(k.new).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(k.bands).toEqual([]);
  });
});

describe("turnKeyframes: paper（纸页翻动）", () => {
  // 旧页裁剪路径里的数字序：
  //   前进 "M 0 0 L <折痕> 0 C <折痕+鼓起> _, <折痕+鼓起> _, <折痕> _ …"  → 折痕=[2]、鼓起=[4]−[2]
  //   后退 "M <折痕> 0 C <折痕+鼓起> _, <折痕+鼓起> _, <折痕> _ …"        → 折痕=[0]、鼓起=[2]−[0]
  const creaseOf = (frame: F, dir: 1 | -1) => nums(frame.clipPath)[dir > 0 ? 2 : 0];
  const bulgeOf = (frame: F, dir: 1 | -1) => {
    const n = nums(frame.clipPath);
    return dir > 0 ? n[4] - n[2] : n[2] - n[0];
  };

  test("折痕自右缘扫向左缘，等距 17 帧带 offset", () => {
    const k = turnKeyframes("paper", 1, W, H, O);
    expect(k.old).toHaveLength(SAMPLES);
    expect(k.new).toHaveLength(SAMPLES);
    expect(kf(k.old).map((f) => f.offset)).toEqual(Array.from({ length: SAMPLES }, (_, i) => i / (SAMPLES - 1)));
    expect(creaseOf(at(k.old, 0), 1)).toBe(W);
    expect(creaseOf(at(k.old, 1), 1)).toBe(0);
    expect(creaseOf(at(k.old, 0.5), 1)).toBe(W / 2);
  });
  test("两段裁剪沿同一条折痕互补：起点旧页满页、终点新页满页", () => {
    const k = turnKeyframes("paper", 1, W, H, O);
    const mid = nums(at(k.old, 5 / 16).clipPath)[2];
    expect(nums(at(k.new, 5 / 16).clipPath)[0]).toBe(mid);
    expect(at(k.old, 0).clipPath).toBe(`path("M 0 0 L 760.00 0 C 760.00 150.00, 760.00 450.00, 760.00 600.00 L 0 600.00 Z")`);
    expect(at(k.new, 1).clipPath).toBe(`path("M 0.00 0 C 0.00 150.00, 0.00 450.00, 0.00 600.00 L 760.00 600.00 L 760.00 0 Z")`);
    const back = turnKeyframes("paper", -1, W, H, O);
    expect(at(back.old, 0).clipPath).toBe(`path("M 0.00 0 C 0.00 150.00, 0.00 450.00, 0.00 600.00 L 760.00 600.00 L 760.00 0 Z")`);
  });
  test("折痕两端平直、中段向运动反方向鼓起 min(24px, 4.5%w)；后退镜像（折痕自左缘扫向右缘）", () => {
    const k = turnKeyframes("paper", 1, W, H, O);
    expect(bulgeOf(at(k.old, 0), 1)).toBe(0);
    expect(bulgeOf(at(k.old, 1), 1)).toBe(0);
    expect(bulgeOf(at(k.old, 0.5), 1)).toBe(24);
    const back = turnKeyframes("paper", -1, W, H, O);
    expect(creaseOf(at(back.old, 0), -1)).toBe(0);
    expect(creaseOf(at(back.old, 1), -1)).toBe(W);
    expect(bulgeOf(at(back.old, 0.5), -1)).toBe(-24);
  });
  test("遮罩条：折痕阴影投在新页一侧；折页条以折痕为轴按包络横向缩放", () => {
    const k = turnKeyframes("paper", 1, W, H, O);
    expect(k.bands.map((b) => b.name)).toEqual(["wr-band-0", "wr-band-1"]);
    const [shadow, fold] = k.bands;
    expect(shadow.css).toContain("left:0.00px;width:26.00px");
    expect(shadow.css).toContain("rgba(0,0,0,0.2)");
    expect(at(shadow.frames, 0)!.opacity).toBeCloseTo(0, 10);
    expect(at(shadow.frames, 0.5)!.opacity).toBeCloseTo(1, 10);
    // 阴影条跟着折痕走
    expect(at(shadow.frames, 0)!.transform).toBe("translateX(760.00px)");
    expect(at(shadow.frames, 1)!.transform).toBe("translateX(0.00px)");
    expect(fold.css).toContain("width:28.00px");
    expect(fold.css).toContain("transform-origin:100% 0");
    expect(fold.css).toContain("rgba(251,250,247,1) 92%,rgba(251,250,247,0) 100%");
    expect(at(fold.frames, 0)!.transform).toBe("translateX(760.00px) scaleX(0.001)");
    expect(at(fold.frames, 0.5)!.transform).toBe("translateX(380.00px) scaleX(1.000)");
  });
  test("取不到纸面实色（自定义背景图）时不画折页条；暗纸的折痕阴影更重", () => {
    const k = turnKeyframes("paper", 1, W, H, { dark: true, paperColor: null });
    expect(k.bands).toHaveLength(1);
    expect(k.bands[0].css).toContain("rgba(0,0,0,0.3)");
  });
});

describe("createTurnQueue：每次请求恰好一页", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const settle = async () => {
    for (let i = 0; i < 12; i++) await tick();
  };

  test("按序各跑一次；有积压时快进，队尾那次才播动画", async () => {
    const calls: [number, boolean][] = [];
    const enqueue = createTurnQueue(async (dir, fast) => {
      calls.push([dir, fast]);
      await tick();
    }, () => {});
    // 第一页在队列为空时起步（播动画），随后的请求造成积压
    enqueue(1);
    enqueue(1);
    enqueue(-1);
    await settle();
    expect(calls).toEqual([
      [1, false],
      [1, true],
      [-1, false],
    ]);
  });
  test("忙碌中再来请求 → 通知当前页让路；空闲时不通知", async () => {
    const events: string[] = [];
    const gates: (() => void)[] = [];
    const enqueue = createTurnQueue(async (dir, fast) => {
      events.push(`run ${dir} ${fast}`);
      await new Promise<void>((r) => gates.push(r));
    }, () => events.push("interrupt"));
    enqueue(1);
    await tick();
    expect(events).toEqual(["run 1 false"]);
    enqueue(-1);
    expect(events).toEqual(["run 1 false", "interrupt"]);
    gates[0]();
    await tick();
    await tick();
    expect(events).toEqual(["run 1 false", "interrupt", "run -1 false"]);
    gates[1]();
    await tick();
    // 排空后再来：不触发 interrupt
    enqueue(1);
    expect(events).toEqual(["run 1 false", "interrupt", "run -1 false", "run 1 false"]);
    gates[2]();
  });
  test("某一页抛错不卡死队列", async () => {
    const calls: number[] = [];
    const enqueue = createTurnQueue(async (dir) => {
      calls.push(dir);
      if (dir === 1) throw new Error("boom");
    }, () => {});
    enqueue(1);
    enqueue(1);
    await settle();
    expect(calls).toEqual([1, 1]);
  });
});
