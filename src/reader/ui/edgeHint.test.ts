// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { showEdgeHint } from "./edgeHint";

// jsdom 没有 WAAPI 与 matchMedia：记下每次 animate 的两端透明度，「当前透明度」按最后一个未取消动画的终值模拟
type Rec = { target: Element; from: number; to: number; cancelled: boolean };
let anims: Rec[] = [];
let reduced = false;

beforeEach(() => {
  anims = [];
  reduced = false;
  vi.useFakeTimers();
  window.matchMedia = ((q: string) => ({ matches: reduced && q.includes("prefers-reduced-motion"), media: q })) as unknown as typeof window.matchMedia;
  Element.prototype.animate = function (this: Element, kf: Keyframe[]) {
    const rec: Rec = { target: this, from: Number(kf[0].opacity), to: Number(kf[1].opacity), cancelled: false };
    anims.push(rec);
    return { cancel: () => void (rec.cancelled = true) } as unknown as Animation;
  } as typeof Element.prototype.animate;
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
    const live = anims.filter((a) => a.target === el && !a.cancelled);
    return { opacity: String(live.length ? live[live.length - 1].to : 1) } as CSSStyleDeclaration;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const host = () => document.body.appendChild(document.createElement("div"));
const last = () => anims[anims.length - 1];

describe("showEdgeHint（V-13 首/末页轻提示）", () => {
  test("文案：按页翻说「页」、按章翻说「章」，方向相反", () => {
    const h = host();
    showEdgeHint(h, "next", "page");
    expect(h.firstElementChild!.textContent).toBe("已是最后一页");
    showEdgeHint(h, "prev", "page");
    expect(h.firstElementChild!.textContent).toBe("已是第一页");
    showEdgeHint(h, "next", "chapter");
    expect(h.firstElementChild!.textContent).toBe("已是最后一章");
    showEdgeHint(h, "prev", "chapter");
    expect(h.firstElementChild!.textContent).toBe("已是第一章");
    expect(h.children).toHaveLength(1);
  });

  test("首次：宿主下挂一个小胶囊并淡入；没有宿主就什么都不做", () => {
    showEdgeHint(null, "next", "page");
    expect(anims).toHaveLength(0);
    const h = host();
    showEdgeHint(h, "next", "page");
    const el = h.querySelector<HTMLElement>(".wr-toast.wr-toast--center")!;
    expect(el).not.toBeNull();
    expect(el.getAttribute("role")).toBe("status");
    expect(anims).toEqual([{ target: el, from: 0, to: 1, cancelled: false }]);
  });

  test("显示中再触发：同一个元素、不叠弹、不重播淡入，淡出顺延到 1s", () => {
    const h = host();
    showEdgeHint(h, "next", "page");
    vi.advanceTimersByTime(500);
    showEdgeHint(h, "next", "page");
    expect(h.children).toHaveLength(1);
    expect(anims).toHaveLength(1);
    vi.advanceTimersByTime(400); // 距首次 900ms：原定时器（780ms）已被重置，还没淡出
    expect(anims).toHaveLength(1);
    vi.advanceTimersByTime(379); // 距第二次 779ms
    expect(anims).toHaveLength(1);
    vi.advanceTimersByTime(1); // 距第二次 780ms
    expect(last()).toMatchObject({ from: 1, to: 0 });
  });

  test("淡出途中再触发：取消淡出，从当前透明度淡回来", () => {
    const h = host();
    showEdgeHint(h, "next", "page");
    vi.advanceTimersByTime(800); // 淡出已开始
    const out = last();
    showEdgeHint(h, "next", "page");
    expect(out.cancelled).toBe(true);
    expect(last()).toMatchObject({ from: 0, to: 1 });
    expect(h.children).toHaveLength(1);
  });

  test("系统「减少动态效果」：不建动画，满 1s 直接移除", () => {
    const h = host();
    reduced = true;
    showEdgeHint(h, "next", "page");
    expect(anims).toHaveLength(0);
    vi.advanceTimersByTime(999);
    expect(h.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.children).toHaveLength(0);
  });

  test("宿主变了（重开一本书）：旧胶囊带走，新宿主下只有一个", () => {
    const a = host();
    showEdgeHint(a, "next", "page");
    const b = host();
    showEdgeHint(b, "next", "page");
    expect(a.children).toHaveLength(0);
    expect(b.querySelectorAll(".wr-toast--center")).toHaveLength(1);
    expect(last()).toMatchObject({ from: 0, to: 1, target: b.firstElementChild });
  });
});
