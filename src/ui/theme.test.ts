import { beforeAll, describe, expect, test, vi } from "vitest";

const { setSettingMock } = vi.hoisted(() => ({ setSettingMock: vi.fn() }));

vi.mock("../tauri/invoke", () => ({ setSetting: setSettingMock }));

// store 在 import 时同步读 localStorage / 写 document，先装 stub 再动态 import
const storage = new Map<string, string>();
const dataset: Record<string, string> = {};
const style: Partial<CSSStyleDeclaration> = {};
let theme: typeof import("./theme");

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  });
  vi.stubGlobal("document", { documentElement: { dataset, style } });
  theme = await import("./theme");
});

describe("theme store", () => {
  test("boots ink (M2 default) and syncs html dataset without cache", () => {
    expect(theme.getTheme()).toBe("ink");
    expect(dataset.theme).toBe("ink");
  });

  test("M2: eight swatches including 纸墨/墨夜 ink swatches", () => {
    expect(theme.THEME_SWATCHES).toHaveLength(8);
    expect(theme.THEME_SWATCHES.map((s) => s.value)).toEqual([
      "light",
      "sepia",
      "green",
      "gray",
      "dark",
      "darkcontrast",
      "ink",
      "ink-dark",
    ]);
    expect(theme.THEME_SWATCHES.find((s) => s.value === "ink")?.color).toBe("#242321");
    expect(theme.THEME_SWATCHES.find((s) => s.value === "ink-dark")?.color).toBe("#EDECE7");
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

  // 批次12b：原生弹层 color-scheme 内联同步——夜间主题（dark/darkcontrast/ink-dark）dark，其余 light
  test("colorScheme inline style maps dark themes", () => {
    theme.setTheme("dark");
    expect(style.colorScheme).toBe("dark");
    theme.setTheme("darkcontrast");
    expect(style.colorScheme).toBe("dark");
    theme.setTheme("ink-dark");
    expect(style.colorScheme).toBe("dark");
    theme.setTheme("ink");
    expect(style.colorScheme).toBe("light");
    theme.setTheme("sepia");
    expect(style.colorScheme).toBe("light");
  });
});
