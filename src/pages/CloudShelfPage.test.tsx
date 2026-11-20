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
    wenku8Catalog: vi.fn(),
  };
});

// F1 目标书架下拉走 invoke.ts 的 listShelves/getSettings/setSetting，同样 mock 掉
vi.mock("../tauri/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri/invoke")>();
  return {
    ...actual,
    listShelves: vi.fn(),
    getSettings: vi.fn(),
    setSetting: vi.fn(),
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
  wenku8Catalog,
  wenku8Download,
  wenku8Login,
  wenku8Logout,
  wenku8Status,
  type Wenku8DownloadResult,
  type Wenku8ProgressEvent,
} from "../tauri/wenku8";
import { getSettings, listShelves, setSetting } from "../tauri/invoke";
import { listen } from "@tauri-apps/api/event";
// 批次8：页面不再自带壳，按真实结构挂 AppLayout 下（mock 壳从 pageMeta 拿 contextRow 渲染）
import { AppLayout } from "../app/router";
import CloudShelfPage, { resetCloudShelfCacheForTests } from "./CloudShelfPage";

const statusMock = vi.mocked(wenku8Status);
const loginMock = vi.mocked(wenku8Login);
const logoutMock = vi.mocked(wenku8Logout);
const shelfMock = vi.mocked(wenku8Bookshelf);
const infoMock = vi.mocked(wenku8BookInfo);
const downloadMock = vi.mocked(wenku8Download);
const catalogMock = vi.mocked(wenku8Catalog);
const shelvesMock = vi.mocked(listShelves);
const getSettingsMock = vi.mocked(getSettings);
const setSettingMock = vi.mocked(setSetting);
const listenMock = vi.mocked(listen);

function bookInfo(aid: number, title: string, latest_cid = 1) {
  return {
    aid,
    title,
    author: "作者X",
    status: "连载中",
    last_update: "2024-01-01",
    latest_cid,
    intro: "这是简介内容。",
  };
}

function renderCloudShelf() {
  return render(
    <MemoryRouter initialEntries={["/cloud-shelf"]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/cloud-shelf" element={<CloudShelfPage />} />
        </Route>
        <Route path="/read/:bookId" element={<div data-testid="read-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // P-2 会话缓存（书架列表/懒取名/新章标记）是模块级，会跨用例泄漏
  resetCloudShelfCacheForTests();
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
      { aid: 101, name: "绑架游戏", date: "2024-01-02", book_id: null, last_cid: 0 },
      { aid: 202, name: null, date: null, book_id: null, last_cid: 0 },
    ]);
    infoMock.mockResolvedValue(bookInfo(202, "白夜行"));
    shelvesMock.mockResolvedValue([]);
    getSettingsMock.mockResolvedValue({});

    renderCloudShelf();

    // D1：封面 overlay 仅在封面拉挂时显示书名（jsdom 里 img 不加载也不报错 → 只有 meta 一处）
    expect((await screen.findAllByText("绑架游戏")).length).toBe(1);
    await waitFor(() => expect(infoMock).toHaveBeenCalledWith(202));
    expect((await screen.findAllByText("白夜行")).length).toBe(1);
    // C-1 副行 = 作者 · 最近更新（bookinfo.last_update），两卡都懒取到后各渲染一处
    expect((await screen.findAllByTitle("作者X · 2024-01-01")).length).toBe(2);
    // D1 刊头：书库同款大版统计（wenku8 · 用户名 · 共 n 本）+ F4 网页版入口
    expect(screen.getByText("wenku8 · u · 共 2 本")).toBeTruthy();
    expect(screen.getByTitle("去网页版管理云端书架").textContent).toBe("网页版 ↗");
  });

  test("F1/F3 点卡开详情（目录默认收起）→ 选书架拉取（shelfId 透传+记忆）→ 进度墨线 → 完成重拉书架亮已入库；锁期间他书拉取禁用", async () => {
    statusMock.mockResolvedValue({ has_saved: true, username: "u" });
    shelfMock.mockResolvedValueOnce([
      { aid: 310, name: "绑架游戏", date: "2024-01-02", book_id: null, last_cid: 0 },
      { aid: 320, name: "另一本", date: null, book_id: null, last_cid: 0 },
    ]);
    // 下载完成后的重拉：已入库形态（imported 徽标即现）
    shelfMock.mockResolvedValue([
      { aid: 310, name: "绑架游戏", date: "2024-01-02", book_id: "b1", last_cid: 12 },
      { aid: 320, name: "另一本", date: null, book_id: null, last_cid: 0 },
    ]);
    // C-1 后每本书都预取元信息：详情标题取 bookinfo.title，mock 需按 aid 给对书名
    infoMock.mockImplementation((aid: number) =>
      Promise.resolve(bookInfo(aid, aid === 310 ? "绑架游戏" : aid === 320 ? "另一本" : `书${aid}`)),
    );
    catalogMock.mockResolvedValue([
      { name: "第一卷", chapters: [{ cid: 1, title: "第一章 出发" }, { cid: 2, title: "第二章 途中" }] },
    ]);
    shelvesMock.mockResolvedValue([
      { id: 5, name: "小说架", parent_id: null, sort_order: 0, created_at: 0 },
    ]);
    getSettingsMock.mockResolvedValue({});
    setSettingMock.mockResolvedValue(undefined);
    let resolveDownload!: (v: Wenku8DownloadResult) => void;
    downloadMock.mockImplementation(
      () => new Promise<Wenku8DownloadResult>((res) => (resolveDownload = res)),
    );

    renderCloudShelf();

    // F2 点卡开详情（悬浮拉取钮已改为打开详情）
    fireEvent.click(await screen.findByText("绑架游戏"));
    const dialog = await screen.findByRole("dialog", { name: "书籍详情 绑架游戏" });
    // 元信息 + 目录默认收起（共 n 卷 m 章）
    expect(within(dialog).getByText("作者X · 连载中 · 最近更新 2024-01-01")).toBeTruthy();
    expect(within(dialog).getByText("共 1 卷 2 章")).toBeTruthy();
    expect(within(dialog).queryByText("第一章 出发")).toBeNull();
    // P-3 简介默认全部展开（无折叠钮），完整显示
    expect(within(dialog).getByText("这是简介内容。")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "展开简介" })).toBeNull();

    // 目标书架：切到书架 5 → 拉取透传 shelfId 并记忆
    fireEvent.change(within(dialog).getByLabelText("目标书架"), { target: { value: "5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "拉取到书库" }));
    expect(downloadMock).toHaveBeenCalledWith(310, "5");
    expect(setSettingMock).toHaveBeenCalledWith("wenku8.dest_shelf", "5");
    // 对话框关闭，卡片进入下载态
    expect(screen.queryByRole("dialog")).toBeNull();

    // listen 注册的进度回调按 aid 过滤后更新进度条
    const handler = listenMock.mock.calls[0]?.[1] as (e: { payload: Wenku8ProgressEvent }) => void;
    act(() => handler({ payload: { aid: 310, done: 2, total: 5 } }));
    act(() => handler({ payload: { aid: 999, done: 9, total: 9 } })); // 其它书不干扰
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
    expect(within(bar).getByText("40%")).toBeTruthy();

    // F3 拉取锁：下载中打开另一本的详情，拉取钮禁用提示
    fireEvent.click(screen.getByText("另一本"));
    const dialog2 = await screen.findByRole("dialog", { name: "书籍详情 另一本" });
    const pull2 = within(dialog2).getByRole("button", { name: "正在拉取另一本" });
    expect(pull2).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog2).getByRole("button", { name: "关闭" }));

    await act(async () => {
      resolveDownload({ book_id: "b1", title: "绑架游戏", chapters: 12 });
    });
    // 完成重拉书架：imported 徽标落地，悬浮动作变「打开」（✓ 过渡微标退场）
    expect(await screen.findByRole("button", { name: "打开" })).toBeTruthy();
    expect(screen.getByText("已入库")).toBeTruthy();
    expect(screen.queryByText("✓ 已入库")).toBeNull();
    expect(shelfMock).toHaveBeenCalledTimes(2);
    // D1：完成后不再给「去书库」次按钮（点卡片/侧栏回书库即可）
    expect(screen.queryByRole("button", { name: "去书库" })).toBeNull();
  });

  test("F2 已入库书卡带「已入库」徽标，动作钮「打开」直跳 /read/:book_id；详情主钮为「打开这本书」", async () => {
    statusMock.mockResolvedValue({ has_saved: true, username: "u" });
    shelfMock.mockResolvedValue([
      { aid: 410, name: "已读书", date: null, book_id: "b9", last_cid: 5 },
    ]);
    infoMock.mockResolvedValue(bookInfo(410, "已读书", 5));
    shelvesMock.mockResolvedValue([]);
    getSettingsMock.mockResolvedValue({});

    renderCloudShelf();

    expect(await screen.findByText("已入库")).toBeTruthy();
    // C-1 状态内联：徽标是 meta 副行尾的 chip（.wr-cloud-sub 内），封面上无任何角标
    expect(screen.getByText("已入库").closest(".wr-cloud-sub")).toBeTruthy();
    expect(document.querySelector(".wr-cloud-badge")).toBeNull();

    // 点卡仍开详情：imported 主钮=打开这本书，无拉取入口（提示增量更新未提供）
    fireEvent.click(screen.getByText("已读书"));
    const dialog = await screen.findByRole("dialog", { name: "书籍详情 已读书" });
    expect(within(dialog).getByRole("button", { name: "打开这本书" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "拉取到书库" })).toBeNull();
    expect(within(dialog).getByText("已入库，增量更新将随后续版本提供")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));

    // 悬浮动作钮「打开」直跳 /read/:book_id
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(await screen.findByTestId("read-page")).toBeTruthy();
  });

  test("F2 有新章：imported 书错峰比对 latest_cid > last_cid 亮「有新章」徽标", async () => {
    statusMock.mockResolvedValue({ has_saved: true, username: "u" });
    shelfMock.mockResolvedValue([
      { aid: 510, name: "追更书", date: null, book_id: "b7", last_cid: 3 },
    ]);
    infoMock.mockResolvedValue(bookInfo(510, "追更书", 9));
    shelvesMock.mockResolvedValue([]);
    getSettingsMock.mockResolvedValue({});

    renderCloudShelf();

    expect(await screen.findByText("已入库")).toBeTruthy();
    // 错峰 300ms 后比对完成才亮徽标（内联小徽在副行尾）
    const tag = await screen.findByText("有新章", undefined, { timeout: 3000 });
    expect(tag.closest(".wr-cloud-sub")).toBeTruthy();
  });

  test("D3 上下文行显示账号与上次同步时间；退出登录调 wenku8Logout 清账密回登录卡", async () => {
    statusMock.mockResolvedValue({ has_saved: true, username: "u" });
    shelfMock.mockResolvedValue([
      { aid: 101, name: "绑架游戏", date: null, book_id: null, last_cid: 0 },
    ]);
    logoutMock.mockResolvedValue(undefined);
    shelvesMock.mockResolvedValue([]);
    getSettingsMock.mockResolvedValue({});
    infoMock.mockResolvedValue(bookInfo(101, "绑架游戏"));

    renderCloudShelf();

    expect(await screen.findByText(/u · 上次同步 \d{2}:\d{2}/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(await screen.findByPlaceholderText("用户名")).toBeTruthy();
    expect(logoutMock).toHaveBeenCalledTimes(1);
    // 上下文行随登录卡消失
    expect(screen.queryByText(/上次同步/)).toBeNull();
  });

  test("P-2 会话缓存：切走再切回直接渲染缓存书卡，不重新拉取云端书架", async () => {
    statusMock.mockResolvedValue({ has_saved: true, username: "u" });
    shelfMock.mockResolvedValue([
      { aid: 601, name: "缓存书", date: null, book_id: null, last_cid: 0 },
    ]);
    shelvesMock.mockResolvedValue([]);
    getSettingsMock.mockResolvedValue({});
    infoMock.mockResolvedValue(bookInfo(601, "缓存书"));

    const { unmount } = renderCloudShelf();
    expect(await screen.findByText("缓存书")).toBeTruthy();
    expect(shelfMock).toHaveBeenCalledTimes(1);
    unmount();

    // 二次挂载：render 同步帧即有缓存内容（不闪"正在加载"），且不再调 wenku8Bookshelf
    renderCloudShelf();
    expect(screen.getByText("缓存书")).toBeTruthy();
    expect(screen.queryByText("正在加载云书架…")).toBeNull();
    await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(2));
    expect(shelfMock).toHaveBeenCalledTimes(1);
  });

  test("C-1 排序：默认收藏顺序=API 返回序；「最近更新」last_update 降序（未取到排尾）并写 settings，重进保持", async () => {
    statusMock.mockResolvedValue({ has_saved: true, username: "u" });
    shelfMock.mockResolvedValue([
      { aid: 1, name: "甲书", date: null, book_id: null, last_cid: 0 },
      { aid: 2, name: "乙书", date: null, book_id: null, last_cid: 0 },
      { aid: 3, name: "丙书", date: null, book_id: null, last_cid: 0 },
      { aid: 4, name: "丁书", date: null, book_id: null, last_cid: 0 },
    ]);
    // 丁书取不到 bookinfo：最近更新排序下应排尾部
    infoMock.mockImplementation((aid: number) =>
      aid === 4
        ? Promise.reject(new Error("network"))
        : Promise.resolve({
            ...bookInfo(aid, `书${aid}`),
            last_update: aid === 1 ? "2026-01-01" : aid === 2 ? "2026-03-06" : "2026-02-15",
          }),
    );
    shelvesMock.mockResolvedValue([]);
    getSettingsMock.mockResolvedValue({});

    const aids = () => Array.from(document.querySelectorAll(".wr-book-card")).map((el) => el.getAttribute("data-aid"));
    const { unmount } = renderCloudShelf();

    expect(await screen.findByText("甲书")).toBeTruthy();
    expect(aids()).toEqual(["1", "2", "3", "4"]); // 默认=收藏顺序（API 返回序）

    fireEvent.click(screen.getByRole("button", { name: "排序：收藏顺序" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "最近更新" }));
    expect(setSettingMock).toHaveBeenCalledWith("wenku8.sort", "updated");
    await waitFor(() => expect(aids()).toEqual(["2", "3", "1", "4"])); // 2026-03-06 > 02-15 > 01-01 > 未取到
    unmount();

    // 重进保持：settings 已是 updated，挂载即按最近更新排布
    getSettingsMock.mockResolvedValue({ "wenku8.sort": "updated" });
    renderCloudShelf();
    await screen.findByText("甲书");
    await waitFor(() => expect(aids()).toEqual(["2", "3", "1", "4"]));
  });

  test("C-1 密度：读书库同一 library_density 键（large → --large 类 + 320px 列宽）；密度钮写同键", async () => {
    statusMock.mockResolvedValue({ has_saved: true, username: "u" });
    shelfMock.mockResolvedValue([
      { aid: 7, name: "密度书", date: null, book_id: null, last_cid: 0 },
    ]);
    infoMock.mockResolvedValue(bookInfo(7, "密度书"));
    shelvesMock.mockResolvedValue([]);
    getSettingsMock.mockResolvedValue({ library_density: "large" });

    renderCloudShelf();
    await screen.findByText("密度书");
    const grid = document.querySelector(".wr-book-grid") as HTMLElement;
    expect(grid.className).toContain("wr-book-grid--large");
    expect(grid.style.gridTemplateColumns).toContain("320px");

    fireEvent.click(screen.getByRole("button", { name: "标准" }));
    expect(setSettingMock).toHaveBeenCalledWith("library_density", "standard");
    expect((document.querySelector(".wr-book-grid") as HTMLElement).className).not.toContain("--large");
  });
});
