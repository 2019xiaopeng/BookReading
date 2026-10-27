import { useEffect, useRef, useState } from "react";

export type ImmersiveChrome = {
  /** 栏当前可见（自动隐藏态） */
  visible: boolean;
  /** 锁定态：全藏，任何输入不唤出 */
  locked: boolean;
  setLocked: (v: boolean) => void;
  wake: () => void;
};

export type ImmersiveMachine = ImmersiveChrome & {
  setDisabled: (v: boolean) => void;
  attach: (win: Pick<Window, "addEventListener" | "removeEventListener">) => void;
  destroy: () => void;
};

const WAKE_EVENTS = ["mousemove", "pointerdown", "keydown", "wheel"] as const;

/**
 * 沉浸 chrome 状态机：常态=栏自动隐藏（idleMs 无输入淡出，任意输入唤回）；
 * disabled（抽屉开/加载失败/选区气泡开）恒可见且暂停计时；locked 恒隐藏、wake 无效。
 * 纯逻辑可脱离 React 在 node 单测（attach 注入 window）。
 */
export function createImmersiveMachine(opts: {
  idleMs?: number;
  disabled?: boolean;
  onChange: () => void;
}): ImmersiveMachine {
  const idleMs = opts.idleMs ?? 3000;
  let locked = false;
  let disabled = !!opts.disabled;
  let idleHidden = false;
  let timer: number | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = () => {
    clearTimer();
    if (locked || disabled) return;
    timer = setTimeout(() => {
      timer = null;
      idleHidden = true;
      opts.onChange();
    }, idleMs);
  };

  const wake = () => {
    if (locked || disabled) return;
    const wasHidden = idleHidden;
    idleHidden = false;
    arm();
    if (wasHidden) opts.onChange();
  };

  const setLocked = (v: boolean) => {
    if (v === locked) return;
    locked = v;
    idleHidden = false;
    if (v) clearTimer();
    else arm();
    opts.onChange();
  };

  const setDisabled = (v: boolean) => {
    if (v === disabled) return;
    disabled = v;
    idleHidden = false;
    if (v || locked) clearTimer();
    else arm();
    // disabled 变化总伴随宿主重渲染（props 变化），无需 onChange
  };

  let attached: Pick<Window, "addEventListener" | "removeEventListener"> | null = null;
  const attach = (win: Pick<Window, "addEventListener" | "removeEventListener">) => {
    attached = win;
    for (const type of WAKE_EVENTS) win.addEventListener(type, wake, { passive: true });
    arm(); // StrictMode 下 effect 会 attach/destroy/attach，重挂即重起计时
  };
  const destroy = () => {
    if (attached) for (const type of WAKE_EVENTS) attached.removeEventListener(type, wake);
    attached = null;
    clearTimer();
  };

  return {
    get visible() {
      return !locked && (disabled || !idleHidden);
    },
    get locked() {
      return locked;
    },
    setLocked,
    wake,
    setDisabled,
    attach,
    destroy,
  };
}

export function useImmersiveChrome(opts?: { idleMs?: number; disabled?: boolean }): ImmersiveChrome {
  const [, bump] = useState(0);
  const ref = useRef<ImmersiveMachine | null>(null);
  if (ref.current === null) {
    ref.current = createImmersiveMachine({
      idleMs: opts?.idleMs,
      disabled: opts?.disabled,
      onChange: () => bump((n) => n + 1),
    });
  }
  const m = ref.current;
  m.setDisabled(!!opts?.disabled);
  useEffect(() => {
    m.attach(window);
    return () => m.destroy();
  }, [m]);
  return m;
}
