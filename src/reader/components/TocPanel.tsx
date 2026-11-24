import { useCallback, useState, type ReactNode } from "react";

import type { TocItem } from "../epub/reader";
import { tocItemIsActive } from "../epub/tocLabel";
import { IconChevronRight } from "../../ui/icons";

/**
 * B-1 目录分层渲染：有子项的节点（卷）=可折叠分组（点击展开收起，默认全展），叶子（章）=目录项；
 * 当前章高亮与 scrollIntoView 定位沿用平铺版逻辑；当前章所在卷强制展开（不被折叠态吞掉定位）。
 * 扁平目录（无 subitems）自然退化为平铺列表，无分组噪音。
 */
export default function TocPanel(props: { toc: TocItem[]; chapterHref: string; onOpen: (href: string) => void }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((href: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(href)) next.delete(href);
      else next.add(href);
      return next;
    });
  }, []);

  const renderNode = (item: TocItem, depth: number): ReactNode => {
    if (!item.subitems?.length) {
      const isActive = tocItemIsActive(item, props.chapterHref);
      return (
        <button
          key={item.href}
          className="wr-toc-item wr-toc-leaf"
          style={depth > 0 ? { paddingLeft: 12 + depth * 14 } : undefined}
          data-active={isActive ? "true" : undefined}
          aria-current={isActive ? "true" : undefined}
          ref={
            isActive
              ? (el) => {
                  // R-3 打开目录滚到当前章（居中），仅挂载时执行一次
                  if (el) requestAnimationFrame(() => el.scrollIntoView?.({ block: "center" }));
                }
              : undefined
          }
          onClick={() => props.onOpen(item.href)}
        >
          {item.label}
        </button>
      );
    }
    const activeInside = tocItemIsActive(item, props.chapterHref);
    const expanded = activeInside || !collapsed.has(item.href);
    return (
      <div key={item.href} className="wr-toc-group">
        <button
          className="wr-toc-item wr-toc-group-head"
          style={depth > 0 ? { paddingLeft: 12 + depth * 14 } : undefined}
          aria-expanded={expanded}
          onClick={() => toggle(item.href)}
        >
          <IconChevronRight className="wr-toc-chevron" aria-hidden />
          <span className="wr-toc-group-label">{item.label}</span>
        </button>
        {expanded ? <div className="wr-toc-group-body">{item.subitems.map((s) => renderNode(s, depth + 1))}</div> : null}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {props.toc.map((item) => renderNode(item, 0))}
    </div>
  );
}
