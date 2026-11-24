import { describe, expect, test, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: hoisted.invokeMock }));

import { wenku8EndpointStatus } from "./wenku8";

// C-2 契约：命令名 + 返回结构（Rust 侧无 camelCase rename，字段保持 snake_case）
describe("wenku8EndpointStatus wrapper", () => {
  test("调 wenku8_endpoint_status 并原样透传载荷", async () => {
    const payload = { setting: "auto", session: "direct", relay_ok: false, direct_ok: true };
    hoisted.invokeMock.mockResolvedValueOnce(payload);
    await expect(wenku8EndpointStatus()).resolves.toEqual(payload);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("wenku8_endpoint_status");
  });
});
