import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { IconBookmark, IconHighlight, IconQuote } from "../../ui/icons";

export type SelectionRect = { x: number; y: number; w: number; h: number };

/** 锚定选区矩形的小浮动气泡：仅 高亮/收藏/笔记 三个图标钮，功能与去重逻辑在 ReaderPage 原有 handler 中不变。 */
export default function SelectionToolbar(props: {
  open: boolean;
  rect: SelectionRect | null;
  onHighlight: () => void;
  onFavorite: () => void;
  onNote: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!props.open || !props.rect || !ref.current) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const { x, y, w, h } = props.rect;
    const bw = el.offsetWidth || 132;
    const bh = el.offsetHeight || 36;
    // 优先选区上方，贴顶翻下方；水平居中于选区并 clamp 视口内
    let top = y - bh - 8;
    if (top < 8) top = Math.min(y + h + 8, window.innerHeight - bh - 8);
    let left = x + w / 2 - bw / 2;
    left = Math.min(Math.max(left, 8), Math.max(8, window.innerWidth - bw - 8));
    setPos({ top, left });
  }, [props.open, props.rect]);

  // 点击气泡外（宿主文档）与 5 秒无操作自动收起；iframe 内按下由 reader 的 onContentsPress 收起
  useEffect(() => {
    if (!props.open || !props.rect) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      props.onClose();
    };
    document.addEventListener("pointerdown", onDown);
    const timer = window.setTimeout(props.onClose, 5000);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.clearTimeout(timer);
    };
  }, [props.open, props.rect, props.onClose]);

  if (!props.open || !props.rect) return null;

  return (
    <div
      ref={ref}
      className="wr-selection-bubble"
      role="toolbar"
      aria-label="划选操作"
      style={
        pos
          ? { top: pos.top, left: pos.left }
          : { top: -9999, left: -9999, opacity: 0, pointerEvents: "none" }
      }
    >
      <button type="button" aria-label="高亮" title="高亮" onClick={props.onHighlight}>
        <IconHighlight />
      </button>
      <button type="button" aria-label="收藏" title="收藏" onClick={props.onFavorite}>
        <IconQuote />
      </button>
      <button type="button" aria-label="笔记" title="笔记" onClick={props.onNote}>
        <IconBookmark />
      </button>
    </div>
  );
}
