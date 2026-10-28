import { useRef, useState } from "react";

export type ImmersiveChrome = {
  /** 栏当前可见 */
  visible: boolean;
  /** 锁定态：全藏，热区禁用，任何输入不唤出 */
  locked: boolean;
  setLocked: (v: boolean) => void;
  /** 鼠标进入顶部/底部热区或栏内：立即浮现并常驻 */
  enter: () => void;
  /** 鼠标离开热区与栏：起 1.2s 计时后隐藏 */
  leave: () => void;
  /** 翻页动作（键盘/滚轮/边缘热区点击）时立即收栏（不等计时）；单击正文不承担收栏职责 */
  dismiss: () => void;
  /** Esc 唤醒：浮现并起计时（期间无鼠标进入热区则自动隐藏，1.2s） */
  wake: () => void;
};

export type ImmersiveMachine = ImmersiveChrome & {
  setDisabled: (v: boolean) => void;
};

/**
 * 沉浸 chrome 状态机（B12 精简版）。规则：
 * 显示 = 指针进入顶/底热区或栏内（无延迟）；
 * 隐藏 = ①指针离开热区与栏 1.2s ②发生翻页动作（键盘/滚轮/边缘热区点击，调 dismiss）
 *        ③开始选中文字（selected → 宿主置 selection → disabled）④抽屉/错误浮层打开（disabled）；
 * disabled = 抽屉开/加载失败/选区气泡开时栏隐藏（抽屉与浮层有自己的头部）；
 * 锁定态不变：全藏、热区禁用。键盘/滚轮/边缘翻页不经过此状态机照常发生。纯逻辑可脱离 React 在 node 单测。
 */
export function createImmersiveMachine(opts: {
  hideMs?: number;
  disabled?: boolean;
  onChange: () => void;
}): ImmersiveMachine {
  const hideMs = opts.hideMs ?? 1200;
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
  const dismiss = () => {
    if (locked || disabled) return;
    clearTimer();
    if (!hidden) {
      hidden = true;
      opts.onChange();
    }
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
    // B12：disabled=栏隐藏（原 11a 为恒可见）；浮层关闭后回到默认隐藏，热区再唤出
    hidden = true;
    clearTimer();
    // disabled 变化总伴随宿主重渲染（props 变化），无需 onChange
  };

  return {
    get visible() {
      return !locked && !disabled && !hidden;
    },
    get locked() {
      return locked;
    },
    setLocked,
    enter,
    leave,
    dismiss,
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
