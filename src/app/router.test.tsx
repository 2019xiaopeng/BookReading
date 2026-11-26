// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
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
import { introState } from "../ui/intro";

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

  // v3.2（V-3，用户定稿 PyCharm 式）：设置是浮在当前页上的居中浮窗——侧栏「设置」钮打开，
  // 底下的书架页不切走（滚动位置、选中书架、侧栏快捷行都原样），Esc 关闭，壳照旧不重挂
  test("侧栏「设置」钮打开设置浮窗：不切页（书架页仍在）、八个分区、Esc 关闭、壳不重挂", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<FakeLibrary />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const side = document.querySelector(".wr-side-bottom");
    const settingsBtn = screen.getByRole("button", { name: "设置" });
    expect(settingsBtn.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(settingsBtn);
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(within(dialog).getAllByRole("tab")).toHaveLength(8);
    expect(within(dialog).getByText("设 置")).toBeTruthy(); // 与书架 / 收藏刊头同款大字标题
    expect(screen.getByTestId("page-library")).toBeTruthy(); // 底下还是书架页
    expect(document.querySelector(".wr-side-bottom")).toBe(side);
    expect(settingsBtn.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".wr-nav-btn[data-active='true']")?.textContent).toContain("书架"); // 书架仍是当前页

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull());
    expect(screen.getByTestId("page-library")).toBeTruthy();
  });
});

describe("V-3 开场动画（只播一次）", () => {
  /** 阅读页在壳外：进 /read 卸载壳、回 / 重挂 */
  function Nav({ to, label }: { to: string; label: string }) {
    const nav = useNavigate();
    return (
      <button data-testid={label} onClick={() => nav(to)}>
        go
      </button>
    );
  }
  const hasIntro = () => document.querySelector(".wr-shell")?.classList.contains("wr-shell--intro") === true;
  const animationEnd = (name: string) => {
    // jsdom 没有 AnimationEvent：手工造一个带 animationName 的 animationend
    const e = new Event("animationend", { bubbles: true });
    Object.defineProperty(e, "animationName", { value: name });
    document.querySelector(".wr-shell")!.dispatchEvent(e);
  };
  const tree = (
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Nav to="/read/1" label="to-reader" />} />
        </Route>
        <Route path="/read/:bookId" element={<Nav to="/" label="to-library" />} />
      </Routes>
    </MemoryRouter>
  );

  test("进程内第一次挂载壳才带 .wr-shell--intro；主栏那段播完才撤类；壳重挂不重播", async () => {
    introState.pending = true;
    render(tree);
    expect(hasIntro()).toBe(true);
    await waitFor(() => expect(introState.pending).toBe(false)); // 挂载后标记即消耗

    // animationend 会从子孙冒泡：别的动画、以及先结束的侧栏那段都不算
    animationEnd("wr-something-else");
    expect(hasIntro()).toBe(true);
    animationEnd("wr-intro-in"); // target 是壳根自己（不是 .wr-main）
    expect(hasIntro()).toBe(true);

    // 去阅读页（壳卸载）再回来（壳重挂）：不重播
    fireEvent.click(screen.getByTestId("to-reader"));
    await waitFor(() => expect(screen.getByTestId("to-library")).toBeTruthy());
    expect(document.querySelector(".wr-shell")).toBeNull();
    fireEvent.click(screen.getByTestId("to-library"));
    await waitFor(() => expect(screen.getByTestId("to-reader")).toBeTruthy());
    expect(hasIntro()).toBe(false);
  });

  test("主栏那段开场动画结束 → 撤类", async () => {
    introState.pending = true;
    render(tree);
    expect(hasIntro()).toBe(true);
    const e = new Event("animationend", { bubbles: true });
    Object.defineProperty(e, "animationName", { value: "wr-intro-in" });
    document.querySelector(".wr-main")!.dispatchEvent(e);
    await waitFor(() => expect(hasIntro()).toBe(false));
  });
});
