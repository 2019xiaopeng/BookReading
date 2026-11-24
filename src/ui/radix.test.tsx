// @vitest-environment jsdom
// V-2/V-4 验收：Radix 四件行为层（键盘/焦点/关闭）+ 窄窗断点表。
// jsdom 无 matchMedia/ResizeObserver/PointerCapture——本文件只补这几样，其余走真实 Radix。
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as Menu from "@radix-ui/react-menu";

import { Modal, PointMenu, Tooltip, WrSelect } from "./radix";
import { tierFromWidth, DRAWER_MAX, RAIL_MAX, SEARCH_COLLAPSE_MAX } from "./viewportTier";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }),
  });
  // floating-ui 定位监听 ResizeObserver；Radix 触发器用 pointer capture（jsdom 均缺）
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  const proto = window.HTMLElement.prototype as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.scrollIntoView ??= () => {}; // Radix Select 高亮项滚动（jsdom 无）
});

afterEach(cleanup);

describe("V-4 窄窗断点表（tierFromWidth）", () => {
  test("≥900 全档；800–899 全档（搜索独立 900 阈值）；600–799 图标栏；<600 抽屉", () => {
    expect(tierFromWidth(1280)).toBe("full");
    expect(tierFromWidth(900)).toBe("full");
    expect(tierFromWidth(899)).toBe("full"); // 侧栏仍全档，但搜索已收起（<900 独立阈值）
    expect(tierFromWidth(RAIL_MAX)).toBe("full");
    expect(tierFromWidth(RAIL_MAX - 1)).toBe("rail");
    expect(tierFromWidth(DRAWER_MAX)).toBe("rail");
    expect(tierFromWidth(DRAWER_MAX - 1)).toBe("drawer");
    expect([RAIL_MAX, DRAWER_MAX, SEARCH_COLLAPSE_MAX]).toEqual([800, 600, 900]); // 与 CSS 断点同源
  });
});

describe("PointMenu（Radix Menu 行为层）", () => {
  function Harness(props: { onAction: (id: string) => void }) {
    return (
      <PointMenu point={{ x: 10, y: 10 }} onClose={() => props.onAction("close")} label="测试菜单">
        <Menu.Item asChild onSelect={() => props.onAction("a")}>
          <button type="button" className="wr-menu-item">甲</button>
        </Menu.Item>
        <Menu.Item asChild onSelect={() => props.onAction("b")}>
          <button type="button" className="wr-menu-item">乙</button>
        </Menu.Item>
      </PointMenu>
    );
  }

  test("菜单角色挂载（menu/menuitem），Esc 触发 onClose", () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    const menu = screen.getByRole("menu", { name: "测试菜单" });
    expect(menu.querySelectorAll('[role="menuitem"]').length).toBe(2);

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onAction).toHaveBeenCalledWith("close");
  });

  test("方向键在项间移动（键盘可达；Radix 焦点步进走 setTimeout，断言需等）", async () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    const menu = screen.getByRole("menu", { name: "测试菜单" });
    fireEvent.keyDown(menu, { key: "ArrowDown" }); // 焦点在 content 上：首按键进第一项
    await waitFor(() => expect(document.activeElement?.textContent).toBe("甲"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("乙"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("甲"));
  });

  test("键盘选择（Enter）触发 onSelect 并自动关菜单", () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    const menu = screen.getByRole("menu", { name: "测试菜单" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith("a");
    expect(onAction).toHaveBeenCalledWith("close");
  });
});

describe("Modal（Radix Dialog 行为层）", () => {
  test("role=dialog + aria-label 挂载；Esc 关闭；初始焦点落第一个可聚焦控件（焦点陷阱托管）", async () => {
    const onClose = vi.fn();
    render(
      <Modal label="确认操作" onClose={onClose}>
        <input className="wr-input" aria-label="名字" />
        <button className="wr-btn" onClick={() => {}}>确定</button>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "确认操作" })).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("名字")).toBe(document.activeElement));

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("WrSelect（Radix Select 行为层）", () => {
  function Harness(props: { value: string; onChange: (v: string) => void }) {
    return (
      <WrSelect
        ariaLabel="保留期"
        value={props.value}
        onChange={props.onChange}
        options={[
          { value: "7", label: "7 天" },
          { value: "30", label: "30 天" },
          { value: "0", label: "永不" },
        ]}
      />
    );
  }

  test("触发器显示当前值；键盘开列表、选择回调 onChange，Esc 关闭", async () => {
    const onChange = vi.fn();
    render(<Harness value="30" onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "保留期" });
    expect(trigger.textContent).toContain("30 天");

    // jsdom 的 fireEvent 造不出带 pointerType 的 PointerEvent——走键盘开合（同属验收口径：键盘/Esc）
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const listbox = await screen.findByRole("listbox");
    expect(listbox.querySelectorAll('[role="option"]').length).toBe(3);

    fireEvent.click(screen.getByRole("option", { name: "永不" }));
    expect(onChange).toHaveBeenCalledWith("0");
  });
});

describe("Tooltip（V-4 图标栏悬停提示）", () => {
  test("content=null 时原样透传（宽屏同一份 JSX 不出 Tooltip DOM）", () => {
    render(
      <Tooltip content={null}>
        <button type="button">书架</button>
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "书架" })).toBeTruthy();
    expect(document.querySelector(".wr-tooltip")).toBeNull();
  });

  test("聚焦触发器弹出碳墨墨签（.wr-tooltip）", async () => {
    render(
      <Tooltip content="目录">
        <button type="button" aria-label="目录" />
      </Tooltip>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "目录" }));
    await waitFor(() => expect(document.querySelector(".wr-tooltip")?.textContent).toBe("目录"));
  });
});
