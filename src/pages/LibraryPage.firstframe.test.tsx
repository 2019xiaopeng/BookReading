// @vitest-environment jsdom
// v3.1 批次2D 验收：U-3 密度/排序首帧同步读预热缓存（不闪帧）+ U-19 继续阅读封面走持久通道（不产生 blob: src）
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../tauri/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri/invoke")>();
  return {
    ...actual,
    listBooks: vi.fn(),
    listShelves: vi.fn(),
    listTags: vi.fn(),
    listReadingTimes: vi.fn(),
    listTrash: vi.fn(),
    getSettings: vi.fn(),
    setSetting: vi.fn(),
  };
});

// 封面字节通道永不到达：blob 缓存恒冷——逼出持久通道/缓存初始化两条首帧路径
vi.mock("../tauri/appDataPaths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri/appDataPaths")>();
  return {
    ...actual,
    readAppDataBlobUrl: vi.fn(() => new Promise<string>(() => {})),
  };
});

vi.mock("../ui/AppShell", () => ({
  setShelvesCache: vi.fn(),
  useShellShelves: () => [],
}));

import { getSettings, listBooks, listReadingTimes, listShelves, listTags, type Book } from "../tauri/invoke";
import { primeSettingsCache, resetSettingsCacheForTests } from "../library/settingsCache";
import { primeCoverLibraryRoot } from "../library/coverSrc";
import LibraryPage from "./LibraryPage";

const book = (over: Partial<Book>): Book => ({
  id: "b",
  title: "t",
  author: null,
  cover_path: "library/covers/b.jpg",
  library_path: "library/books/b.epub",
  added_at: 1,
  last_opened_at: null,
  note: null,
  pinned_at: null,
  reading_percent: null,
  is_favorite: false,
  format: "epub",
  page_count: 10,
  shelf_id: null,
  sort_order: null,
  deleted_at: null,
  description: null,
  content_chars: null,
  file_size: null,
  tags: [],
  ...over,
});

function stubTauriConvertFileSrc() {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
  };
}

function renderLibrary() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <LibraryPage />
    </MemoryRouter>,
  );
}

function mockInvokes(books: Book[]) {
  vi.mocked(listBooks).mockResolvedValue(books);
  vi.mocked(listShelves).mockResolvedValue([]);
  vi.mocked(listTags).mockResolvedValue([]);
  vi.mocked(listReadingTimes).mockResolvedValue({});
  // settings 永不到达：首帧只能靠缓存，getSettings 纠偏路径不参与断言
  vi.mocked(getSettings).mockImplementation(() => new Promise(() => {}));
}

afterEach(() => {
  cleanup();
  resetSettingsCacheForTests();
  primeCoverLibraryRoot(null);
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  sessionStorage.clear();
  vi.clearAllMocks();
});

describe("U-3 密度/排序首帧（预热缓存同步读）", () => {
  test("缓存预热 xl 后首帧即特大档，不等 getSettings", async () => {
    primeSettingsCache({ library_density: "xl", library_sort: '{"key":"title","asc":true}' });
    mockInvokes([]);
    const { container } = renderLibrary();
    const grid = container.querySelector<HTMLElement>(".wr-book-grid");
    expect(grid).toBeTruthy();
    // 首帧（settings 未达）就是 xl：类名 + 列模板同步到位，无默认档闪帧
    expect(grid?.className).toContain("wr-book-grid--xl");
    expect(grid?.style.gridTemplateColumns).toContain("420px");
  });

  test("缓存未预热回退默认档（原行为兜底）", () => {
    mockInvokes([]);
    const { container } = renderLibrary();
    const grid = container.querySelector<HTMLElement>(".wr-book-grid");
    expect(grid?.className).toBe("wr-book-grid");
    expect(grid?.style.gridTemplateColumns).toContain("220px");
  });
});

describe("U-19 继续阅读封面持久通道", () => {
  test("冷 blob 缓存下 img src 走 asset 持久路径，绝不产生 blob:", async () => {
    primeCoverLibraryRoot("C:/Users/me/AppData/Roaming/com.root.bookreading");
    stubTauriConvertFileSrc();
    // 继续阅读的书在子书架（不在根视图过滤集内）——请求集带上它（U-19 修复点）
    mockInvokes([
      book({
        id: "cont",
        title: "继续之书",
        cover_path: "library/covers/cont.jpg",
        last_opened_at: 1700000000,
        reading_percent: 0.3,
        shelf_id: 5,
      }),
      book({ id: "plain", title: "普通书", added_at: 2 }),
    ]);
    const { container } = renderLibrary();
    await waitFor(() => {
      expect(container.querySelector(".wr-continue-card")).toBeTruthy();
    });
    const img = container.querySelector<HTMLImageElement>(".wr-continue-card img");
    expect(img).toBeTruthy();
    expect(img?.src.startsWith("blob:")).toBe(false);
    expect(img?.src).toBe(
      `http://asset.localhost/${encodeURIComponent(
        "C:/Users/me/AppData/Roaming/com.root.bookreading/library/covers/cont.jpg",
      )}`,
    );
  });
});
