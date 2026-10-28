import { describe, expect, test, vi } from "vitest";

vi.mock("../tauri/invoke", () => ({
  listBooks: vi.fn(),
  importBook: vi.fn(),
  computeBookStats: vi.fn(),
  probePaths: vi.fn(),
}));
vi.mock("../reader/image/api", () => ({ importImageFolder: vi.fn() }));
vi.mock("../ui/dialog", () => ({ showAlert: vi.fn() }));
vi.mock("../tauri/frontendLog", () => ({ logFrontend: vi.fn() }));

import type { Book } from "../tauri/invoke";
import { buildDedupIndex, checkDuplicate, isImportableFile } from "./importRunner";

function makeBook(partial: Partial<Book>): Book {
  return {
    id: "id",
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
    format: null,
    page_count: null,
    shelf_id: null,
    sort_order: null,
    deleted_at: null,
    description: null,
    content_chars: null,
    file_size: null,
    tags: [],
    ...partial,
  };
}

const info = (name: string, size: number, path = `C:/in/${name}`, isDir = false) => ({
  path,
  name,
  is_dir: isDir,
  size,
});

describe("buildDedupIndex", () => {
  test("copied books key by basename and title; folder comics key by full path", () => {
    const index = buildDedupIndex([
      makeBook({ library_path: "library/books/uuid1.epub", title: "三体", file_size: 100 }),
      makeBook({ library_path: "library/books/uuid2.cbz", title: null, file_size: 200, format: "images" }),
      makeBook({ library_path: "D:\\comics\\A 卷", title: "A", file_size: 300, format: "images" }),
    ]);
    expect(index.byName.get("uuid1.epub")).toEqual(new Set([100]));
    expect(index.byName.get("三体")).toEqual(new Set([100]));
    expect(index.byName.get("uuid2.cbz")).toEqual(new Set([200]));
    expect(index.folderPaths.has("d:/comics/a 卷")).toBe(true);
  });

  test("books without file_size do not join the size index", () => {
    const index = buildDedupIndex([makeBook({ library_path: "library/books/x.epub", title: "X", file_size: null })]);
    expect(index.byName.size).toBe(0);
  });
});

describe("checkDuplicate", () => {
  test("dir: same absolute path (any slash/case) is exists", () => {
    const index = buildDedupIndex([makeBook({ library_path: "D:\\Comics\\A", format: "images", file_size: 1 })]);
    expect(checkDuplicate(info("A", 0, "d:/comics/a", true), index)).toEqual({ kind: "exists" });
    expect(checkDuplicate(info("B", 0, "D:/Comics/B", true), index)).toEqual({ kind: null });
  });

  test("file: same basename+bytes or same title+bytes is suspected dup", () => {
    const index = buildDedupIndex([makeBook({ library_path: "library/books/uuid.epub", title: "三体", file_size: 100 })]);
    expect(checkDuplicate(info("三体.epub", 100), index)).toEqual({ kind: "dup" });
    expect(checkDuplicate(info("三体", 100), index)).toEqual({ kind: "dup" });
    expect(checkDuplicate(info("三体.epub", 999), index)).toEqual({ kind: null });
    expect(checkDuplicate(info("别的.epub", 100), index)).toEqual({ kind: null });
  });
});

describe("isImportableFile", () => {
  test("epub/txt/cbz/pdf in any case; others rejected", () => {
    expect(isImportableFile("a.epub")).toBe(true);
    expect(isImportableFile("a.TXT")).toBe(true);
    expect(isImportableFile("a.Cbz")).toBe(true);
    expect(isImportableFile("a.PDF")).toBe(true);
    expect(isImportableFile("a.mobi")).toBe(false);
    expect(isImportableFile("noext")).toBe(false);
  });
});
