import { useEffect, useState, useSyncExternalStore } from "react";
import { Modal } from "./radix";

/**
 * 统一对话框（批次7）：替代全部 window.alert / window.confirm。
 * 模块级单例 + 订阅渲染；宿主 <DialogHost /> 挂在 App 根（两壳之外，靠自身 reduced-motion 回退）。
 * 样式复用 wr-prompt 体系，危险确认走 --wr-danger 实底。
 */
type DialogRequest = {
  kind: "alert" | "confirm" | "choice" | "prompt";
  title: string;
  body?: string;
  danger?: boolean;
  confirmText?: string;
  secondaryText?: string;
  // C-1：三选 + 「记住我的选择」复选框（关闭按钮行为记忆）
  rememberLabel?: string;
  // E-1 prompt：单行输入（侧栏书架树右键 新建/重命名 等处复用，样式同 LibraryPage 内联 prompt）
  value?: string;
  allowEmpty?: boolean;
  resolve: (action: "primary" | "secondary" | "dismiss", remember?: boolean) => void;
};

let current: DialogRequest | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function showAlert(title: string, body?: string): Promise<void> {
  return new Promise((resolve) => {
    current = { kind: "alert", title, body, resolve: () => resolve() };
    emit();
  });
}

export function showConfirm(title: string, body?: string, opts?: { danger?: boolean; confirmText?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    current = {
      kind: "confirm",
      title,
      body,
      danger: opts?.danger,
      confirmText: opts?.confirmText,
      resolve: (a) => resolve(a === "primary"),
    };
    emit();
  });
}

/** 批次16：主按钮 / 次按钮 / 关闭三择（次按钮=低频动作如"导入全部副本"） */
export function showChoice(
  title: string,
  body?: string,
  opts?: { confirmText?: string; secondaryText?: string },
): Promise<"primary" | "secondary" | "dismiss"> {
  return new Promise((resolve) => {
    current = { kind: "choice", title, body, confirmText: opts?.confirmText, secondaryText: opts?.secondaryText, resolve };
    emit();
  });
}

// E-1 prompt 输入值：宿主输入框实时写这里（current 在 finish 时已清空，resolve 闭包读不到）
let promptValue = "";

/** E-1：单行输入对话框（取消/点遮罩 → null；空提交受 allowEmpty 门禁，空时确定钮置灰） */
export function showPrompt(title: string, value: string, opts?: { allowEmpty?: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    promptValue = value;
    current = {
      kind: "prompt",
      title,
      value,
      allowEmpty: opts?.allowEmpty,
      resolve: (a) => resolve(a === "primary" ? promptValue : null),
    };
    emit();
  });
}

/** C-1：三选 + 「记住我的选择」复选框；取消/点遮罩（dismiss）时 remember 恒为 false */
export function showChoiceRemember(
  title: string,
  body?: string,
  opts?: { confirmText?: string; secondaryText?: string; rememberLabel?: string },
): Promise<{ action: "primary" | "secondary" | "dismiss"; remember: boolean }> {
  return new Promise((resolve) => {
    current = {
      kind: "choice",
      title,
      body,
      confirmText: opts?.confirmText,
      secondaryText: opts?.secondaryText,
      rememberLabel: opts?.rememberLabel,
      resolve: (action, remember) => resolve({ action, remember: remember === true }),
    };
    emit();
  });
}

export function DialogHost() {
  const req = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
  const [remember, setRemember] = useState(false);
  // E-1 prompt：输入值存模块变量（resolve 闭包读取），bump 驱动空值门禁的重渲
  const [, forceUpdate] = useState(0);
  useEffect(() => setRemember(false), [req]);
  if (!req) return null;

  const finish = (action: "primary" | "secondary" | "dismiss") => {
    current = null;
    emit();
    req.resolve(action, remember);
  };
  const promptEmpty = req.kind === "prompt" && !req.allowEmpty && !promptValue.trim();

  return (
    <Modal
      label={req.title}
      onClose={() => finish("dismiss")}
      panelClassName="wr-panel wr-prompt wr-prompt--sys"
    >
        <div className="wr-prompt-title">{req.title}</div>
        {req.body ? <div className="wr-prompt-body">{req.body}</div> : null}
        {req.kind === "prompt" ? (
          <input
            className="wr-input"
            autoFocus
            aria-label={req.title}
            defaultValue={req.value}
            onChange={(e) => {
              promptValue = e.currentTarget.value;
              forceUpdate((n) => n + 1);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !promptEmpty) finish("primary");
            }}
          />
        ) : null}
        {req.rememberLabel ? (
          <label className="wr-prompt-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.currentTarget.checked)}
            />
            {req.rememberLabel}
          </label>
        ) : null}
        <div className="wr-prompt-actions">
          {req.kind === "confirm" || req.kind === "prompt" ? (
            <button className="wr-btn" autoFocus={req.kind === "confirm"} onClick={() => finish("dismiss")}>
              取消
            </button>
          ) : null}
          {req.secondaryText ? (
            <button className="wr-btn" onClick={() => finish("secondary")}>
              {req.secondaryText}
            </button>
          ) : null}
          <button
            autoFocus={req.kind !== "confirm" && req.kind !== "prompt"}
            className={req.danger ? "wr-btn wr-btn-danger" : "wr-btn wr-btn-primary"}
            disabled={promptEmpty}
            onClick={() => finish("primary")}
          >
            {req.confirmText ?? (req.kind === "alert" ? "知道了" : "确定")}
          </button>
        </div>
    </Modal>
  );
}
