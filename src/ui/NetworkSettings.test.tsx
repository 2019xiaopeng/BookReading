// @vitest-environment jsdom
// F-2 网络设置区：三选写键 / 状态行渲染 / 代理三键与端口校验。
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

const slot = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
  endpointStatus: vi.fn(),
}));
vi.mock("../tauri/invoke", () => ({ getSettings: slot.getSettings, setSetting: slot.setSetting }));
vi.mock("../tauri/wenku8", () => ({ wenku8EndpointStatus: slot.endpointStatus }));

import NetworkSettings, { proxyPortValid } from "./NetworkSettings";

beforeAll(() => {
  // v3.2 换 Radix Select 后需要：jsdom 没有 scrollIntoView（同 radix.test.tsx 的补丁）
  const proto = window.HTMLElement.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  proto.scrollIntoView ??= () => {};
});

afterEach(cleanup);

function mount() {
  slot.getSettings.mockResolvedValue({
    "wenku8.endpoint": "auto",
    "proxy.host": "",
    "proxy.port": "",
    "proxy.enabled": "0",
  });
  slot.endpointStatus.mockResolvedValue({
    setting: "auto",
    session: "relay",
    relay_ok: true,
    direct_ok: false,
  });
  return render(<NetworkSettings />);
}

describe("NetworkSettings（U-11/12 设置接线）", () => {
  test("状态行：auto 会话用中继 + 两地址通断", async () => {
    const { findByText } = mount();
    expect(await findByText(/自动模式本会话在用中继/)).toBeTruthy();
    expect(await findByText(/中继可达 · 直连不可达/)).toBeTruthy();
  });

  test("地址三选写 settings 键 wenku8.endpoint", async () => {
    const { findByRole, findByText } = mount();
    expect(await findByText(/自动模式本会话在用中继/)).toBeTruthy();
    // v3.2 换 Radix Select：jsdom 造不出带 pointerType 的 PointerEvent，走键盘开列表（同 radix.test 口径）
    const trigger = await findByRole("combobox", { name: "wenku8 地址" });
    expect(trigger.textContent).toContain("自动（中继不通切直连）");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await findByRole("option", { name: "中继 wenku8-relay.mewx.org" }));
    expect(slot.setSetting).toHaveBeenCalledWith("wenku8.endpoint", "relay");
  });

  test("代理：启用开关立即写键；host/port 失焦写键", async () => {
    const { findByLabelText } = mount();
    fireEvent.click(await findByLabelText("启用代理"));
    expect(slot.setSetting).toHaveBeenCalledWith("proxy.enabled", "1");

    const host = await findByLabelText("代理主机");
    fireEvent.change(host, { target: { value: "127.0.0.1" } });
    fireEvent.blur(host);
    expect(slot.setSetting).toHaveBeenCalledWith("proxy.host", "127.0.0.1");

    const port = await findByLabelText("代理端口");
    fireEvent.change(port, { target: { value: "7897" } });
    fireEvent.blur(port);
    expect(slot.setSetting).toHaveBeenCalledWith("proxy.port", "7897");
  });

  test("端口非法：提示且不写键", async () => {
    const { findByLabelText, findByText } = mount();
    const port = await findByLabelText("代理端口");
    fireEvent.change(port, { target: { value: "99999" } });
    fireEvent.blur(port);
    expect(await findByText(/端口需为 1-65535/)).toBeTruthy();
    expect(slot.setSetting).not.toHaveBeenCalledWith("proxy.port", "99999");
  });

  test("proxyPortValid 边界", () => {
    expect(proxyPortValid("1")).toBe(true);
    expect(proxyPortValid("65535")).toBe(true);
    expect(proxyPortValid("0")).toBe(false);
    expect(proxyPortValid("65536")).toBe(false);
    expect(proxyPortValid("abc")).toBe(false);
    expect(proxyPortValid("")).toBe(true);
    expect(proxyPortValid(" 8080 ")).toBe(true);
  });

  test("设置回填：relay + 已配代理", async () => {
    slot.getSettings.mockResolvedValue({
      "wenku8.endpoint": "relay",
      "proxy.host": "127.0.0.1",
      "proxy.port": "7890",
      "proxy.enabled": "1",
    });
    slot.endpointStatus.mockResolvedValue({ setting: "relay", session: "", relay_ok: true, direct_ok: true });
    const { getByLabelText, getByRole } = render(<NetworkSettings />);
    // 设置是异步回填的：等四个值都到位再断言。逐个 findBy 读元素会在元素一出现时就读到初始值——
    // 本机时序快总能过，CI 慢就偶发失败（v3.1.9 首次 CI 构建因此挂掉）
    await waitFor(() => {
      expect(getByRole("combobox", { name: "wenku8 地址" }).textContent).toContain("中继 wenku8-relay.mewx.org");
      expect((getByLabelText("代理主机") as HTMLInputElement).value).toBe("127.0.0.1");
      expect((getByLabelText("代理端口") as HTMLInputElement).value).toBe("7890");
      expect((getByLabelText("启用代理") as HTMLInputElement).checked).toBe(true);
    });
    await waitFor(() => expect(slot.endpointStatus).toHaveBeenCalled());
  });
});
