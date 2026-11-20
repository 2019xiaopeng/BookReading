// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// invoke 层全 mock（惯例照 LibraryPage.test.ts 的 mock 边界：不碰真 Tauri）
vi.mock("../tauri/wenku8", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri/wenku8")>();
  return {
    ...actual,
    wenku8Login: vi.fn(),
    wenku8Logout: vi.fn(),
    wenku8Status: vi.fn(),
    wenku8Bookshelf: vi.fn(),
    wenku8BookInfo: vi.fn(),
    wenku8Download: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// 壳渲染透传：页面行为测试不背 AppShell 的 Tauri 面（设置/托盘/拖拽导入）；contextRow 透传出来便于断言（D3）
vi.mock("../ui/AppShell", () => ({
  default: (props: { children?: React.ReactNode; contextRow?: React.ReactNode }) => (
    <div>
      {props.contextRow}
      {props.children}
    </div>
  ),
}));

import {
  wenku8BookInfo,
  wenku8Bookshelf,
  wenku8Download,
  wenku8Login,
  wenku8Logout,
  wenku8Status,
  type Wenku8DownloadResult,
  type Wenku8ProgressEvent,
} from "../tauri/wenku8";
import { listen } from "@tauri-apps/api/event";
import CloudShelfPage from "./CloudShelfPage";

const statusMock = vi.mocked(wenku8Status);
const loginMock = vi.mocked(wenku8Login);
const logoutMock = vi.mocked(wenku8Logout);
const shelfMock = vi.mocked(wenku8Bookshelf);
const infoMock = vi.mocked(wenku8BookInfo);
const downloadMock = vi.mocked(wenku8Download);
const listenMock = vi.mocked(listen);

function renderCloudShelf() {
  return render(
    <MemoryRouter initialEntries={["/cloud-shelf"]}>
      <Routes>
        <Route path="/cloud-shelf" element={<CloudShelfPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("云书架页（v3.0）", () => {
  test("未登录渲染登录表单；登录失败显示 errcode 文案（errcode 3 → 密码错误）", async () => {
    statusMock.mockResolvedValue({ has_saved: false, username: null });
    loginMock.mockResolvedValue({ ok: false, errcode: 3, message: "" });

    renderCloudShelf();

    const user = await screen.findByPlaceholderText("用户名");
    const pass = screen.getByPlaceholderText("密码");
    expect(pass).toHaveProperty("type", "password");
    fireEvent.change(user, { target: { value: "someone" } });
    fireEvent.change(pass, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("密码错误")).toBeTruthy();
    expect(loginMock).toHaveBeenCalledWith("someone", "wrong");
  });

  test("has_saved 渲染书卡列表；书名只在 meta 区渲染一处（D1），name 为 null 的书懒取 bookInfo 补书名", async () => {
    statusMock.mockResolvedValue({ has_saved: true, username: "u" });
    shelfMock.mockResolvedValue([
      { aid: 101, name: "绑架游戏", date: "2024-01-02" },
      { aid: 202, name: null, date: null },
    ]);
    infoMock.mockResolvedValue({
      aid: 202,
      title: "白夜行",
      author: "东野圭吾",
      status: "连载中",
      last_update: "2024-01-01",
      latest_cid: 1,
      intro: null,
    });

    renderCloudShelf();

    // D1：封面 overlay 仅在封面拉挂时显示书名（jsdom 里 img 不加载也不报错 → 只有 meta 一处）
    expect((await screen.findAllByText("绑架游戏")).length).toBe(1);
    await waitFor(() => expect(infoMock).toHaveBeenCalledWith(202));
    expect((await screen.findAllByText("白夜行")).length).toBe(1);
    expect(screen.getByTitle("2024-01-02").textContent).toBe("2024-01-02");
    // D1 刊头：书库同款大版统计（wenku8 · 用户名 · 共 n 本）
    expect(screen.getByText("wenku8 · u · 共 2 本")).toBeTruthy();
  });

  test("点击拉取 → 悬浮层进度墨线随进度事件更新 → download resolve 后 ✓ 已入库", async () => {
    statusMock.mockResolvedValue({ has_saved: true, username: "u" });
    shelfMock.mockResolvedValue([{ aid: 101, name: "绑架游戏", date: "2024-01-02" }]);
    let resolveDownload!: (v: Wenku8DownloadResult) => void;
    downloadMock.mockImplementation(
      () => new Promise<Wenku8DownloadResult>((res) => (resolveDownload = res)),
    );

    renderCloudShelf();

    fireEvent.click(await screen.findByRole("button", { name: "拉取到书库" }));

    // listen 注册的进度回调按 aid 过滤后更新进度条
    const handler = listenMock.mock.calls[0]?.[1] as (e: { payload: Wenku8ProgressEvent }) => void;
    act(() => handler({ payload: { aid: 101, done: 2, total: 5 } }));
    act(() => handler({ payload: { aid: 999, done: 9, total: 9 } })); // 其它书不干扰
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
    expect(within(bar).getByText("40%")).toBeTruthy();

    await act(async () => {
      resolveDownload({ book_id: "b1", title: "绑架游戏", chapters: 12 });
    });
    expect(await screen.findByText("✓ 已入库")).toBeTruthy();
    // D1：完成后不再给「去书库」次按钮（点卡片/侧栏回书库即可）
    expect(screen.queryByRole("button", { name: "去书库" })).toBeNull();
  });

  test("D3 上下文行显示账号与上次同步时间；退出登录调 wenku8Logout 清账密回登录卡", async () => {
    statusMock.mockResolvedValue({ has_saved: true, username: "u" });
    shelfMock.mockResolvedValue([{ aid: 101, name: "绑架游戏", date: null }]);
    logoutMock.mockResolvedValue(undefined);

    renderCloudShelf();

    expect(await screen.findByText(/u · 上次同步 \d{2}:\d{2}/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(await screen.findByPlaceholderText("用户名")).toBeTruthy();
    expect(logoutMock).toHaveBeenCalledTimes(1);
    // 上下文行随登录卡消失
    expect(screen.queryByText(/上次同步/)).toBeNull();
  });
});
