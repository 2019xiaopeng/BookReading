import { describe, expect, test } from "vitest";

import type { Book } from "../tauri/invoke";
import { needsMetadataRepair } from "./metadataRepair";

function b(partial: Partial<Book>): Book {
  return {
    id: "b1",
    title: null,
    author: null,
    cover_path: null,
    library_path: "library/books/b1.epub",
    added_at: 0,
    last_opened_at: null,
    note: null,
    pinned_at: null,
    reading_percent: null,
    is_favorite: false,
    format: null,
    shelf_id: null,
    sort_order: null,
    deleted_at: null,
    page_count: null,
    description: null,
    content_chars: null,
    file_size: null,
    tags: [],
    ...partial,
  };
}

describe("needsMetadataRepair", () => {
  test("returns true when title missing", () => {
    expect(needsMetadataRepair(b({ title: null, author: null }))).toBe(true);
  });

  test("returns true when title is blank", () => {
    expect(needsMetadataRepair(b({ title: "   ", author: "A" }))).toBe(true);
  });

  test("returns true when cover missing", () => {
    expect(needsMetadataRepair(b({ title: "T", cover_path: null }))).toBe(true);
  });

  test("returns false when title present even without author", () => {
    expect(needsMetadataRepair(b({ title: "T", author: null, cover_path: "library/covers/b1.jpg" }))).toBe(false);
  });
});
