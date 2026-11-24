import type { TocItem } from "./reader";

export function tocLabelFor(flatToc: TocItem[], href: string): string | null {
  const h = href.split("#")[0];
  if (!h) return null;
  return flatToc.find((t) => t.href.split("#")[0] === h)?.label?.trim() || null;
}

/**
 * B-1 目录树节点是否命中当前章（自节点或任一子孙节点；与旧平铺渲染同口径：
 * 先剥 hash 再按末段比对——toc 常带 #anchor，relocated 已剥）。卷容器据此高亮定位并强制展开。
 */
export function tocItemIsActive(item: TocItem, chapterHref: string): boolean {
  if (!chapterHref) return false;
  const stripHash = (h: string) => h.split("#")[0];
  const a = stripHash(item.href);
  if (a === chapterHref || a.split("/").pop() === chapterHref.split("/").pop()) return true;
  return (item.subitems ?? []).some((s) => tocItemIsActive(s, chapterHref));
}
