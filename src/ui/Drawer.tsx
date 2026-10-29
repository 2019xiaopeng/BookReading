import type { ReactNode } from "react";

export default function Drawer(props: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!props.open) return null;

  return (
    <div
      className="wr-drawer-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        className="wr-panel wr-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        {/* B11：独立头部类——不得借用 .wr-reader-topbar（B6 起是 absolute overlay，会把头部锚到 overlay 全宽并让内容行塌缩） */}
        <div className="wr-drawer-head">
          <div style={{ fontWeight: 650 }}>{props.title}</div>
          <div style={{ flex: 1 }} />
          <button className="wr-btn" autoFocus onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="wr-drawer-content">{props.children}</div>
      </div>
    </div>
  );
}
