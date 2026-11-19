import type { Book, Shelf } from "../tauri/invoke";
import { bookMatchesQuery } from "./bookFormat";

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

/** K-3 递归计数：直属 + 全部后代的书（每本书沿祖先链各记一次；环由深度守卫兜底） */
export function countByShelfDeep(shelves: Shelf[], books: Book[]): Map<number, number> {
  const parent = new Map(shelves.map((s) => [s.id, s.parent_id ?? null]));
  const m = new Map<number, number>();
  for (const b of books) {
    let cur = b.shelf_id ?? null;
    let guard = 0;
    while (cur != null && parent.has(cur) && guard++ < 100) {
      m.set(cur, (m.get(cur) ?? 0) + 1);
      cur = parent.get(cur) ?? null;
    }
  }
  return m;
}

/** W-1 搜索态子书架过滤：本架或后代架名匹配、或子树内有命中书的架保留（资源管理器式——命中的
 *  嵌套架其祖先链可达，否则根视图永远看不到它）；hits=子树命中书数（纯名匹配为 0）。query 为空时全保留。 */
export function filterShelvesBySearch(
  shelves: Shelf[],
  parentId: number | null,
  books: Book[],
  query: string,
): { shelf: Shelf; hits: number }[] {
  const q = query.trim().toLowerCase();
  const byId = new Map(shelves.map((s) => [s.id, s]));
  const out: { shelf: Shelf; hits: number }[] = [];
  for (const shelf of sortShelves(shelves).filter((s) => (s.parent_id ?? null) === parentId)) {
    if (!q) {
      out.push({ shelf, hits: 0 });
      continue;
    }
    const ids = descendantIds(shelves, shelf.id);
    ids.add(shelf.id);
    let hits = 0;
    for (const b of books) {
      if (b.shelf_id != null && ids.has(b.shelf_id) && bookMatchesQuery(b, q)) hits++;
    }
    const nameHit = [...ids].some((id) => byId.get(id)?.name.toLowerCase().includes(q));
    if (hits > 0 || nameHit) out.push({ shelf, hits });
  }
  return out;
}

/** 每架固定取前 max 本（书库顺序）：四宫格封面选择与加载状态无关，不随封面到达顺序洗牌 */
export function firstBooksByShelf(books: Book[], max = 4): Map<number, Book[]> {
  const m = new Map<number, Book[]>();
  for (const b of books) {
    if (b.shelf_id == null) continue;
    const list = m.get(b.shelf_id);
    if (list == null) m.set(b.shelf_id, [b]);
    else if (list.length < max) list.push(b);
  }
  return m;
}

/** 回收站剩余保留天数：0=永不；负数不会出现（后端到期即清） */
export function trashRemainingDays(deletedAt: number, retentionDays: number, now: number): number | null {
  if (retentionDays <= 0) return null;
  return Math.max(0, retentionDays - Math.floor((now - deletedAt) / 86400));
}
