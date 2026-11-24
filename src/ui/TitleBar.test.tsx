// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// U-23 红线核对（jsdom 层）：标题栏渲染 / 拖动区属性 / 三钮事件（关闭走 wr:close-requested 不裸 close）
const winMock = {
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  isMaximized: vi.fn(async () => false),
  isFullscreen: vi.fn(async () => false),
  onResized: vi.fn(async () => () => {}),
};
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => winMock,
}));
const emitMock = vi.fn<(event: string, payload?: unknown) => Promise<void>>(async () => undefined);
vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => emitMock(event, payload),
}));

import TitleBar, { WindowControls } from "./TitleBar";

beforeEach(() => {
  vi.clearAllMocks();
  winMock.isMaximized.mockResolvedValue(false);
  winMock.isFullscreen.mockResolvedValue(false);
});
afterEach(cleanup);

describe("TitleBar（AppShell 顶置标题栏）", () => {
  test("渲染图标+上下文标题；中部拖动区带 data-tauri-drag-region；三钮齐备", async () => {
    render(<TitleBar title="书架" />);
    expect(screen.getByText("书架")).toBeTruthy();
    const drag = document.querySelector(".wr-titlebar-drag");
    expect(drag?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  test("三钮事件：min→minimize；max→toggleMaximize；close→emit wr:close-requested（绝不裸 close）", () => {
    render(<TitleBar title="书架" />);
    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(winMock.minimize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(winMock.toggleMaximize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(emitMock).toHaveBeenCalledWith("wr:close-requested", undefined);
    expect(winMock.close).not.toHaveBeenCalled();
  });

  test("最大化态换还原钮；全屏态标题栏整体退场", async () => {
    winMock.isMaximized.mockResolvedValue(true);
    winMock.isFullscreen.mockResolvedValue(false);
    const { rerender } = render(<TitleBar title="书架" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "向下还原" })).toBeTruthy());

    winMock.isMaximized.mockResolvedValue(false);
    winMock.isFullscreen.mockResolvedValue(true);
    rerender(<TitleBar title="书架" />);
    // 状态经 resize 回调同步：手动触发一次订阅回调
    const calls = winMock.onResized.mock.calls as unknown as (() => void)[][];
    const resized = calls[calls.length - 1]?.[0];
    resized?.();
    await waitFor(() => expect(screen.queryByRole("button", { name: "关闭" })).toBeNull());
  });
});

describe("WindowControls（阅读页顶栏内嵌用）", () => {
  test("无拖动区属性（拖动区由宿主顶栏提供）；全屏时藏最大化钮保留最小化/关闭", async () => {
    winMock.isFullscreen.mockResolvedValue(true);
    render(<WindowControls />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "最大化" })).toBeNull());
    expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(document.querySelector("[data-tauri-drag-region]")).toBeNull();
  });
});
