import { useRef, useState } from "react";
import * as Menu from "@radix-ui/react-menu";

import { anchorBelow, PointMenu, type MenuPoint } from "../ui/radix";
import { READING_STATUS_LABELS, type ReadingStatus } from "./readingStatus";

export type StatusFilter = "all" | ReadingStatus;

const OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部状态" },
  { value: "unread", label: READING_STATUS_LABELS.unread },
  { value: "reading", label: READING_STATUS_LABELS.reading },
  { value: "finished", label: READING_STATUS_LABELS.finished },
];

/** 筛选行阅读状态下拉（单选）：视觉沿用 wr-btn 触发钮 + wr-tag-pop 弹层；行为层 = Radix Menu（方向键/type-ahead/Esc） */
export default function StatusFilterMenu({
  value,
  onChange,
}: {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
}) {
  const [anchor, setAnchor] = useState<MenuPoint | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        type="button"
        className="wr-btn"
        aria-expanded={!!anchor}
        aria-haspopup="true"
        aria-label={`阅读状态筛选，当前：${current.label}`}
        // pointerdown 阶段拦外点（不冒泡到 Radix 的 document 监听），click 才翻转——避免“关了又开”
        onPointerDown={(e) => {
          if (anchor) e.stopPropagation();
        }}
        onClick={() => setAnchor((v) => (v ? null : anchorBelow(btnRef.current)))}
      >
        {current.label}▾
      </button>
      {anchor ? (
        <PointMenu point={anchor} onClose={() => setAnchor(null)} label="按阅读状态筛选" contentClassName="wr-tag-pop">
          <Menu.RadioGroup value={value as string} onValueChange={(v) => onChange(v as StatusFilter)}>
            {OPTIONS.map((o) => (
              <Menu.RadioItem key={o.value} asChild value={o.value} data-checked={value === o.value}>
                <button type="button" className="wr-tag-item">
                  <span className="wr-tag-item-name">{o.label}</span>
                </button>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </PointMenu>
      ) : null}
    </div>
  );
}
