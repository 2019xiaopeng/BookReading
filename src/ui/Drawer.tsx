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
      >
        <div className="wr-topbar wr-reader-topbar">
          <div style={{ fontWeight: 800 }}>{props.title}</div>
          <div style={{ flex: 1 }} />
          <button className="wr-btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="wr-drawer-content">{props.children}</div>
      </div>
    </div>
  );
}
