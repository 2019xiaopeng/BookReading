import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createImmersiveMachine, type ImmersiveMachine } from "./useImmersiveChrome";

type StubWin = {
  listeners: Record<string, () => void>;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
};

function stubWin(): StubWin {
  const listeners: Record<string, () => void> = {};
  return {
    listeners,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    removeEventListener: (type) => {
      delete listeners[type];
    },
  };
}

function machine(disabled = false): { m: ImmersiveMachine; win: StubWin } {
  const win = stubWin();
  const m = createImmersiveMachine({ disabled, onChange: () => {} });
  // stub 只收 () => void 处理器，签名与真实 Window 重载不同，此处仅测试注入
  m.attach(win as unknown as Pick<Window, "addEventListener" | "removeEventListener">);
  return { m, win };
}

describe("createImmersiveMachine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("idle 后隐藏，输入事件唤醒并重置计时", () => {
    const { m, win } = machine();
    expect(m.visible).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(m.visible).toBe(false);
    win.listeners.mousemove();
    expect(m.visible).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(m.visible).toBe(true); // 计时已重置
    vi.advanceTimersByTime(1000);
    expect(m.visible).toBe(false);
  });

  test("disabled 强制可见且暂停计时（超时也不隐藏）", () => {
    const { m, win } = machine(true);
    expect(m.visible).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(m.visible).toBe(true);
    win.listeners.mousemove();
    expect(m.visible).toBe(true);
    m.setDisabled(false);
    vi.advanceTimersByTime(3000);
    expect(m.visible).toBe(false);
  });

  test("locked 抑制唤醒，解锁回到自动隐藏态", () => {
    const { m, win } = machine();
    m.setLocked(true);
    expect(m.visible).toBe(false);
    win.listeners.mousemove(); // 锁定态输入无效
    expect(m.visible).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(m.visible).toBe(false);
    m.setLocked(false);
    expect(m.visible).toBe(true); // 解锁立即唤回
    vi.advanceTimersByTime(3000);
    expect(m.visible).toBe(false); // 回到自动隐藏
  });

  test("wheel/keydown/pointerdown 也唤醒", () => {
    const { m, win } = machine();
    vi.advanceTimersByTime(3000);
    expect(m.visible).toBe(false);
    win.listeners.wheel();
    expect(m.visible).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(m.visible).toBe(false);
    win.listeners.keydown();
    expect(m.visible).toBe(true);
  });

  test("destroy 清理监听与计时（destroy 后不再隐藏）", () => {
    const { m, win } = machine();
    m.destroy();
    expect(Object.keys(win.listeners).length).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(m.visible).toBe(true);
  });
});
