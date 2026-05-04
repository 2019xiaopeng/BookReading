import type { Highlight } from "../../tauri/invoke";

export default function HighlightsPanel(props: {
  items: Highlight[];
  onOpen: (cfiRange: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 600 }}>标注</div>

      {props.items.length === 0 ? (
        <div className="wr-muted">暂无标注</div>
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
