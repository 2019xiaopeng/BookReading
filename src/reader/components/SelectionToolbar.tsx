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
    <div className="wr-selection">
      <div className="wr-panel wr-selection-bar">
        <div className="wr-selection-text">{props.text}</div>
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
