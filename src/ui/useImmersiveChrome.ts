import { useRef, useState } from "react";

export type ImmersiveChrome = {
  /** 栏当前可见 */
  visible: boolean;
  /** 锁定态：全藏，热区禁用，任何输入不唤出 */
  locked: boolean;
  setLocked: (v: boolean) => void;
  /** 鼠标进入顶部/底部热区或栏内：立即浮现并常驻 */
  enter: () => void;
  /** 鼠标离开热区与栏：起 2.5s 计时后隐藏 */
  leave: () => void;
  /** Esc 唤醒：浮现并起计时（期间无鼠标进入热区则自动隐藏） */
  wake: () => void;
};

export type ImmersiveMachine = ImmersiveChrome & {
  setDisabled: (v: boolean) => void;
};

/**
 * 沉浸 chrome 状态机（B6 热区版）：栏默认隐藏，鼠标进入顶/底热区或栏内才浮现；
 * 离开热区与栏 2.5s 后淡出；locked=全藏且热区无效；disabled（抽屉开/加载失败/选区气泡开）恒可见。
 * 键盘/滚轮/边缘翻页不经过此状态机，任何栏状态下照常。纯逻辑可脱离 React 在 node 单测。
 */
export function createImmersiveMachine(opts: {
  hideMs?: number;
  disabled?: boolean;
  onChange: () => void;
}): ImmersiveMachine {
  const hideMs = opts.hideMs ?? 2500;
  let locked = false;
  let disabled = !!opts.disabled;
  let hidden = true;
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
      hidden = true;
      opts.onChange();
    }, hideMs);
  };

  const enter = () => {
    clearTimer();
    if (locked || disabled) return;
    if (hidden) {
      hidden = false;
      opts.onChange();
    }
  };
  const leave = () => {
    if (locked || disabled) return;
    if (!hidden) arm();
  };
  const wake = () => {
    if (locked || disabled) return;
    arm();
    if (hidden) {
      hidden = false;
      opts.onChange();
    }
  };

  const setLocked = (v: boolean) => {
    if (v === locked) return;
    locked = v;
    clearTimer();
    if (v) {
      hidden = true;
      opts.onChange();
    } else {
      wake(); // 解锁即唤回（随后回归热区自动隐藏语义）
    }
  };

  const setDisabled = (v: boolean) => {
    if (v === disabled) return;
    disabled = v;
    hidden = false;
    if (v || locked) clearTimer();
    else arm();
    // disabled 变化总伴随宿主重渲染（props 变化），无需 onChange
  };

  return {
    get visible() {
      return !locked && (disabled || !hidden);
    },
    get locked() {
      return locked;
    },
    setLocked,
    enter,
    leave,
    wake,
    setDisabled,
  };
}

export function useImmersiveChrome(opts?: { hideMs?: number; disabled?: boolean }): ImmersiveChrome {
  const [, bump] = useState(0);
  const ref = useRef<ImmersiveMachine | null>(null);
  if (ref.current === null) {
    ref.current = createImmersiveMachine({
      hideMs: opts?.hideMs,
      disabled: opts?.disabled,
      onChange: () => bump((n) => n + 1),
    });
  }
  const m = ref.current;
  m.setDisabled(!!opts?.disabled);
  return m;
}
