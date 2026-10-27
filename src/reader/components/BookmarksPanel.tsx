import type { Bookmark } from "../../tauri/invoke";
import { IconBookmark, IconRefresh } from "../../ui/icons";

export default function BookmarksPanel(props: {
  items: Bookmark[];
  loaded?: boolean;
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
            <IconBookmark />
          </span>
          <div className="wr-state-title">还没有书签</div>
          <div className="wr-state-sub">按 Ctrl+B 或点上方添加</div>
        </div>
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
