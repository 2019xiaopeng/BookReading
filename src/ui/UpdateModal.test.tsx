// @vitest-environment jsdom
// F-1 UpdateModal 状态机：mock 插件 check/downloadAndInstall 与备用通道（老链路）。
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

const slot = vi.hoisted(() => ({
  checkMock: vi.fn(),
  clearBadge: vi.fn(),
  manualCheck: vi.fn(),
  dlWithProgress: vi.fn(),
  installQuit: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: slot.checkMock }));
vi.mock("../tauri/invoke", () => ({ getSettings: vi.fn().mockResolvedValue({}) }));
vi.mock("./updater", () => ({
  checkForUpdateManually: slot.manualCheck,
  clearUpdateAvailable: slot.clearBadge,
  downloadUpdateWithProgress: slot.dlWithProgress,
  installUpdateAndQuit: slot.installQuit,
}));
vi.mock("./dialog", () => ({ showConfirm: slot.confirm }));
vi.mock("./toast", () => ({ showToast: vi.fn() }));

import UpdateModal from "./UpdateModal";

afterEach(() => {
  cleanup();
  // 模块级共享 mock：清调用计数，绝对次数断言（重试=2 次）不被前序用例污染
  Object.values(slot).forEach((m) => m.mockReset());
});

function fakeUpdate() {
  return {
    currentVersion: "3.1.0",
    version: "3.2.0",
    date: "2026-11-24T00:00:00Z",
    body: "修复若干问题",
    downloadAndInstall: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined), // 真实 API 返回 Promise；裸 vi.fn() 会让 close().catch 炸
  };
}

describe("UpdateModal 状态机", () => {
  test("check=null → 已是最新 + 熄红点", async () => {
    slot.checkMock.mockResolvedValueOnce(null);
    const { findByText } = render(<UpdateModal onClose={() => {}} />);
    expect(await findByText("当前已是最新版本。")).toBeTruthy();
    expect(slot.clearBadge).toHaveBeenCalled();
  });

  test("有新版 → 立即更新 → Started/Progress/Finished 事件驱动进度与安装态", async () => {
    const update = fakeUpdate();
    // 捕获 onEvent，promise 悬挂模拟 Windows 安装期进程退出（不 resolve）
    update.downloadAndInstall.mockImplementation((onEvent: (e: unknown) => void) => {
      onEvent({ event: "Started", data: { contentLength: 1000 } });
      onEvent({ event: "Progress", data: { chunkLength: 400 } });
      onEvent({ event: "Finished" });
      return new Promise(() => {});
    });
    slot.checkMock.mockResolvedValueOnce(update);
    const { findByText, getByRole } = render(<UpdateModal onClose={() => {}} />);

    expect(await findByText(/发现新版本/)).toBeTruthy();
    expect(await findByText("v3.2.0")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "立即更新" }));

    expect(await findByText("下载完成，正在启动安装…")).toBeTruthy();
    await waitFor(() => expect(getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40"));
    expect(update.close).not.toHaveBeenCalled(); // 安装路径不释放资源
  });

  test("检查失败 → 错误态给重试与备用通道；重试再查一次", async () => {
    slot.checkMock.mockRejectedValueOnce(new Error("network down"));
    const { findByText, getByRole } = render(<UpdateModal onClose={() => {}} />);
    expect(await findByText(/network down/)).toBeTruthy();

    slot.checkMock.mockResolvedValueOnce(null);
    fireEvent.click(getByRole("button", { name: "重试" }));
    await findByText("当前已是最新版本。");
    expect(slot.checkMock).toHaveBeenCalledTimes(2);
  });

  test("备用通道：老链路检查→下载→确认→安装退出", async () => {
    slot.checkMock.mockRejectedValueOnce(new Error("network down"));
    const { findByText, getByRole } = render(<UpdateModal onClose={() => {}} />);
    expect(await findByText(/network down/));

    slot.manualCheck.mockResolvedValueOnce({
      hasUpdate: true,
      latest: "3.2.0",
      assetUrl: "https://github.com/o/r/releases/download/v3.2.0/setup.exe",
    });
    slot.dlWithProgress.mockImplementationOnce((_url: string, onP: (p: { downloaded: number; total: number }) => void) => {
      onP({ downloaded: 10, total: 100 });
      return Promise.resolve("C:/tmp/setup.exe");
    });
    slot.confirm.mockResolvedValueOnce(true);
    slot.installQuit.mockResolvedValueOnce(undefined);

    fireEvent.click(getByRole("button", { name: "用备用通道下载" }));
    await waitFor(() => expect(slot.installQuit).toHaveBeenCalledWith("C:/tmp/setup.exe"));
    expect(slot.dlWithProgress).toHaveBeenCalledWith(
      "https://github.com/o/r/releases/download/v3.2.0/setup.exe",
      expect.any(Function),
    );
  });

  test("检查带代理：proxy.enabled=1 时 proxy 选项传入 check", async () => {
    const { getSettings } = await import("../tauri/invoke");
    vi.mocked(getSettings).mockResolvedValueOnce({
      "proxy.enabled": "1",
      "proxy.host": "127.0.0.1",
      "proxy.port": "7897",
    });
    slot.checkMock.mockResolvedValueOnce(null);
    render(<UpdateModal onClose={() => {}} />);
    await waitFor(() => expect(slot.checkMock).toHaveBeenCalledWith({ proxy: "http://127.0.0.1:7897" }));
  });
});
