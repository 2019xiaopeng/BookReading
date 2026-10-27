import type { Highlight } from "../../tauri/invoke";
import { IconHighlight, IconRefresh } from "../../ui/icons";

export default function HighlightsPanel(props: {
  items: Highlight[];
  loaded?: boolean;
  onOpen: (cfiRange: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 600 }}>标注</div>

      {props.loaded === false ? (
        <div className="wr-state wr-state-loading">
          <span className="wr-state-icon" aria-hidden="true">
            <IconRefresh />
          </span>
          <div className="wr-state-title">加载中</div>
        </div>
      ) : props.items.length === 0 ? (
        <div className="wr-state">
          <span className="wr-state-icon" aria-hidden="true">
            <IconHighlight />
          </span>
          <div className="wr-state-title">还没有标注</div>
          <div className="wr-state-sub">选中正文一段文字试试</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {props.items.map((h) => (
            <div key={h.id} className="wr-card" style={{ padding: 10 }}>
              <div style={{ color: "var(--wr-ink)", marginBottom: 8 }}>{h.note?.trim() || "高亮"}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="wr-btn" onClick={() => props.onOpen(h.cfi_range)}>
                  打开
                </button>
                <button className="wr-btn" onClick={() => props.onDelete(h.id)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
