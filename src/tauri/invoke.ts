import { invoke } from "@tauri-apps/api/core";

export type Book = {
  id: string;
  title: string | null;
  author: string | null;
  cover_path: string | null;
  library_path: string;
  added_at: number;
  last_opened_at: number | null;
  note: string | null;
  pinned_at: number | null;
  reading_percent: number | null;
  is_favorite: boolean;
  format: string | null;
  page_count: number | null;
  shelf_id: number | null;
  sort_order: number | null;
  deleted_at: number | null;
  description: string | null;
  content_chars: number | null;
  file_size: number | null;
  tags: BookTagBrief[];
};

export type BookTagBrief = {
  id: number;
  name: string;
  color: string | null;
};

export type Tag = {
  id: number;
  name: string;
  color: string | null;
  sort_order: number;
  book_count: number;
};

export type Shelf = {
  id: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
  created_at: number;
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
  title?: string;
  note?: string;
  pinned?: boolean;
  author?: string;
  description?: string;
};

export async function listBooks(): Promise<Book[]> {
  return invoke<Book[]>("list_books");
}

export async function listShelves(): Promise<Shelf[]> {
  return invoke<Shelf[]>("list_shelves");
}

export async function createShelf(name: string, parentId: number | null): Promise<Shelf> {
  return invoke<Shelf>("create_shelf", { name, parentId });
}

export async function renameShelf(id: number, name: string): Promise<void> {
  return invoke<void>("rename_shelf", { id, name });
}

export async function moveShelf(id: number, newParentId: number | null): Promise<void> {
  return invoke<void>("move_shelf", { id, newParentId });
}

export async function deleteShelf(id: number): Promise<void> {
  return invoke<void>("delete_shelf", { id });
}

export async function setShelfOrder(ids: number[]): Promise<void> {
  return invoke<void>("set_shelf_order", { ids });
}

export async function moveBooksToShelf(bookIds: string[], shelfId: number | null): Promise<void> {
  return invoke<void>("move_books_to_shelf", { bookIds, shelfId });
}

export async function setBooksOrder(bookIds: string[]): Promise<void> {
  return invoke<void>("set_books_order", { bookIds });
}

export async function deleteBooks(bookIds: string[]): Promise<void> {
  return invoke<void>("delete_books", { bookIds });
}

export async function restoreBooks(bookIds: string[]): Promise<void> {
  return invoke<void>("restore_books", { bookIds });
}

export async function purgeBooks(bookIds: string[]): Promise<void> {
  return invoke<void>("purge_books", { bookIds });
}

export async function listTrash(): Promise<Book[]> {
  return invoke<Book[]>("list_trash");
}

export async function setTrashRetentionDays(days: number): Promise<void> {
  return invoke<void>("set_trash_retention_days", { days });
}

export async function listTags(): Promise<Tag[]> {
  return invoke<Tag[]>("list_tags");
}

export async function createTag(name: string, color: string | null): Promise<Tag> {
  return invoke<Tag>("create_tag", { name, color });
}

export async function renameTag(id: number, name: string): Promise<void> {
  return invoke<void>("rename_tag", { id, name });
}

export async function recolorTag(id: number, color: string | null): Promise<void> {
  return invoke<void>("recolor_tag", { id, color });
}

export async function mergeTags(fromId: number, toId: number): Promise<void> {
  return invoke<void>("merge_tags", { fromId, toId });
}

export async function deleteTag(id: number): Promise<void> {
  return invoke<void>("delete_tag", { id });
}

export async function setBookTags(bookId: string, tagIds: number[]): Promise<void> {
  return invoke<void>("set_book_tags", { bookId, tagIds });
}

export async function addTagsToBooks(bookIds: string[], tagIds: number[]): Promise<void> {
  return invoke<void>("add_tags_to_books", { bookIds, tagIds });
}

export async function computeBookStats(bookId: string): Promise<Book> {
  return invoke<Book>("compute_book_stats", { bookId });
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

export async function saveReaderBackground(sourcePath: string): Promise<string> {
  return invoke<string>("save_reader_background", { sourcePath });
}

// B11 自定义正文字体：单槽安装（校验+复制到 library/fonts/font.<ext>，返回相对路径）与删除（恢复默认）
export async function saveReaderFont(sourcePath: string): Promise<string> {
  return invoke<string>("save_reader_font", { sourcePath });
}

export async function deleteReaderFont(): Promise<void> {
  return invoke<void>("delete_reader_font");
}

// 批量导入用：父目录下"直接含图片"的一级子目录（服务端过滤空/无图目录，自然序）
export async function listImageSubdirs(parent: string): Promise<string[]> {
  return invoke<string[]>("list_image_subdirs", { parent });
}

// 自定义封面：校验+复制到 covers/{book_id}.{ext}，更新 books.cover_path，返回新 cover_path
export async function setBookCover(bookId: string, sourcePath: string): Promise<string> {
  return invoke<string>("set_book_cover", { bookId, sourcePath });
}

// B13 存量封面重提取：为所有 EPUB 重新选择最高清封面（覆盖 covers/{id}），返回更新本数
export async function reextractAllCovers(): Promise<number> {
  return invoke<number>("reextract_all_covers");
}

export type ReadingState = {
  book_id: string;
  cfi: string;
  percent: number | null;
  updated_at: number;
};

// ---- 存储（批次10）----

export type StorageStats = {
  library_root: string;
  db_path: string;
  library_bytes: number;
  covers_bytes: number;
  bg_bytes: number;
  db_bytes: number;
  logs_bytes: number;
  trash_count: number;
};

export async function storageStats(): Promise<StorageStats> {
  return invoke<StorageStats>("storage_stats");
}

// 成功返回汇总文案（含"重启生效"提示）；失败抛错且不写设置
export async function migrateLibraryRoot(newRoot: string): Promise<string> {
  return invoke<string>("migrate_library_root", { newRoot });
}

export type ClearCacheResult = { freed_bytes: number };

// 可清类别：covers / bg / logs（books/db 后端拒绝）
export async function clearCache(categories: string[]): Promise<ClearCacheResult> {
  return invoke<ClearCacheResult>("clear_cache", { categories });
}

export type PathInfo = {
  path: string;
  name: string;
  is_dir: boolean;
  size: number;
};

// 批量导入前探针：webview 拿不到 is_dir / 文件大小，由主进程补齐
export async function probePaths(paths: string[]): Promise<PathInfo[]> {
  return invoke<PathInfo[]>("probe_paths", { paths });
}

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
