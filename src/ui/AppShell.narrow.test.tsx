// @vitest-environment jsdom
// V-4 窄窗断点渲染断言（JS 侧）：<900 搜索图标化、600–799 树折叠为根级+激活链、<600 抽屉。
// CSS 断点（宽度/藏字/宫格）不在 jsdom 生效——这里只断 JS 档位驱动的 DOM 结构差异。
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => Promise.resolve("3.2.0"),
}));
vi.mock("../tauri/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri/invoke")>();
  return {
    ...actual,
    getSettings: vi.fn(async () => ({})),
    listBooks: vi.fn(async () => []),
    listShelves: vi.fn(async () => []),
    setSetting: vi.fn(async () => undefined),
  };
});

import AppShell from "./AppShell";
import { setShelvesCache } from "./AppShell";
import type { Shelf } from "../tauri/invoke";

// 可配置的 matchMedia：按查询表回 matches（jsdom 无实现）
const matchesByQuery = new Map<string, boolean>();
function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: matchesByQuery.get(query) ?? false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }),
  });
}

const shelf = (id: number, parent_id: number | null, name: string): Shelf => ({
  id,
  name,
  parent_id,
  sort_order: id,
  created_at: 0,
});
// 树：文学(1) → 小说(2) → 科幻(3)；文学 → 散文(5)；漫画(4)
const TREE = [shelf(1, null, "文学"), shelf(2, 1, "小说"), shelf(3, 2, "科幻"), shelf(4, null, "漫画"), shelf(5, 1, "散文")];

function renderShell(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AppShell active="library" title="书架" search={{ value: "", placeholder: "搜索书名 / 作者", onChange: () => {} }}>
        <div data-testid="page" />
      </AppShell>
    </MemoryRouter>,
  );
}

beforeAll(installMatchMedia);
afterEach(() => {
  cleanup();
  matchesByQuery.clear();
  setShelvesCache([]);
});

describe("V-4 <900：搜索收为图标，点击展开浮层输入框并聚焦", () => {
  test("宽屏常驻输入框；窄屏先出图标钮，点击后输入框出现且聚焦", async () => {
    // 宽屏（≥900）：常驻大胶囊
    const { unmount } = renderShell("/");
    expect(document.querySelector(".wr-search-input")).toBeTruthy();
    unmount();

    // 窄屏（<900）：图标钮 + 无输入框
    matchesByQuery.set("(max-width: 899px)", true);
    renderShell("/");
    expect(document.querySelector(".wr-search-input")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(document.querySelector(".wr-search-input")).toBe(document.activeElement));
  });
});

describe("V-4 600–799 图标栏：书架树只留根级 + 当前激活链", () => {
  test("?shelf=3 时渲染 文学/小说/科幻/漫画 四行（散文折叠）", async () => {
    matchesByQuery.set("(max-width: 899px)", true);
    matchesByQuery.set("(max-width: 799px)", true);
    renderShell("/?shelf=3");
    setShelvesCache(TREE);
    await waitFor(() => {
      const names = [...document.querySelectorAll(".wr-nav-group-btn")].map((b) => b.textContent?.replace(/[▾▸]/g, ""));
      expect(names).toEqual(["文学", "小说", "科幻", "漫画"]);
    });
  });
});

describe("V-4 <600 抽屉：汉堡钮开关侧栏", () => {
  test("点击汉堡出现 data-open 侧栏与遮罩；点遮罩收回", async () => {
    matchesByQuery.set("(max-width: 899px)", true);
    matchesByQuery.set("(max-width: 799px)", true);
    matchesByQuery.set("(max-width: 599px)", true);
    renderShell("/");
    const side = document.querySelector(".wr-side") as HTMLElement;
    expect(side.getAttribute("data-open")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开侧栏" }));
    expect(side.getAttribute("data-open")).toBe("true");
    expect(document.querySelector(".wr-side-drawer-scrim")).toBeTruthy();

    fireEvent.click(document.querySelector(".wr-side-drawer-scrim")!);
    expect(side.getAttribute("data-open")).toBeNull();
  });
});
