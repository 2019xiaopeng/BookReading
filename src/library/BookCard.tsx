import { memo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import type { Book } from "../tauri/invoke";
import { useCoverPriority } from "./useCoverUrls";
import { formatAuthor, formatTitle, progressText } from "./bookFormat";
import { IconMore } from "../ui/icons";

/**
 * 书卡（原 LibraryPage 内联 map 抽出 + React.memo）：
 * DOM 结构、类名与 data-* 与盘点文档 §3 完全一致——M2 改版要在这些类名上施工，勿改。
 * 事件回调经父级稳定引用传入（startCardDrag 闭包依赖多，由父级用 ref 转发），memo 只随可见 props 重渲。
 * 封面就绪/占位在同一容器内 opacity 过渡（图片淡入、占位淡出后保留 DOM，见 weread.css wr-cover 段）。
 */
export type BookCardProps = {
  book: Book;
  coverUrl?: string;
  /** E3 阅读时长 chip 文案（如“已读 3 小时 20 分”）；null/缺省不显示 */
  readingTimeText?: string | null;
  selectMode: boolean;
  selected: boolean;
  dragging: boolean;
  pop: boolean;
  loading: boolean;
  onCardPointerDown: (e: ReactPointerEvent<HTMLElement>, book: Book, coverUrl?: string) => void;
  onCardActivate: (bookId: string) => void;
  onCardSelectToggle: (bookId: string) => void;
  onCardMenu: (book: Book, anchor: HTMLElement) => void;
};

function BookCardImpl(props: BookCardProps) {
  const { book, coverUrl, readingTimeText, selectMode, selected, dragging, pop, loading } = props;
  const { onCardPointerDown, onCardActivate, onCardSelectToggle, onCardMenu } = props;
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  // 图片就绪标记：url 变化（换封面）后自动回到未就绪态，重新走淡入
  const coverLoaded = !!coverUrl && loadedUrl === coverUrl;
  const coverPriorityRef = useCoverPriority(book.cover_path ?? null);

  function onActivateKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (selectMode) onCardSelectToggle(book.id);
      else onCardActivate(book.id);
    }
  }

  return (
    <div
      className="wr-book-card"
      role="button"
      tabIndex={0}
      data-selected={selectMode && selected}
      data-drop="book"
      data-book-id={book.id}
      data-dragging={dragging}
      data-pop={pop}
      onPointerDown={(e) => onCardPointerDown(e, book, coverUrl)}
      onKeyDown={onActivateKey}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        if (selectMode) onCardSelectToggle(book.id);
        else onCardActivate(book.id);
      }}
    >
      {selectMode ? (
        <button
          className="wr-select-check"
          role="checkbox"
          aria-checked={selected}
          aria-label={`选择《${formatTitle(book)}》`}
          onClick={(e) => {
            e.stopPropagation();
            onCardSelectToggle(book.id);
          }}
        >
          {selected ? "✓" : ""}
        </button>
      ) : null}

      <div
        className="wr-cover"
        ref={coverPriorityRef}
        // M2 骨架 shimmer：pending=有封面但缩略档未就绪；loading=url 已到但图片未解码完成
        data-pending={!!book.cover_path && !coverUrl}
        data-loading={!!coverUrl && !coverLoaded}
      >
        {coverUrl ? (
          <img
            src={coverUrl}
            alt=""
            loading="lazy"
            decoding="async"
            data-loaded={coverLoaded}
            onLoad={() => setLoadedUrl(coverUrl)}
          />
        ) : null}
        <div className="wr-cover-text" data-faded={coverLoaded}>
          <div className="wr-cover-title">{formatTitle(book)}</div>
          <div className="wr-cover-author">{formatAuthor(book)}</div>
        </div>
        {/* §11.9：读到 N% chip 撤掉，有进度=封面下缘恒长 2px 墨线（百分比在 .wr-author title 提示里） */}
        {typeof book.reading_percent === "number" && book.reading_percent > 0 ? (
          <div className="wr-progress-line" aria-hidden="true" />
        ) : null}
      </div>

      <div className="wr-meta">
        <div className="wr-title" title={formatTitle(book)}>{formatTitle(book)}</div>
        <div className="wr-author" title={`${formatAuthor(book)} · ${progressText(book)}`}>{formatAuthor(book)}</div>
        {readingTimeText ? (
          <div className="wr-chip-row">
            <div className="wr-chip">
              <span>{readingTimeText}</span>
            </div>
          </div>
        ) : null}
      </div>

      {/* §11.6：置顶/详情/移出收进 ⋯ 菜单；置顶卡常显 ⋯ 保留可发现性 */}
      {!selectMode ? (
        <div className="wr-card-tools" data-show={!!book.pinned_at}>
          <button
            className="wr-mini-btn"
            aria-label="更多操作"
            aria-haspopup="menu"
            disabled={loading}
            onClick={(e) => {
              e.stopPropagation();
              onCardMenu(book, e.currentTarget);
            }}
          >
            <IconMore />
          </button>
        </div>
      ) : null}
    </div>
  );
}

const BookCard = memo(BookCardImpl);
export default BookCard;
