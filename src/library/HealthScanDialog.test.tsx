// @vitest-environment jsdom
// 书库体检弹窗（v3.2）：勾选 + 全选 + 底部批量操作（一次确认）；重复导入按份显示位置。
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const slot = vi.hoisted(() => ({
  scan: vi.fn(),
  listBooks: vi.fn(),
  listShelves: vi.fn(),
  listTags: vi.fn(),
  deleteFromDisk: vi.fn(),
  deleteBooks: vi.fn(),
  showConfirm: vi.fn(),
  showAlert: vi.fn(),
}));

vi.mock("../tauri/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri/invoke")>();
  return {
    ...actual,
    scanLibraryHealth: slot.scan,
    listBooks: slot.listBooks,
    listShelves: slot.listShelves,
    listTags: slot.listTags,
    deleteBooksFromDisk: slot.deleteFromDisk,
    deleteBooks: slot.deleteBooks,
  };
});
vi.mock("../reader/image/api", () => ({ relinkImageBook: vi.fn() }));
vi.mock("../ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/dialog")>();
  return { ...actual, showConfirm: slot.showConfirm, showAlert: slot.showAlert };
});
vi.mock("./BookDetailsDialog", () => ({ default: () => <div>details stub</div> }));

import type { Book, LibraryHealth } from "../tauri/invoke";
import HealthScanDialog from "./HealthScanDialog";

const base: Book = {
  id: "",
  title: null,
  author: null,
  cover_path: null,
  library_path: "",
  added_at: 0,
  last_opened_at: null,
  note: null,
  pinned_at: null,
  reading_percent: null,
  is_favorite: false,
  format: "epub",
  page_count: null,
  shelf_id: null,
  sort_order: null,
  deleted_at: null,
  description: null,
  content_chars: null,
  file_size: null,
  tags: [],
};
const mk = (id: string, extra: Partial<Book>): Book => ({ ...base, id, ...extra });

const BOOKS: Book[] = [
  mk("a1", { title: "重复书", library_path: "library/epub/a1.epub", shelf_id: 1, file_size: 1024, added_at: 1000 }),
  mk("a2", { title: "重复书", library_path: "E:\\Downloads\\重复书.epub", shelf_id: null, file_size: 2048, added_at: 2000 }),
  mk("m1", { title: "失链一", format: "images", library_path: "D:/Gone/1" }),
  mk("m2", { title: "失链二", format: "epub", library_path: "library/epub/m2.epub" }),
];
const HEALTH: LibraryHealth = {
  duplicates: [{ label: "重复书", bookIds: ["a1", "a2"] }],
  missingSources: [
    { bookId: "m1", title: "失链一", path: "D:/Gone/1", kind: "folder" },
    { bookId: "m2", title: "失链二", path: "library/epub/m2.epub", kind: "library" },
  ],
  missingCovers: [],
};
const CLEAN: LibraryHealth = { duplicates: [], missingSources: [], missingCovers: [] };

const dlg = () => screen.getByRole("dialog", { name: "书库体检" });

async function mount() {
  render(<HealthScanDialog onClose={vi.fn()} />);
  await within(dlg()).findByText("重复导入（1 组）");
}

beforeAll(() => {
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
  slot.scan.mockResolvedValue(HEALTH);
  slot.listBooks.mockResolvedValue(BOOKS);
  slot.listShelves.mockResolvedValue([{ id: 1, name: "漫画", parent_id: null, sort_order: 1, created_at: 0 }]);
  slot.listTags.mockResolvedValue([]);
  slot.deleteFromDisk.mockResolvedValue(2);
  slot.deleteBooks.mockResolvedValue(undefined);
  slot.showConfirm.mockResolvedValue(true);
  slot.showAlert.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("HealthScanDialog（v3.2 批量勾选与重复项位置）", () => {
  test("重复导入按份显示：位置、所在书架；未勾选时底部只有提示", async () => {
    await mount();
    expect(within(dlg()).getByText("位置 · 书库内 · library/epub/a1.epub")).toBeTruthy();
    expect(within(dlg()).getByText("位置 · E:\\Downloads\\重复书.epub")).toBeTruthy();
    expect(within(dlg()).getByText(/书架 · 漫画 · 大小 · .* · 导入于/)).toBeTruthy();
    expect(within(dlg()).getByText(/书架 · 未归书架/)).toBeTruthy();
    expect(within(dlg()).getByText("勾选条目后可批量处理")).toBeTruthy();
    expect(within(dlg()).queryByRole("button", { name: /删除所选失链/ })).toBeNull();
    expect(within(dlg()).queryByRole("button", { name: /移入回收站 \d+ 份/ })).toBeNull();
  });

  test("失链：全选 → 一次确认 → 一次调用删完所有勾选；完成后重扫并清空勾选", async () => {
    slot.scan.mockResolvedValueOnce(HEALTH).mockResolvedValue(CLEAN);
    await mount();
    fireEvent.click(within(dlg()).getByRole("button", { name: "全选失链" }));
    expect(within(dlg()).getByText("已选 2 项（失链 2 · 重复项 0）")).toBeTruthy();
    fireEvent.click(within(dlg()).getByRole("button", { name: "删除所选失链 2 本" }));
    await waitFor(() => expect(slot.deleteFromDisk).toHaveBeenCalledTimes(1));
    expect(slot.deleteFromDisk).toHaveBeenCalledWith(["m1", "m2"]);
    expect(slot.showConfirm).toHaveBeenCalledTimes(1); // 不再逐本确认
    await within(dlg()).findByText("失链（0 本）");
    expect(within(dlg()).getByText("勾选条目后可批量处理")).toBeTruthy();
  });

  test("重复项：只勾一份 → 一次确认 → 移入书库回收站（软删，不是从电脑删除）", async () => {
    slot.scan.mockResolvedValueOnce(HEALTH).mockResolvedValue(CLEAN);
    await mount();
    fireEvent.click(within(dlg()).getByRole("checkbox", { name: "选择重复项（E:\\Downloads\\重复书.epub）" }));
    fireEvent.click(within(dlg()).getByRole("button", { name: "重复项移入回收站 1 份" }));
    await waitFor(() => expect(slot.deleteBooks).toHaveBeenCalledTimes(1));
    expect(slot.deleteBooks).toHaveBeenCalledWith(["a2"]);
    expect(slot.deleteFromDisk).not.toHaveBeenCalled();
    expect(slot.showConfirm).toHaveBeenCalledTimes(1);
    expect(String(slot.showConfirm.mock.calls[0][1])).not.toContain("全部副本都被选中");
  });

  test("重复项：整组两份都勾上时，确认框明确警告这本书将从所有书架消失", async () => {
    await mount();
    fireEvent.click(within(dlg()).getByRole("button", { name: "全选重复项" }));
    fireEvent.click(within(dlg()).getByRole("button", { name: "重复项移入回收站 2 份" }));
    await waitFor(() => expect(slot.showConfirm).toHaveBeenCalledTimes(1));
    expect(slot.showConfirm.mock.calls[0][0]).toBe("把所选的 2 份重复书籍移入回收站");
    expect(slot.showConfirm.mock.calls[0][1]).toContain("全部副本都被选中");
    expect(slot.showConfirm.mock.calls[0][2]).toMatchObject({ danger: true });
  });

  test("取消确认：什么都不删，勾选保留", async () => {
    slot.showConfirm.mockResolvedValue(false);
    await mount();
    fireEvent.click(within(dlg()).getByRole("checkbox", { name: "选择《失链一》" }));
    fireEvent.click(within(dlg()).getByRole("button", { name: "删除所选失链 1 本" }));
    await waitFor(() => expect(slot.showConfirm).toHaveBeenCalledTimes(1));
    expect(slot.deleteFromDisk).not.toHaveBeenCalled();
    expect(within(dlg()).getByRole("button", { name: "删除所选失链 1 本" })).toBeTruthy();
  });
});
