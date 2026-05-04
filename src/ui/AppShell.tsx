import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

export default function AppShell(props: {
  active: "library" | "favorites" | "reader";
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();

  return (
    <div className="wr-shell" data-theme="light">
      <div className="wr-panel" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="wr-topbar" style={{ borderBottom: "1px solid var(--wr-hairline)" }}>
          <div style={{ fontWeight: 800, letterSpacing: 0.2 }}>BookReading</div>
        </div>

        <div style={{ padding: 10, display: "grid", gap: 8 }}>
          <button className="wr-btn" data-active={props.active === "library"} onClick={() => navigate("/")}>
            书架
          </button>
          <button className="wr-btn" data-active={props.active === "favorites"} onClick={() => navigate("/favorites")}>
            收藏
          </button>
        </div>

        <div style={{ marginTop: "auto", padding: 12, borderTop: "1px solid var(--wr-hairline)" }}>{props.right}</div>
      </div>

      <div className="wr-panel" style={{ display: "grid", gridTemplateRows: "62px 1fr", minWidth: 0, minHeight: 0 }}>
        <div className="wr-topbar">
          <div style={{ fontWeight: 750 }}>{props.title}</div>
          <div style={{ flex: 1 }} />
        </div>
        <div style={{ minHeight: 0, overflow: "auto" }}>{props.children}</div>
      </div>
    </div>
  );
}

