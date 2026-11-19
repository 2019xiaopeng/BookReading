import { describe, expect, test } from "vitest";

// 壳纱浓度（F1-6）：壳层读 settings 键 bg_veil；数值钳位走统一 normalizer（阅读器侧同键共用），
// 壳层只补一条本项目约定——空串=未设置（library_status 同款），不能当 0 钳到 60
import { parseBgVeil, rollupShelfCounts, shouldShowHighlights, filterCollapsedRows } from "./AppShell";
import type { Book, Shelf } from "../tauri/invoke";
import { shelfTreeRows } from "../library/shelves";

describe("parseBgVeil（bg_veil 解析钳位）", () => {
  test("缺省与非法输入回 88", () => {
    expect(parseBgVeil(undefined)).toBe(88);
    expect(parseBgVeil("")).toBe(88);
    expect(parseBgVeil("abc")).toBe(88);
  });

  test("60–95 区间内原样生效（小数四舍五入）", () => {
    expect(parseBgVeil("88")).toBe(88);
    expect(parseBgVeil("60")).toBe(60);
    expect(parseBgVeil("95")).toBe(95);
    expect(parseBgVeil("72.4")).toBe(72);
  });

  test("越界钳到 60–95", () => {
    expect(parseBgVeil("10")).toBe(60);
    expect(parseBgVeil("100")).toBe(95);
    expect(parseBgVeil("-5")).toBe(60);
  });
});

// K-4 侧栏书架计数：直接归属计数上卷到祖先（父架=自身+全部后代）
const shelf = (id: number, parent_id: number | null): Shelf => ({
  id,
  name: `s${id}`,
  parent_id,
  sort_order: id,
  created_at: 0,
});

const book = (shelf_id: number | null): Book => ({
  id: `b${Math.random()}`,
  title: null,
  author: null,
  cover_path: null,
  library_path: "x",
  added_at: 0,
  last_opened_at: null,
  note: null,
  pinned_at: null,
  reading_percent: null,
  is_favorite: false,
  format: "epub",
  page_count: null,
  shelf_id,
  sort_order: null,
  deleted_at: null,
  description: null,
  content_chars: null,
  file_size: null,
  tags: [],
});

describe("rollupShelfCounts（K-4 递归上卷）", () => {
  test("父架计数 = 自身 + 后代；空架为 0；根上书不计入任何架", () => {
    const shelves = [shelf(1, null), shelf(2, 1), shelf(3, null)];
    const books = [book(2), book(2), book(1), book(null)];
    const counts = rollupShelfCounts(shelves, books);
    expect(counts.get(1)).toBe(3); // 1 直接 + 2 的两本（后代上卷）
    expect(counts.get(2)).toBe(2);
    expect(counts.get(3)).toBe(0);
  });

  test("无书 / 无书架均安全", () => {
    expect(rollupShelfCounts([], [book(1)]).size).toBe(0);
    expect(rollupShelfCounts([shelf(1, null)], []).get(1)).toBe(0);
  });
});

// S-1 侧栏树折叠：祖先折叠则隐藏该行（S-4 计数上卷不受影响——rollupShelfCounts 不过滤）
describe("filterCollapsedRows（S-1 折叠过滤）", () => {
  // 树：1 根 → 2 → 3；4 另一独立根 → 5
  const shelves = [shelf(1, null), shelf(2, 1), shelf(3, 2), shelf(4, null), shelf(5, 4)];
  const rows = shelfTreeRows(shelves);

  test("空折叠集 = 原样", () => {
    expect(filterCollapsedRows(rows, new Set())).toBe(rows);
  });

  test("折叠父架隐藏整个子树，兄弟分支不受影响", () => {
    const out = filterCollapsedRows(rows, new Set([1]));
    expect(out.map((r) => r.id)).toEqual([1, 4, 5]);
    const out2 = filterCollapsedRows(rows, new Set([2]));
    expect(out2.map((r) => r.id)).toEqual([1, 2, 4, 5]);
  });

  test("折叠全部父级 → 只剩根级行（S-2 全部收起口径）", () => {
    const parents = new Set(shelves.filter((s) => shelves.some((c) => c.parent_id === s.id)).map((s) => s.id));
    expect(filterCollapsedRows(rows, parents).map((r) => r.id)).toEqual([1, 4]);
  });

  test("折叠集含已删除的架 id → 无影响", () => {
    const out = filterCollapsedRows(rows, new Set([99]));
    expect(out.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

// H-9 升级亮点：last_seen 存在且 ≠ 当前才弹窗（首启只落库）
describe("shouldShowHighlights（H-9 版本比较）", () => {
  test("上次版本存在且不同 → true", () => {
    expect(shouldShowHighlights("2.6.0", "2.7.0")).toBe(true);
  });

  test("首启（无 last_seen）/ 空串 / 同版本 → false", () => {
    expect(shouldShowHighlights(undefined, "2.7.0")).toBe(false);
    expect(shouldShowHighlights("", "2.7.0")).toBe(false);
    expect(shouldShowHighlights("2.7.0", "2.7.0")).toBe(false);
  });
});
