export default function SelectionToolbar(props: {
  open: boolean;
  text: string;
  onHighlight: () => void;
  onFavorite: () => void;
  onNote: () => void;
  onClose: () => void;
}) {
  if (!props.open) return null;

  return (
    <div style={{ position: "absolute", left: 16, right: 16, bottom: 16, zIndex: 25 }}>
      <div
        className="wr-panel"
        style={{
          padding: 10,
          borderRadius: 999,
          display: "flex",
          gap: 10,
          alignItems: "center",
          boxShadow: "var(--wr-shadow)",
        }}
      >
        <div style={{ flex: 1, minWidth: 0, color: "var(--wr-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {props.text}
        </div>
        <button className="wr-btn" onClick={props.onHighlight}>
          高亮
        </button>
        <button className="wr-btn" onClick={props.onFavorite}>
          收藏
        </button>
        <button className="wr-btn" onClick={props.onNote}>
          笔记
        </button>
        <button className="wr-btn" onClick={props.onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}

