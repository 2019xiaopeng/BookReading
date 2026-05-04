import { describe, expect, test, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  return { invokeMock: vi.fn() };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: hoisted.invokeMock }));

import {
  addBookmark,
  addFavoriteQuote,
  addHighlight,
  deleteBook,
  deleteBookmark,
  deleteFavoriteQuote,
  deleteHighlight,
  getReadingState,
  listBookmarks,
  listFavoriteQuotes,
  listHighlights,
  setBookFavorite,
  upsertReadingState,
} from "./invoke";

describe("tauri invoke arg casing", () => {
  test("deleteBook uses bookId", async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await deleteBook("b1");
    expect(hoisted.invokeMock).toHaveBeenLastCalledWith("delete_book", { bookId: "b1" });
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
});
