import type { ReactNode } from "react";

export default function Drawer(props: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!props.open) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.28)",
        display: "grid",
        justifyItems: "end",
        zIndex: 20,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        className="wr-panel"
        style={{
          width: 390,
          height: "100%",
          borderRadius: 0,
          borderLeft: "1px solid var(--wr-hairline)",
          boxShadow: "var(--wr-shadow)",
          display: "grid",
          gridTemplateRows: "62px 1fr",
        }}
      >
        <div className="wr-topbar">
          <div style={{ fontWeight: 800 }}>{props.title}</div>
          <div style={{ flex: 1 }} />
          <button className="wr-btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div style={{ padding: 14, overflow: "auto", minHeight: 0 }}>{props.children}</div>
      </div>
    </div>
  );
}

