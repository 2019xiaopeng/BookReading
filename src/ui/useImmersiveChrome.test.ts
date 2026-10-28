import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createImmersiveMachine, type ImmersiveMachine } from "./useImmersiveChrome";

function machine(disabled = false): ImmersiveMachine {
  return createImmersiveMachine({ disabled, onChange: () => {} });
}

describe("createImmersiveMachine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("初始隐藏；热区/栏进入浮现，离开 1.2s 后隐藏", () => {
    const m = machine();
    expect(m.visible).toBe(false);
    m.enter();
    expect(m.visible).toBe(true);
    m.leave();
    expect(m.visible).toBe(true); // 计时中仍可见
    vi.advanceTimersByTime(1199);
    expect(m.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(m.visible).toBe(false);
  });

  test("离开后再次进入取消隐藏计时", () => {
    const m = machine();
    m.enter();
    m.leave();
    m.enter();
    vi.advanceTimersByTime(10_000);
    expect(m.visible).toBe(true);
  });

  test("wake（Esc）浮现并自动隐藏", () => {
    const m = machine();
    m.wake();
    expect(m.visible).toBe(true);
    vi.advanceTimersByTime(1200);
    expect(m.visible).toBe(false);
  });

  test("dismiss 翻页即收：栏可见时立即隐藏（B12：单击正文不再承担收栏职责），disabled/locked 下无操作", () => {
    const m = machine();
    m.enter();
    m.dismiss();
    expect(m.visible).toBe(false);
    m.wake();
    m.dismiss();
    expect(m.visible).toBe(false);
    vi.advanceTimersByTime(10_000); // dismiss 已清计时，不再自动翻转
    expect(m.visible).toBe(false);
    const d = machine(true);
    d.dismiss();
    expect(d.visible).toBe(false);
    const l = machine();
    l.setLocked(true);
    l.dismiss();
    expect(l.visible).toBe(false);
  });

  test("disabled（抽屉/错误/选区开）强制隐藏；关闭后回到默认隐藏，热区可再唤出", () => {
    const m = machine(true);
    expect(m.visible).toBe(false);
    m.enter();
    m.wake();
    vi.advanceTimersByTime(10_000);
    expect(m.visible).toBe(false);
    m.setDisabled(false);
    expect(m.visible).toBe(false); // 浮层关闭后默认隐藏，指针进热区再唤出
    m.enter();
    expect(m.visible).toBe(true);
    m.leave();
    vi.advanceTimersByTime(1200);
    expect(m.visible).toBe(false);
  });

  test("locked 抑制 enter/wake；解锁立即唤回并回到自动隐藏", () => {
    const m = machine();
    m.setLocked(true);
    expect(m.visible).toBe(false);
    m.enter();
    m.wake();
    expect(m.visible).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(m.visible).toBe(false);
    m.setLocked(false);
    expect(m.visible).toBe(true);
    vi.advanceTimersByTime(1200);
    expect(m.visible).toBe(false);
  });
});
