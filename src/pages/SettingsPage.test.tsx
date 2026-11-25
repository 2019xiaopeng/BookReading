// @vitest-environment jsdom
// V-3 设置大页面：八分区导航 / 按需加载 / 各分区写键行为。
// mock 边界照 CloudShelfPage.test.tsx：invoke 与 wenku8 层全 mock，壳渲染透传（页面行为测试不背 AppShell 的 Tauri 面）。
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const slot = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
  setSettings: vi.fn(),
  storageStats: vi.fn(),
  listShelves: vi.fn(),
  wenku8Status: vi.fn(),
  endpointStatus: vi.fn(),
}));

vi.mock("../tauri/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri/invoke")>();
  return {
    ...actual,
    getSettings: slot.getSettings,
    setSetting: slot.setSetting,
    setSettings: slot.setSettings,
    storageStats: slot.storageStats,
    listShelves: slot.listShelves,
  };
});
vi.mock("../tauri/wenku8", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri/wenku8")>();
  return { ...actual, wenku8Status: slot.wenku8Status, wenku8EndpointStatus: slot.endpointStatus };
});
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("3.2.0-test") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("../ui/AppShell", () => ({
  default: (props: { children?: React.ReactNode }) => <>{props.children}</>,
}));

import { setTheme } from "../ui/theme";
import { usePageMeta } from "../ui/pageMeta";
import SettingsPage from "./SettingsPage";

const SETTINGS = {
  theme: "ink",
  fontSizePercent: "125",
  pageAnimation: "paper",
  turnSpeedMs: "260",
  layoutMode: "auto",
  lineHeight: "1.8",
  fontFamily: "songti",
  fontWeight: "400",
  letterSpacing: "0",
  paragraphSpacing: "0.2",
  textIndent: "0",
  pageMargin: "24",
  justify: "false",
  readingMode: "paginated",
  reader_bg: JSON.stringify({ type: "preset" }),
  reader_font: JSON.stringify({ type: "preset" }),
  ttsRate: "1.1",
  bg_veil: "88",
  import_mode: "copy",
  close_action: "tray",
  update_check: "on",
  "continue_card.enabled": "1",
  library_density: "large",
  trash_retention_days: "30",
  "wenku8.dest_shelf": "",
  "wenku8.sort": "updated",
  "wenku8.endpoint": "auto",
  "proxy.enabled": "0",
  "proxy.host": "",
  "proxy.port": "",
  image_reader_settings: JSON.stringify({
    fit: "height",
    layout: "double",
    rtl: true,
    mode: "paged",
    pageAnimation: "slide",
    webtoonWidth: 75,
    autoScrollSpeed: 60,
    doubleOffset: 1,
  }),
  pdf_reader_settings: JSON.stringify({
    fit: "width",
    layout: "single",
    rtl: false,
    mode: "webtoon",
    pageAnimation: "none",
    webtoonWidth: 80,
    autoScrollSpeed: 90,
    doubleOffset: 0,
  }),
};

const STATS = {
  library_root: "D:\\Books",
  db_path: "C:\\Users\\u\\AppData\\Roaming\\com.root.bookreading\\bookreading.db",
  library_bytes: 3_000_000_000,
  covers_bytes: 400_000_000,
  bg_bytes: 0,
  db_bytes: 18_000_000,
  logs_bytes: 0,
  trash_count: 2,
};

const TABS = ["外观", "阅读", "书库", "云书架", "网络与更新", "快捷键", "漫画增强", "关于"];

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

/** 页元信息探针：页面在布局期把 active/title 写进 pageMeta store（真实壳从这里取值） */
function MetaProbe() {
  const meta = usePageMeta();
  return <div data-testid="meta">{meta.active + "|" + meta.title}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <MetaProbe />
      <Routes>
        <Route path="/" element={<div>library page</div>} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/cloud-shelf" element={<div>cloud page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeAll(() => {
  // 页面里的下拉是 Radix Select：jsdom 没有 scrollIntoView（同 radix.test.tsx 的补丁）
  const proto = window.HTMLElement.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  proto.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  slot.getSettings.mockResolvedValue({ ...SETTINGS });
  slot.setSetting.mockResolvedValue(undefined);
  slot.setSettings.mockResolvedValue(undefined);
  slot.storageStats.mockResolvedValue({ ...STATS });
  slot.listShelves.mockResolvedValue([
    { id: 1, name: "轻小说", parent_id: null, sort_order: 1, created_at: 0 },
    { id: 2, name: "漫画", parent_id: null, sort_order: 2, created_at: 0 },
    { id: 3, name: "日漫", parent_id: 2, sort_order: 1, created_at: 0 },
  ]);
  slot.wenku8Status.mockResolvedValue({ has_saved: true, username: "reader" });
  slot.endpointStatus.mockResolvedValue({ setting: "auto", session: "relay", relay_ok: true, direct_ok: false });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setTheme("ink"); // theme 是模块级单例：还原，防跨用例泄漏
});

describe("SettingsPage（V-3 设置大页面）", () => {
  test("页元信息 active=settings / 标题「设置」；八分区导航齐全，缺省落在外观", async () => {
    renderAt("/settings");
    await waitFor(() => expect(screen.getByTestId("meta").textContent).toBe("settings|设置"));
    const nav = screen.getByRole("navigation", { name: "设置分区" });
    expect(within(nav).getAllByRole("button").map((t) => t.textContent)).toEqual(TABS);
    expect(within(nav).getByRole("button", { name: "外观" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("heading", { level: 2, name: "外观" })).toBeTruthy();
  });

  test("切分区：URL 带 ?section=，内容与选中态同步；非法分区回落到外观", async () => {
    renderAt("/settings?section=nope");
    expect(await screen.findByRole("heading", { level: 2, name: "外观" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "书库" }));
    expect(screen.getByTestId("loc").textContent).toBe("/settings?section=library");
    expect(await screen.findByText("书库位置")).toBeTruthy();
    const active = screen.getAllByRole("button", { name: "书库" }).filter((b) => b.getAttribute("aria-current") === "page");
    expect(active).toHaveLength(1);
    expect(screen.queryByRole("heading", { level: 2, name: "外观" })).toBeNull();
  });

  test("外观：九个主题色块，点选即切换全局主题并写 settings 键", async () => {
    renderAt("/settings");
    const group = await screen.findByRole("group", { name: "主题" });
    expect(within(group).getAllByRole("button")).toHaveLength(9);
    expect(within(group).getByRole("button", { name: "纸墨" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "护眼" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("green"));
    expect(slot.setSetting).toHaveBeenCalledWith("theme", "green");
    expect(within(group).getByRole("button", { name: "护眼" }).getAttribute("aria-pressed")).toBe("true");
    // 关闭按钮行为回填已存的值
    expect(screen.getByRole("combobox", { name: "关闭按钮行为" }).textContent).toContain("最小化到托盘");
  });

  test("阅读：显示已存默认值；切到上下滚动后一次批量写全部 15 个全局键，翻页类项置灰", async () => {
    renderAt("/settings?section=reading");
    expect((await screen.findByRole("combobox", { name: "翻页动画" })).textContent).toContain("纸页翻动");
    expect((screen.getByRole("slider", { name: "字号" }) as HTMLInputElement).value).toBe("125");
    expect(screen.getByRole("slider", { name: "语速" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "上下滚动" }));
    await waitFor(() => expect(slot.setSettings).toHaveBeenCalledTimes(1));
    const values = slot.setSettings.mock.calls[0][0] as Record<string, string>;
    expect(Object.keys(values)).toHaveLength(15);
    expect(values).toMatchObject({ readingMode: "scrolled", fontSizePercent: "125", pageAnimation: "paper", fontFamily: "songti" });
    const anim = screen.getByRole("combobox", { name: "翻页动画" }) as HTMLButtonElement;
    expect(anim.disabled || anim.getAttribute("aria-disabled") === "true").toBe(true);
    expect((screen.getByRole("slider", { name: "翻页速度" }) as HTMLInputElement).disabled).toBe(true);
  });

  test("漫画增强：漫画与 PDF 各读各的键；改漫画只写漫画键并保留其余字段", async () => {
    renderAt("/settings?section=manga");
    const manga = await screen.findByRole("region", { name: "漫画" });
    const pdf = screen.getByRole("region", { name: "PDF" });
    expect(within(manga).getByRole("button", { name: "双页" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(pdf).getByRole("button", { name: "连续滚动" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(manga).getByRole("button", { name: "条漫" }));
    await waitFor(() => expect(slot.setSetting).toHaveBeenCalledWith("image_reader_settings", expect.any(String)));
    const written = JSON.parse(slot.setSetting.mock.calls.find((c) => c[0] === "image_reader_settings")![1] as string);
    expect(written).toMatchObject({ mode: "webtoon", rtl: true, layout: "double", doubleOffset: 1 });
    expect(slot.setSetting).not.toHaveBeenCalledWith("pdf_reader_settings", expect.anything());
  });

  test("书库：存储占用进分区才取；不可清项灰显；继续阅读卡开关写键", async () => {
    renderAt("/settings");
    await screen.findByRole("heading", { level: 2, name: "外观" });
    expect(slot.storageStats).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "书库" }));
    expect(await screen.findByText("书库位置")).toBeTruthy();
    expect(slot.storageStats).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "清理书库文件" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "清理封面缓存" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "清理运行日志" }) as HTMLButtonElement).disabled).toBe(true); // 0 字节
    fireEvent.click(screen.getByRole("checkbox", { name: "在书架刊头下显示最近在读的书" }));
    expect(slot.setSetting).toHaveBeenCalledWith("continue_card.enabled", "0");
  });

  test("云书架：账号状态、排序写 wenku8.sort、按钮跳云书架页", async () => {
    renderAt("/settings?section=cloud");
    expect(await screen.findByText("已登录：reader")).toBeTruthy();
    const sort = screen.getByRole("combobox", { name: "云书架排序" });
    expect(sort.textContent).toContain("最近更新");
    fireEvent.keyDown(sort, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "书名" }));
    expect(slot.setSetting).toHaveBeenCalledWith("wenku8.sort", "title");
    fireEvent.click(screen.getByRole("button", { name: "打开云书架" }));
    await waitFor(() => expect(screen.getByText("cloud page")).toBeTruthy());
  });

  test("云书架：默认目标书架——根显示为「书库（根）」而非空白；选书架写 id、选回根写空串；记住的书架已删则回落到根", async () => {
    // 回归：设置表里"根"存空串，而 Radix Select 不接受空串选项——首版直接把空串当选项值，下拉显示成一片空白且不报错
    slot.getSettings.mockResolvedValue({ ...SETTINGS, "wenku8.dest_shelf": "999" });
    const first = renderAt("/settings?section=cloud");
    const dest = await screen.findByRole("combobox", { name: "默认目标书架" });
    expect(dest.textContent).toContain("书库（根）");

    fireEvent.keyDown(dest, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /日漫/ })); // 嵌套书架：名称带层级缩进
    expect(slot.setSetting).toHaveBeenCalledWith("wenku8.dest_shelf", "3");
    first.unmount();

    // 选回根：界面占位值换回设置表的空串
    slot.getSettings.mockResolvedValue({ ...SETTINGS, "wenku8.dest_shelf": "3" });
    renderAt("/settings?section=cloud");
    const dest2 = await screen.findByRole("combobox", { name: "默认目标书架" });
    expect(dest2.textContent).toContain("日漫");
    fireEvent.keyDown(dest2, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "书库（根）" }));
    expect(slot.setSetting).toHaveBeenCalledWith("wenku8.dest_shelf", "");
  });

  test("最窄形态的分区下拉（容器 <600 时由 CSS 接管显示）：显示当前分区，选择即切换 URL", async () => {
    renderAt("/settings?section=library");
    const sel = await screen.findByRole("combobox", { name: "切换分区" });
    expect(sel.textContent).toContain("书库");
    fireEvent.keyDown(sel, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "关于" }));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/settings?section=about"));
    expect((await screen.findByRole("combobox", { name: "切换分区" })).textContent).toContain("关于");
  });

  test("网络与更新：网络区 + 更新区同页；自动检查开关写键", async () => {
    renderAt("/settings?section=network");
    expect(await screen.findByRole("combobox", { name: "wenku8 地址" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "启动时静默检查，发现新版在设置入口提示" }));
    expect(slot.setSetting).toHaveBeenCalledWith("update_check", "off");
  });

  test("快捷键与关于：静态表原样迁入；关于里的数据库位置同样惰性取", async () => {
    renderAt("/settings?section=shortcuts");
    expect(await screen.findByText("书内搜索（EPUB）")).toBeTruthy();
    expect(screen.getByText("Ctrl+F")).toBeTruthy();
    expect(slot.storageStats).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关于" }));
    expect(await screen.findByText("BookReading v3.2.0-test")).toBeTruthy();
    expect(await screen.findByText(STATS.db_path)).toBeTruthy();
    expect(slot.storageStats).toHaveBeenCalledTimes(1);
  });
});
