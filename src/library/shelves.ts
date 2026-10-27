import type { Book, Shelf } from "../tauri/invoke";

export function sortShelves(list: Shelf[]): Shelf[] {
  return [...list].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "zh") || a.id - b.id,
  );
}

/** 从根到 id（含）的祖先链；id 为 null 时为空（根视图） */
export function shelfPath(shelves: Shelf[], id: number | null): Shelf[] {
  const byId = new Map(shelves.map((s) => [s.id, s]));
  const path: Shelf[] = [];
  let cur = id == null ? null : byId.get(id) ?? null;
  let guard = 0;
  while (cur && guard++ < 100) {
    path.unshift(cur);
    cur = cur.parent_id == null ? null : byId.get(cur.parent_id) ?? null;
  }
  return path;
}

export type ShelfTreeRow = Shelf & { depth: number };

/** 深度优先缩进行序（侧栏树与"移动到书架"树选择共用） */
export function shelfTreeRows(shelves: Shelf[]): ShelfTreeRow[] {
  const rows: ShelfTreeRow[] = [];
  const walk = (parentId: number | null, depth: number) => {
    for (const s of sortShelves(shelves)) {
      if ((s.parent_id ?? null) !== parentId) continue;
      rows.push({ ...s, depth });
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** id 的全部后代（不含自身）——移动书架时从目标列表里排除，杜绝成环入口 */
export function descendantIds(shelves: Shelf[], id: number): Set<number> {
  const byParent = new Map<number | null, Shelf[]>();
  for (const s of shelves) {
    const key = s.parent_id ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), s]);
  }
  const out = new Set<number>();
  const walk = (pid: number) => {
    for (const s of byParent.get(pid) ?? []) {
      out.add(s.id);
      walk(s.id);
    }
  };
  walk(id);
  return out;
}

export function countByShelf(books: Book[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const b of books) {
    if (b.shelf_id == null) continue;
    m.set(b.shelf_id, (m.get(b.shelf_id) ?? 0) + 1);
  }
  return m;
}

/** 回收站剩余保留天数：0=永不；负数不会出现（后端到期即清） */
export function trashRemainingDays(deletedAt: number, retentionDays: number, now: number): number | null {
  if (retentionDays <= 0) return null;
  return Math.max(0, retentionDays - Math.floor((now - deletedAt) / 86400));
}
