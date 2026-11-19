/**
 * R-2 Shift 范围多选（书架书卡 / 回收站行 / 收藏页书卡三处共用）：
 * list 必须是当前可见过滤视图的顺序 id 列表（范围与全选同一口径）。
 * 纯函数：不修改入参 selected，返回新 Set。
 */
export function applyRangeSelect(
  list: string[],
  currentId: string,
  selected: Set<string>,
  shift: boolean,
  lastId: string | null,
): { selected: Set<string>; lastId: string | null } {
  if (!shift) {
    const next = new Set(selected);
    if (next.has(currentId)) next.delete(currentId);
    else next.add(currentId);
    return { selected: next, lastId: currentId };
  }
  // Shift：锚点缺失或不在当前过滤列表（跨视图/被过滤掉）→ 退化为普通切换
  const from = lastId != null ? list.indexOf(lastId) : -1;
  const to = list.indexOf(currentId);
  if (from < 0 || to < 0) {
    const next = new Set(selected);
    if (next.has(currentId)) next.delete(currentId);
    else next.add(currentId);
    return { selected: next, lastId: currentId };
  }
  const range = list.slice(Math.min(from, to), Math.max(from, to) + 1);
  const allSelected = range.every((id) => selected.has(id));
  const next = new Set(selected);
  for (const id of range) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  // 锚点不动：连续 Shift 点击始终相对同一起点取范围
  return { selected: next, lastId };
}
