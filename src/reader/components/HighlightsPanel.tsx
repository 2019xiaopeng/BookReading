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
        <div style={{ color: "rgba(0,0,0,0.6)" }}>暂无标注</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {props.items.map((h) => (
            <div
              key={h.id}
              style={{ border: "1px solid rgba(0,0,0,0.12)", borderRadius: 10, padding: 10, background: "white" }}
            >
              <div style={{ color: "rgba(0,0,0,0.8)", marginBottom: 8 }}>
                {h.note?.trim() || "高亮"}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => props.onOpen(h.cfi_range)}>打开</button>
                <button onClick={() => props.onDelete(h.id)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

