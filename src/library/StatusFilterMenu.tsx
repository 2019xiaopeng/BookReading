import { useEffect, useRef, useState } from "react";

import { READING_STATUS_LABELS, type ReadingStatus } from "./readingStatus";

export type StatusFilter = "all" | ReadingStatus;

const OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部状态" },
  { value: "unread", label: READING_STATUS_LABELS.unread },
  { value: "reading", label: READING_STATUS_LABELS.reading },
  { value: "finished", label: READING_STATUS_LABELS.finished },
];

/** 筛选行阅读状态下拉（单选）：与 TagFilterMenu 同款触发钮（wr-btn+▾）与弹层（wr-tag-pop） */
export default function StatusFilterMenu({
  value,
  onChange,
}: {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 外点/Esc 关闭：与 TagFilterMenu、LibraryPage 菜单同一模式
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="wr-btn"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`阅读状态筛选，当前：${current.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        {current.label}▾
      </button>
      {open ? (
        <div className="wr-tag-pop" role="dialog" aria-label="按阅读状态筛选">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className="wr-tag-item"
              role="menuitemradio"
              aria-checked={value === o.value}
              data-checked={value === o.value}
              onClick={() => {
                setOpen(false);
                onChange(o.value);
              }}
            >
              <span className="wr-tag-item-name">{o.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
