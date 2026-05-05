import type { Bookmark } from "../../tauri/invoke";

export default function BookmarksPanel(props: {
  items: Bookmark[];
  onAdd: () => void;
  onOpen: (cfi: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>书签</div>
        <div style={{ flex: 1 }} />
        <button className="wr-btn wr-btn-primary" onClick={props.onAdd}>
          添加
        </button>
      </div>

      {props.items.length === 0 ? (
        <div className="wr-muted">暂无书签</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {props.items.map((b) => (
            <div key={b.id} className="wr-card" style={{ padding: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {b.label?.trim() || "书签"}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="wr-btn" onClick={() => props.onOpen(b.cfi)}>
                  打开
                </button>
                <button className="wr-btn" onClick={() => props.onDelete(b.id)}>
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
