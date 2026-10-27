import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createImmersiveMachine, type ImmersiveMachine } from "./useImmersiveChrome";

function machine(disabled = false): ImmersiveMachine {
  return createImmersiveMachine({ disabled, onChange: () => {} });
}

describe("createImmersiveMachine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("初始隐藏；热区/栏进入浮现，离开 2.5s 后隐藏", () => {
    const m = machine();
    expect(m.visible).toBe(false);
    m.enter();
    expect(m.visible).toBe(true);
    m.leave();
    expect(m.visible).toBe(true); // 计时中仍可见
    vi.advanceTimersByTime(2499);
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
    vi.advanceTimersByTime(2500);
    expect(m.visible).toBe(false);
  });

  test("disabled 强制可见且计时暂停", () => {
    const m = machine(true);
    expect(m.visible).toBe(true);
    m.leave();
    vi.advanceTimersByTime(10_000);
    expect(m.visible).toBe(true);
    m.setDisabled(false);
    expect(m.visible).toBe(true); // 关抽屉回到自动隐藏态：先可见
    vi.advanceTimersByTime(2500);
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
    vi.advanceTimersByTime(2500);
    expect(m.visible).toBe(false);
  });
});
