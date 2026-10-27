import { useSyncExternalStore } from "react";

/**
 * 统一对话框（批次7）：替代全部 window.alert / window.confirm。
 * 模块级单例 + 订阅渲染；宿主 <DialogHost /> 挂在 App 根（两壳之外，靠自身 reduced-motion 回退）。
 * 样式复用 wr-prompt 体系，危险确认走 --wr-danger 实底。
 */
type DialogRequest = {
  kind: "alert" | "confirm";
  title: string;
  body?: string;
  danger?: boolean;
  confirmText?: string;
  resolve: (ok: boolean) => void;
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
    current = { kind: "confirm", title, body, danger: opts?.danger, confirmText: opts?.confirmText, resolve };
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

  const finish = (ok: boolean) => {
    current = null;
    emit();
    req.resolve(ok);
  };

  return (
    <div
      className="wr-prompt-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(false);
      }}
    >
      <div
        className="wr-panel wr-prompt"
        role={req.kind === "confirm" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={req.title}
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(false);
        }}
      >
        <div className="wr-prompt-title">{req.title}</div>
        {req.body ? <div className="wr-prompt-body">{req.body}</div> : null}
        <div className="wr-prompt-actions">
          {req.kind === "confirm" ? (
            <button className="wr-btn" autoFocus onClick={() => finish(false)}>
              取消
            </button>
          ) : null}
          <button
            autoFocus={req.kind === "alert"}
            className={req.danger ? "wr-btn wr-btn-danger" : "wr-btn wr-btn-primary"}
            onClick={() => finish(true)}
          >
            {req.confirmText ?? (req.kind === "alert" ? "知道了" : "确定")}
          </button>
        </div>
      </div>
    </div>
  );
}
