import type { TocItem } from "./reader";

export function tocLabelFor(flatToc: TocItem[], href: string): string | null {
  const h = href.split("#")[0];
  if (!h) return null;
  return flatToc.find((t) => t.href.split("#")[0] === h)?.label?.trim() || null;
}
