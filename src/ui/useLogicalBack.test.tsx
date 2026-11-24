// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useEffect } from "react";

import type { Shelf } from "../tauri/invoke";

const sh = (id: number, parent_id: number | null): Shelf => ({
  id,
  name: `s${id}`,
  parent_id,
  sort_order: id,
  created_at: 0,
});

// 树：1 根 → 2 → 3；4 独立根级
const SHELVES = [sh(1, null), sh(2, 1), sh(3, 2), sh(4, null)];

// hook 从 AppShell 取书架缓存：mock 掉以避开整壳的 Tauri 依赖（vi.mock 提升故经 hoisted 槽位传数据）
const shelvesSlot = vi.hoisted(() => ({ current: [] as Shelf[] }));
vi.mock("./AppShell", () => ({ getShelvesCache: () => shelvesSlot.current }));

import useLogicalBack, { logicalBackTarget } from "./useLogicalBack";

describe("logicalBackTarget（M-3 侧键逻辑回溯目标）", () => {
  test("阅读页：有 fromShelf → 来源书架；无 state → 书库根", () => {
    expect(logicalBackTarget("/read/b1", "", SHELVES, { fromShelf: 3 })).toBe("/?shelf=3");
    expect(logicalBackTarget("/read/b1", "?cfi=x", SHELVES, null)).toBe("/");
    expect(logicalBackTarget("/read/b1", "", SHELVES, { fromShelf: null })).toBe("/");
  });

  test("书库：子架 → 父架；根级架/根视图 → 无操作", () => {
    expect(logicalBackTarget("/", "?shelf=3", SHELVES, null)).toBe("/?shelf=2");
    expect(logicalBackTarget("/", "?shelf=2", SHELVES, null)).toBe("/?shelf=1");
    expect(logicalBackTarget("/", "?shelf=4", SHELVES, null)).toBeNull();
    expect(logicalBackTarget("/", "", SHELVES, null)).toBeNull();
    // 已删除的架（树里查无此 id）→ 无操作，交给 LibraryPage 悬空回根纠偏
    expect(logicalBackTarget("/", "?shelf=99", SHELVES, null)).toBeNull();
  });

  test("收藏 / 回收站 → 书库根；其它路径无操作", () => {
    expect(logicalBackTarget("/favorites", "", SHELVES, null)).toBe("/");
    expect(logicalBackTarget("/", "?trash=1", SHELVES, null)).toBe("/");
    expect(logicalBackTarget("/favorites", "?x=1", SHELVES, null)).toBe("/");
    expect(logicalBackTarget("/whatever", "", SHELVES, null)).toBeNull();
  });
});

/** 挂钩探针：记录每次路由变化（含初始），驱动断言"松手后不再弹回" */
function Probe({ log }: { log: string[] }) {
  useLogicalBack();
  const loc = useLocation();
  useEffect(() => {
    log.push(loc.pathname + loc.search);
  }, [loc.pathname, loc.search]);
  return null;
}

/** 派发指定键位的鼠标事件，返回 dispatchEvent 结果（false = preventDefault 已吃掉默认行为） */
function mouse(type: "mousedown" | "mouseup", button: number): boolean {
  return window.dispatchEvent(new MouseEvent(type, { button, bubbles: true, cancelable: true }));
}

afterEach(cleanup);

describe("useLogicalBack 侧键两相拦截（U-2 松手弹回）", () => {
  test("后退侧键：mousedown 逻辑回上一级，mouseup 同样被吞（默认回退无路可走）", () => {
    shelvesSlot.current = SHELVES;
    const log: string[] = [];
    render(
      <MemoryRouter initialEntries={["/?shelf=3"]}>
        <Probe log={log} />
      </MemoryRouter>,
    );
    expect(log).toEqual(["/?shelf=3"]);
    act(() => {
      expect(mouse("mousedown", 3)).toBe(false); // 捕获相 preventDefault 生效
    });
    expect(log).toEqual(["/?shelf=3", "/?shelf=2"]); // 最深层子架 → 父架
    act(() => {
      expect(mouse("mouseup", 3)).toBe(false); // U-2：松手相也吞掉
    });
    expect(log).toEqual(["/?shelf=3", "/?shelf=2"]); // 不再弹回最深层
  });

  test("前进侧键：两相吞掉且不触发任何导航", () => {
    shelvesSlot.current = SHELVES;
    const log: string[] = [];
    render(
      <MemoryRouter initialEntries={["/?shelf=2"]}>
        <Probe log={log} />
      </MemoryRouter>,
    );
    act(() => {
      expect(mouse("mousedown", 4)).toBe(false);
      expect(mouse("mouseup", 4)).toBe(false);
    });
    expect(log).toEqual(["/?shelf=2"]);
  });

  test("主键（button 0）不受影响：默认行为放行、无导航", () => {
    shelvesSlot.current = SHELVES;
    const log: string[] = [];
    render(
      <MemoryRouter initialEntries={["/?shelf=3"]}>
        <Probe log={log} />
      </MemoryRouter>,
    );
    act(() => {
      expect(mouse("mousedown", 0)).toBe(true);
      expect(mouse("mouseup", 0)).toBe(true);
    });
    expect(log).toEqual(["/?shelf=3"]);
  });
});
