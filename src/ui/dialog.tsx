import { useSyncExternalStore } from "react";

/**
 * 统一对话框（批次7）：替代全部 window.alert / window.confirm。
 * 模块级单例 + 订阅渲染；宿主 <DialogHost /> 挂在 App 根（两壳之外，靠自身 reduced-motion 回退）。
 * 样式复用 wr-prompt 体系，危险确认走 --wr-danger 实底。
 */
type DialogRequest = {
  kind: "alert" | "confirm" | "choice";
  title: string;
  body?: string;
  danger?: boolean;
  confirmText?: string;
  secondaryText?: string;
  resolve: (action: "primary" | "secondary" | "dismiss") => void;
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

export function DialogHost() {
  const req = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
  if (!req) return null;

  const finish = (action: "primary" | "secondary" | "dismiss") => {
    current = null;
    emit();
    req.resolve(action);
  };

  return (
    <div
      className="wr-prompt-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish("dismiss");
      }}
    >
      <div
        className="wr-panel wr-prompt wr-prompt--sys"
        role={req.kind === "confirm" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={req.title}
        onKeyDown={(e) => {
          if (e.key === "Escape") finish("dismiss");
        }}
      >
        <div className="wr-prompt-title">{req.title}</div>
        {req.body ? <div className="wr-prompt-body">{req.body}</div> : null}
        <div className="wr-prompt-actions">
          {req.kind === "confirm" ? (
            <button className="wr-btn" autoFocus onClick={() => finish("dismiss")}>
              取消
            </button>
          ) : null}
          {req.secondaryText ? (
            <button className="wr-btn" onClick={() => finish("secondary")}>
              {req.secondaryText}
            </button>
          ) : null}
          <button
            autoFocus={req.kind !== "confirm"}
            className={req.danger ? "wr-btn wr-btn-danger" : "wr-btn wr-btn-primary"}
            onClick={() => finish("primary")}
          >
            {req.confirmText ?? (req.kind === "alert" ? "知道了" : "确定")}
          </button>
        </div>
      </div>
    </div>
  );
}
