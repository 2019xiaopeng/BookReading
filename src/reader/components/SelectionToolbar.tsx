import { useState } from "react";

export default function SelectionToolbar(props: {
  open: boolean;
  text: string;
  onHighlight: () => void;
  onFavorite: () => void;
  onNote: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (!props.open) return null;

  return (
    <div className="wr-selection" role="toolbar" aria-label="划选操作">
      <div className="wr-panel wr-selection-bar">
        <div className="wr-selection-text">{props.text}</div>
        <button
          className="wr-btn"
          onClick={() => {
            navigator.clipboard
              ?.writeText(props.text)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {});
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
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
