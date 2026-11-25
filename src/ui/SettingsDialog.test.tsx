// @vitest-environment jsdom
// V-3 设置浮窗（PyCharm 式居中弹窗）：分区切换 / 键盘操作 / 关闭与"操作进行中不许关" / 各分区写键行为。
// mock 边界照 CloudShelfPage.test.tsx：invoke 与 wenku8 层全 mock；确认框也 mock 以便驱动批量流程。
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const slot = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
  setSettings: vi.fn(),
  storageStats: vi.fn(),
  listShelves: vi.fn(),
  clearCache: vi.fn(),
  wenku8Status: vi.fn(),
  endpointStatus: vi.fn(),
  showConfirm: vi.fn(),
  showAlert: vi.fn(),
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
    clearCache: slot.clearCache,
  };
});
vi.mock("../tauri/wenku8", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri/wenku8")>();
  return { ...actual, wenku8Status: slot.wenku8Status, wenku8EndpointStatus: slot.endpointStatus };
});
vi.mock("../ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/dialog")>();
  return { ...actual, showConfirm: slot.showConfirm, showAlert: slot.showAlert };
});
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("3.2.0-test") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { setTheme } from "./theme";
import SettingsDialog from "./SettingsDialog";
import { effectivePageAnimation, visiblePageAnimations } from "../reader/epub/turnFx";
import type { SettingsSectionId } from "../settings/sections";

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

const TAB_LABELS = ["外观", "阅读", "书库", "云书架", "网络与更新", "快捷键", "漫画增强", "关于"];

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function mount(initialSection?: SettingsSectionId) {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={["/?shelf=7"]}>
      <LocationProbe />
      <Routes>
        <Route path="*" element={<SettingsDialog initialSection={initialSection} onClose={onClose} />} />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose };
}
const dlg = () => screen.getByRole("dialog", { name: "设置" });
const tab = (name: string) => within(dlg()).getByRole("tab", { name });

beforeAll(() => {
  // Radix Dialog / Select 在 jsdom 缺的宿主能力（同 radix.test.tsx 的补丁）
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  const proto = window.HTMLElement.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  slot.getSettings.mockResolvedValue({ ...SETTINGS });
  slot.setSetting.mockResolvedValue(undefined);
  slot.setSettings.mockResolvedValue(undefined);
  slot.storageStats.mockResolvedValue({ ...STATS });
  slot.clearCache.mockResolvedValue({ freed_bytes: 0 });
  slot.listShelves.mockResolvedValue([
    { id: 1, name: "轻小说", parent_id: null, sort_order: 1, created_at: 0 },
    { id: 2, name: "漫画", parent_id: null, sort_order: 2, created_at: 0 },
    { id: 3, name: "日漫", parent_id: 2, sort_order: 1, created_at: 0 },
  ]);
  slot.wenku8Status.mockResolvedValue({ has_saved: true, username: "reader" });
  slot.endpointStatus.mockResolvedValue({ setting: "auto", session: "relay", relay_ok: true, direct_ok: false });
  slot.showConfirm.mockResolvedValue(true);
  slot.showAlert.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setTheme("ink"); // theme 是模块级单例：还原，防跨用例泄漏
});

describe("SettingsDialog（V-3 设置浮窗）", () => {
  test("打开即模态浮窗：大字标题、八个分区目录、缺省落在外观；不改变底下的页面地址", async () => {
    mount();
    const d = await screen.findByRole("dialog", { name: "设置" });
    expect(within(d).getByText("设 置").className).toBe("wr-masthead-name"); // 与书架 / 收藏刊头同款
    expect(within(d).getAllByRole("tab").map((t) => t.textContent)).toEqual(TAB_LABELS);
    expect(tab("外观").getAttribute("aria-selected")).toBe("true");
    expect(within(d).getByRole("tabpanel", { name: "外观" })).toBeTruthy();
    await waitFor(() => expect(within(d).getByText(/BookReading v3\.2\.0-test/)).toBeTruthy());
    expect(screen.getByTestId("loc").textContent).toBe("/?shelf=7"); // 浮窗不切页
  });

  test("切分区：只换右侧面板内容与选中态，地址不变；initialSection 可直达", async () => {
    mount("network");
    await screen.findByRole("dialog", { name: "设置" });
    expect(tab("网络与更新").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab("书库"));
    expect(await within(dlg()).findByText("书库位置")).toBeTruthy();
    expect(tab("书库").getAttribute("aria-selected")).toBe("true");
    expect(tab("网络与更新").getAttribute("aria-selected")).toBe("false");
    expect(within(dlg()).getByRole("tabpanel", { name: "书库" })).toBeTruthy();
    expect(screen.getByTestId("loc").textContent).toBe("/?shelf=7");
  });

  test("键盘：方向键 / Home / End 在目录里移动并直接切换（roving tabindex）", async () => {
    mount();
    await screen.findByRole("dialog", { name: "设置" });
    expect(tab("外观").tabIndex).toBe(0);
    expect(tab("阅读").tabIndex).toBe(-1);
    fireEvent.keyDown(tab("外观"), { key: "ArrowDown" });
    expect(await within(dlg()).findByRole("heading", { level: 2, name: "阅读" })).toBeTruthy();
    expect(tab("阅读").tabIndex).toBe(0);
    expect(document.activeElement).toBe(tab("阅读"));
    fireEvent.keyDown(tab("阅读"), { key: "End" });
    expect(await within(dlg()).findByRole("heading", { level: 2, name: "关于" })).toBeTruthy();
    fireEvent.keyDown(tab("关于"), { key: "ArrowUp" });
    expect(await within(dlg()).findByRole("heading", { level: 2, name: "漫画增强" })).toBeTruthy();
    fireEvent.keyDown(tab("漫画增强"), { key: "Home" });
    expect(await within(dlg()).findByRole("heading", { level: 2, name: "外观" })).toBeTruthy();
  });

  test("Esc 与「关闭」钮都能关闭浮窗", async () => {
    const { onClose } = mount();
    await screen.findByRole("dialog", { name: "设置" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    fireEvent.click(within(dlg()).getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("外观：九个主题色块，点选即切换全局主题并写 settings 键；关闭按钮行为回填已存的值", async () => {
    mount();
    const group = await within(dlg()).findByRole("group", { name: "主题" });
    expect(within(group).getAllByRole("button")).toHaveLength(9);
    expect(within(group).getByRole("button", { name: "纸墨" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "护眼" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("green"));
    expect(slot.setSetting).toHaveBeenCalledWith("theme", "green");
    await waitFor(() =>
      expect(within(dlg()).getByRole("combobox", { name: "关闭按钮行为" }).textContent).toContain("最小化到托盘"),
    );
  });

  test("阅读：显示已存默认值；切到上下滚动后一次批量写全部 15 个全局键，翻页类项置灰", async () => {
    mount("reading");
    // 选项与显示值跟随翻页矩阵总开关：矩阵关闭时已存的 paper 按渐隐显示（文案=v3.1.8 的「淡入淡出」）
    const expected = visiblePageAnimations().find((o) => o.value === effectivePageAnimation("paper"))?.label ?? "";
    // 设置是异步回填的：浮窗一挂载控件就在，但显示的是初始值——必须等到已存值到位再断言（CI 慢时会读到初始值）
    await waitFor(() =>
      expect(within(dlg()).getByRole("combobox", { name: "翻页动画" }).textContent).toContain(expected),
    );
    expect((within(dlg()).getByRole("slider", { name: "字号" }) as HTMLInputElement).value).toBe("125");
    fireEvent.click(within(dlg()).getByRole("button", { name: "上下滚动" }));
    await waitFor(() => expect(slot.setSettings).toHaveBeenCalledTimes(1));
    const values = slot.setSettings.mock.calls[0][0] as Record<string, string>;
    expect(Object.keys(values)).toHaveLength(15);
    expect(values).toMatchObject({ readingMode: "scrolled", fontSizePercent: "125", pageAnimation: "paper", fontFamily: "songti" });
    const anim = within(dlg()).getByRole("combobox", { name: "翻页动画" }) as HTMLButtonElement;
    expect(anim.disabled || anim.getAttribute("aria-disabled") === "true").toBe(true);
  });

  test("漫画增强：漫画与 PDF 各读各的键；改漫画只写漫画键并保留其余字段", async () => {
    mount("manga");
    const manga = await within(dlg()).findByRole("region", { name: "漫画" });
    // 同上：等已存的生效值回填（漫画=双页、PDF=连续滚动）再断言
    await waitFor(() => {
      expect(within(manga).getByRole("button", { name: "双页" }).getAttribute("aria-pressed")).toBe("true");
      expect(within(dlg()).getByRole("button", { name: "连续滚动" }).getAttribute("aria-pressed")).toBe("true");
    });
    fireEvent.click(within(manga).getByRole("button", { name: "条漫" }));
    await waitFor(() => expect(slot.setSetting).toHaveBeenCalledWith("image_reader_settings", expect.any(String)));
    const written = JSON.parse(slot.setSetting.mock.calls.find((c) => c[0] === "image_reader_settings")![1] as string);
    expect(written).toMatchObject({ mode: "webtoon", rtl: true, layout: "double", doubleOffset: 1 });
    expect(slot.setSetting).not.toHaveBeenCalledWith("pdf_reader_settings", expect.anything());
  });

  test("书库：存储占用进分区才取；不可清项灰显；继续阅读卡开关写键", async () => {
    mount();
    await screen.findByRole("dialog", { name: "设置" });
    expect(slot.storageStats).not.toHaveBeenCalled();
    fireEvent.click(tab("书库"));
    expect(await within(dlg()).findByText("书库位置")).toBeTruthy();
    expect(slot.storageStats).toHaveBeenCalledTimes(1);
    expect((within(dlg()).getByRole("button", { name: "清理书库文件" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dlg()).getByRole("button", { name: "清理封面缓存" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(dlg()).getByRole("checkbox", { name: "在书架刊头下显示最近在读的书" }));
    expect(slot.setSetting).toHaveBeenCalledWith("continue_card.enabled", "0");
  });

  test("清理进行中：Esc 不关闭浮窗（迁移/清理后的追问不能被关窗吞掉）；做完恢复可关", async () => {
    let finish: (v: { freed_bytes: number }) => void = () => {};
    slot.clearCache.mockImplementation(() => new Promise<{ freed_bytes: number }>((res) => (finish = res)));
    const { onClose } = mount("library");
    await within(dlg()).findByText("书库位置");
    fireEvent.click(within(dlg()).getByRole("checkbox", { name: "日志" }));
    fireEvent.click(within(dlg()).getByRole("button", { name: "清理" })); // 一键清理（逐行清理钮的名称是"清理××"）
    await waitFor(() => expect(slot.clearCache).toHaveBeenCalledWith(["logs"]));
    expect(slot.showConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(within(dlg()).getByRole("button", { name: "关闭" }));
    expect(onClose).not.toHaveBeenCalled(); // 进行中：遮罩 / Esc / 关闭钮都不生效
    await act(async () => {
      finish({ freed_bytes: 1024 });
    });
    await waitFor(() => expect(slot.showAlert).toHaveBeenCalledWith("清理完成", expect.any(String)));
    await waitFor(() => expect(within(dlg()).queryByRole("button", { name: "关闭" })).toBeTruthy());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test("云书架：账号状态、默认目标书架（根不空白、选书架写 id、选回根写空串）、排序写键、按钮收浮窗并跳云书架", async () => {
    const { onClose } = mount("cloud");
    expect(await within(dlg()).findByText("已登录：reader")).toBeTruthy();
    const dest = within(dlg()).getByRole("combobox", { name: "默认目标书架" });
    // 回归：设置表里"根"存空串，而 Radix Select 不接受空串选项——首版直接把空串当选项值，下拉显示成一片空白
    expect(dest.textContent).toContain("书库（根）");
    fireEvent.keyDown(dest, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /日漫/ }));
    expect(slot.setSetting).toHaveBeenCalledWith("wenku8.dest_shelf", "3");

    await waitFor(() =>
      expect(within(dlg()).getByRole("combobox", { name: "云书架排序" }).textContent).toContain("最近更新"),
    );
    const sort = within(dlg()).getByRole("combobox", { name: "云书架排序" });
    fireEvent.keyDown(sort, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "书名" }));
    expect(slot.setSetting).toHaveBeenCalledWith("wenku8.sort", "title");

    fireEvent.click(within(dlg()).getByRole("button", { name: "打开云书架" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/cloud-shelf"));
  });

  test("云书架：记住的目标书架已被删除时回落显示为根", async () => {
    slot.getSettings.mockResolvedValue({ ...SETTINGS, "wenku8.dest_shelf": "999" });
    mount("cloud");
    expect((await within(dlg()).findByRole("combobox", { name: "默认目标书架" })).textContent).toContain("书库（根）");
  });

  test("网络与更新：网络区 + 更新区同页；自动检查开关写键", async () => {
    mount("network");
    expect(await within(dlg()).findByRole("combobox", { name: "wenku8 地址" })).toBeTruthy();
    expect(within(dlg()).getByRole("button", { name: "检查更新" })).toBeTruthy();
    fireEvent.click(within(dlg()).getByRole("checkbox", { name: "启动时静默检查，发现新版在设置入口提示" }));
    expect(slot.setSetting).toHaveBeenCalledWith("update_check", "off");
  });

  test("快捷键与关于：静态表原样迁入；关于里的数据库位置同样惰性取", async () => {
    mount("shortcuts");
    expect(await within(dlg()).findByText("书内搜索（EPUB）")).toBeTruthy();
    expect(slot.storageStats).not.toHaveBeenCalled();
    fireEvent.click(tab("关于"));
    expect(await within(dlg()).findByText("BookReading v3.2.0-test")).toBeTruthy();
    expect(await within(dlg()).findByText(STATS.db_path)).toBeTruthy();
    expect(slot.storageStats).toHaveBeenCalledTimes(1);
  });
});
