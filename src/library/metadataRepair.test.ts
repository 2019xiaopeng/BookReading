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
    is_favorite: false,
    ...partial,
  };
}

describe("needsMetadataRepair", () => {
  test("returns true when both title and author missing", () => {
    expect(needsMetadataRepair(b({ title: null, author: null }))).toBe(true);
  });

  test("returns true when title is blank", () => {
    expect(needsMetadataRepair(b({ title: "   ", author: "A" }))).toBe(true);
  });

  test("returns false when title and author present", () => {
    expect(needsMetadataRepair(b({ title: "T", author: "A" }))).toBe(false);
  });
});

