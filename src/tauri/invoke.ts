import { invoke } from "@tauri-apps/api/core";

export type Book = {
  id: string;
  title: string | null;
  author: string | null;
  cover_path: string | null;
  library_path: string;
  added_at: number;
  last_opened_at: number | null;
  is_favorite: boolean;
};

export type ImportBookRequest = {
  source_path: string;
  title: string | null;
  author: string | null;
  cover_bytes_base64: string | null;
  cover_ext: string | null;
};

export type UpdateBookMetadataRequest = {
  book_id: string;
  title: string | null;
  author: string | null;
  cover_bytes_base64: string | null;
  cover_ext: string | null;
};

export async function listBooks(): Promise<Book[]> {
  return invoke<Book[]>("list_books");
}

export async function importBook(req: ImportBookRequest): Promise<Book> {
  return invoke<Book>("import_book", { req });
}

export async function appendFrontendLog(line: string): Promise<void> {
  return invoke<void>("append_frontend_log", { line });
}

export async function repairBookMetadata(bookId: string): Promise<Book> {
  return invoke<Book>("repair_book_metadata", { bookId });
}

export async function updateBookMetadata(req: UpdateBookMetadataRequest): Promise<Book> {
  return invoke<Book>("update_book_metadata", { req });
}

export async function deleteBook(bookId: string): Promise<void> {
  return invoke<void>("delete_book", { bookId });
}

export async function getSettings(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_settings");
}

export async function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("set_setting", { key, value });
}

export type ReadingState = {
  book_id: string;
  cfi: string;
  percent: number | null;
  updated_at: number;
};

export async function getReadingState(bookId: string): Promise<ReadingState | null> {
  return invoke<ReadingState | null>("get_reading_state", { bookId });
}

export async function upsertReadingState(bookId: string, cfi: string, percent: number | null): Promise<void> {
  return invoke<void>("upsert_reading_state", { bookId, cfi, percent });
}

export type Bookmark = {
  id: string;
  book_id: string;
  cfi: string;
  label: string | null;
  created_at: number;
};

export type Highlight = {
  id: string;
  book_id: string;
  cfi_range: string;
  color: string;
  note: string | null;
  created_at: number;
};

export async function listBookmarks(bookId: string): Promise<Bookmark[]> {
  return invoke<Bookmark[]>("list_bookmarks", { bookId });
}

export async function addBookmark(bookId: string, cfi: string, label: string | null): Promise<Bookmark> {
  return invoke<Bookmark>("add_bookmark", { bookId, cfi, label });
}

export async function deleteBookmark(bookmarkId: string): Promise<void> {
  return invoke<void>("delete_bookmark", { bookmarkId });
}

export async function listHighlights(bookId: string): Promise<Highlight[]> {
  return invoke<Highlight[]>("list_highlights", { bookId });
}

export async function addHighlight(
  bookId: string,
  cfiRange: string,
  color: string,
  note: string | null,
): Promise<Highlight> {
  return invoke<Highlight>("add_highlight", { bookId, cfiRange, color, note });
}

export async function deleteHighlight(highlightId: string): Promise<void> {
  return invoke<void>("delete_highlight", { highlightId });
}

export type FavoriteQuote = {
  id: string;
  book_id: string;
  cfi_range: string;
  text: string;
  note: string | null;
  created_at: number;
};

export async function setBookFavorite(bookId: string, isFavorite: boolean): Promise<void> {
  return invoke<void>("set_book_favorite", { bookId, isFavorite });
}

export async function listFavoriteBooks(): Promise<Book[]> {
  return invoke<Book[]>("list_favorite_books");
}

export async function addFavoriteQuote(
  bookId: string,
  cfiRange: string,
  text: string,
  note: string | null,
): Promise<FavoriteQuote> {
  return invoke<FavoriteQuote>("add_favorite_quote", {
    bookId,
    cfiRange,
    text,
    note,
  });
}

export async function deleteFavoriteQuote(quoteId: string): Promise<void> {
  return invoke<void>("delete_favorite_quote", { quoteId });
}

export async function listFavoriteQuotes(params?: {
  bookId?: string | null;
  query?: string | null;
}): Promise<FavoriteQuote[]> {
  return invoke<FavoriteQuote[]>("list_favorite_quotes", {
    bookId: params?.bookId ?? null,
    query: params?.query ?? null,
  });
}
