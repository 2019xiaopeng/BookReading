// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useLayoutEffect } from "react";

// 真壳直渲染（不 mock AppShell）：只 mock 壳的 Tauri 面（webview 拖放/版本号/DB 读写），侧栏树数据给空
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => Promise.resolve("3.0.0"),
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

import { AppLayout } from "./router";
import { setPageMeta } from "../ui/pageMeta";

// 假页面照真实页面同款：布局期（useLayoutEffect）注册本页元信息
function FakeLibrary() {
  useLayoutEffect(() => {
    setPageMeta({ active: "library", title: "书架" });
  }, []);
  return <div data-testid="page-library">library</div>;
}

function FakeFavorites() {
  useLayoutEffect(() => {
    setPageMeta({ active: "favorites", title: "收藏" });
  }, []);
  return <div data-testid="page-favorites">favorites</div>;
}

afterEach(cleanup);

describe("AppLayout 常驻壳（批次8 防回归红线）", () => {
  test("路由切换壳不重挂：.wr-side-bottom 同一 DOM 实例；页元信息（active/title）即时注入常驻壳", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<FakeLibrary />} />
            <Route path="/favorites" element={<FakeFavorites />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("page-library")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "书架" })).toBeTruthy();

    const side = document.querySelector(".wr-side-bottom");
    expect(side).toBeTruthy();

    // 侧栏「收藏」导航钮切页
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    await waitFor(() => expect(screen.getByTestId("page-favorites")).toBeTruthy());

    // 验收红线：底部四钮容器未被卸载重挂——同一 DOM 节点引用
    expect(document.querySelector(".wr-side-bottom")).toBe(side);

    // 页元信息经 pageMeta store 注入常驻壳：标题随新页生效、侧栏 active 换位
    expect(screen.getByRole("heading", { name: "收藏" })).toBeTruthy();
    expect(document.querySelector(".wr-nav-btn[data-active='true']")?.textContent).toContain("收藏");
  });
});
