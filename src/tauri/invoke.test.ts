import { describe, expect, test, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  return { invokeMock: vi.fn() };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: hoisted.invokeMock }));

import {
  addBookmark,
  addFavoriteQuote,
  addHighlight,
  addTagsToBooks,
  computeBookStats,
  createShelf,
  createTag,
  deleteBook,
  deleteBookmark,
  deleteBooks,
  deleteFavoriteQuote,
  deleteHighlight,
  deleteShelf,
  deleteTag,
  getBook,
  getReadingState,
  listBookmarks,
  listFavoriteQuotes,
  listHighlights,
  listTags,
  listTrash,
  mergeTags,
  moveBooksToShelf,
  moveShelf,
  purgeBooks,
  recolorTag,
  renameShelf,
  renameTag,
  repairBookMetadata,
  restoreBooks,
  loadBookLocations,
  saveBookLocations,
  setBookFavorite,
  setBookTags,
  setBooksOrder,
  setSettings,
  setShelfOrder,
  setTrashRetentionDays,
  updateBookMetadata,
  upsertReadingState,
} from "./invoke";

describe("tauri invoke arg casing", () => {
  test("deleteBook uses bookId", async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await deleteBook("b1");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("delete_book", { bookId: "b1" });
  });

  test("repairBookMetadata uses bookId", async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await repairBookMetadata("b1");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("repair_book_metadata", { bookId: "b1" });
  });

  test("updateBookMetadata wraps req", async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await updateBookMetadata({ book_id: "b1", pinned: true });
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("update_book_metadata", { req: { book_id: "b1", pinned: true } });
  });

  test("reading state uses bookId", async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await getReadingState("b1");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("get_reading_state", { bookId: "b1" });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await upsertReadingState("b1", "cfi", 0.5);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("upsert_reading_state", { bookId: "b1", cfi: "cfi", percent: 0.5 });
  });

  test("bookmarks/highlights use camelCase keys", async () => {
    hoisted.invokeMock.mockResolvedValueOnce([]);
    await listBookmarks("b1");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("list_bookmarks", { bookId: "b1" });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await addBookmark("b1", "cfi", "label");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("add_bookmark", { bookId: "b1", cfi: "cfi", label: "label" });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await deleteBookmark("m1");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("delete_bookmark", { bookmarkId: "m1" });

    hoisted.invokeMock.mockResolvedValueOnce([]);
    await listHighlights("b1");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("list_highlights", { bookId: "b1" });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await addHighlight("b1", "cfiRange", "yellow", null);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("add_highlight", { bookId: "b1", cfiRange: "cfiRange", color: "yellow", note: null });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await deleteHighlight("h1");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("delete_highlight", { highlightId: "h1" });
  });

  test("favorites use camelCase keys", async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await setBookFavorite("b1", true);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("set_book_favorite", { bookId: "b1", isFavorite: true });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await addFavoriteQuote("b1", "cfiRange", "text", null);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("add_favorite_quote", { bookId: "b1", cfiRange: "cfiRange", text: "text", note: null });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await deleteFavoriteQuote("q1");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("delete_favorite_quote", { quoteId: "q1" });

    hoisted.invokeMock.mockResolvedValueOnce([]);
    await listFavoriteQuotes({ bookId: "b1", query: "x" });
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("list_favorite_quotes", { bookId: "b1", query: "x" });
  });

  test("shelf commands use camelCase keys", async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await createShelf("小说", 3);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("create_shelf", { name: "小说", parentId: 3 });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await renameShelf(3, "漫画");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("rename_shelf", { id: 3, name: "漫画" });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await moveShelf(3, null);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("move_shelf", { id: 3, newParentId: null });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await deleteShelf(3);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("delete_shelf", { id: 3 });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await setShelfOrder([2, 1]);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("set_shelf_order", { ids: [2, 1] });
  });

  test("book batch/trash commands use camelCase keys", async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await moveBooksToShelf(["b1", "b2"], 3);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("move_books_to_shelf", { bookIds: ["b1", "b2"], shelfId: 3 });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await setBooksOrder(["b2", "b1"]);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("set_books_order", { bookIds: ["b2", "b1"] });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await deleteBooks(["b1"]);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("delete_books", { bookIds: ["b1"] });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await restoreBooks(["b1"]);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("restore_books", { bookIds: ["b1"] });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await purgeBooks(["b1"]);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("purge_books", { bookIds: ["b1"] });

    hoisted.invokeMock.mockResolvedValueOnce([]);
    await listTrash();
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("list_trash");

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await setTrashRetentionDays(7);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("set_trash_retention_days", { days: 7 });
  });

  test("tag commands use camelCase keys", async () => {
    hoisted.invokeMock.mockResolvedValueOnce([]);
    await listTags();
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("list_tags");

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await createTag("科幻", "#1971c2");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("create_tag", { name: "科幻", color: "#1971c2" });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await renameTag(3, "小说");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("rename_tag", { id: 3, name: "小说" });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await recolorTag(3, null);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("recolor_tag", { id: 3, color: null });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await mergeTags(1, 2);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("merge_tags", { fromId: 1, toId: 2 });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await deleteTag(3);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("delete_tag", { id: 3 });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await setBookTags("b1", [1, 2]);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("set_book_tags", { bookId: "b1", tagIds: [1, 2] });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await addTagsToBooks(["b1", "b2"], [3]);
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("add_tags_to_books", { bookIds: ["b1", "b2"], tagIds: [3] });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await computeBookStats("b1");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("compute_book_stats", { bookId: "b1" });
  });
});

describe("v2.5 新增 wrapper 参数命名", () => {
  test("getBook / setSettings / bookLocations 用 camelCase 键", async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await getBook("b1");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("get_book", { bookId: "b1" });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await setSettings({ fontSizePercent: "120" });
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("set_settings", { values: { fontSizePercent: "120" } });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await saveBookLocations("b1", "default|120", "[]");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("save_book_locations", {
      bookId: "b1",
      cacheKey: "default|120",
      payload: "[]",
    });

    hoisted.invokeMock.mockResolvedValueOnce(null);
    await loadBookLocations("b1", "default|120");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("load_book_locations", { bookId: "b1", cacheKey: "default|120" });
  });
});
