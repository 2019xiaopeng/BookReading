import type { ReactNode } from "react";

export default function Drawer(props: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  // 始终挂载 + CSS 隐藏/显示——条件渲染挂载瞬间 absolute 定位未生效会挤一帧阅读区
  return (
    <div
      className="wr-drawer-overlay"
      style={props.open ? undefined : { display: "none" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && props.open) props.onClose();
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
