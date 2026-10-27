import { beforeAll, describe, expect, test, vi } from "vitest";

const { setSettingMock } = vi.hoisted(() => ({ setSettingMock: vi.fn() }));

vi.mock("../tauri/invoke", () => ({ setSetting: setSettingMock }));

// store 在 import 时同步读 localStorage / 写 document，先装 stub 再动态 import
const storage = new Map<string, string>();
const dataset: Record<string, string> = {};
let theme: typeof import("./theme");

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  });
  vi.stubGlobal("document", { documentElement: { dataset } });
  theme = await import("./theme");
});

describe("theme store", () => {
  test("boots light and syncs html dataset without cache", () => {
    expect(theme.getTheme()).toBe("light");
    expect(dataset.theme).toBe("light");
  });

  test("applyPersistedTheme corrects from DB and dual-writes localStorage", () => {
    theme.applyPersistedTheme("dark");
    expect(theme.getTheme()).toBe("dark");
    expect(storage.get("wr-theme")).toBe("dark");
    expect(dataset.theme).toBe("dark");
  });

  test("setTheme applies instantly and persists to DB", () => {
    setSettingMock.mockClear();
    theme.setTheme("sepia");
    expect(theme.getTheme()).toBe("sepia");
    expect(storage.get("wr-theme")).toBe("sepia");
    expect(dataset.theme).toBe("sepia");
    expect(setSettingMock).toHaveBeenCalledWith("theme", "sepia");
  });

  test("user-touched theme is not overwritten by later DB reads", () => {
    theme.applyPersistedTheme("dark");
    expect(theme.getTheme()).toBe("sepia");
  });
});
