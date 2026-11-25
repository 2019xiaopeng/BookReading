import { describe, expect, test } from "vitest";

import type { Book, LibraryHealth, Shelf } from "../tauri/invoke";
import { formatFileSize } from "./tags";
import {
  bookLocationLabel,
  duplicateCopies,
  missingSourceLabel,
  missingSourceRow,
  selectionSplit,
} from "./HealthScanDialog";

function book(format: string | null): Book {
  return {
    id: "b1",
    title: " 库里标题 ",
    author: null,
    cover_path: null,
    library_path: "D:/Comics/A",
    added_at: 0,
    last_opened_at: null,
    note: null,
    pinned_at: null,
    reading_percent: null,
    is_favorite: false,
    format,
    page_count: null,
    shelf_id: null,
    sort_order: null,
    deleted_at: null,
    description: null,
    content_chars: null,
    file_size: null,
    tags: [],
  };
}

describe("missingSourceLabel", () => {
  test("folder=源目录已移动，library=库内文件缺失", () => {
    expect(missingSourceLabel("folder")).toBe("源目录已移动");
    expect(missingSourceLabel("library")).toBe("库内文件缺失");
  });
});

describe("missingSourceRow", () => {
  const folderMissing = {
    bookId: "b1",
    title: " 扫描标题 ",
    path: "D:/Comics/A",
    kind: "folder" as const,
  };

  test("标题优先取库内实时值，去空白后回退扫描值/ID", () => {
    expect(missingSourceRow(folderMissing, book("images")).title).toBe("库里标题");
    expect(missingSourceRow(folderMissing, undefined).title).toBe("扫描标题");
    expect(missingSourceRow({ ...folderMissing, title: null }, undefined).title).toBe("b1");
  });

  test("重链接只对 folder 且 images 格式开放", () => {
    expect(missingSourceRow(folderMissing, book("images")).canRelink).toBe(true);
    // folder 失链但库里已知不是图片书（防御后端分类变化）
    expect(missingSourceRow(folderMissing, book("epub")).canRelink).toBe(false);
    // 库内文件缺失无从指路
    expect(
      missingSourceRow({ ...folderMissing, kind: "library" }, book("images")).canRelink,
    ).toBe(false);
    // 找不到书记录时不给重链接（无格式可校验）
    expect(missingSourceRow(folderMissing, undefined).canRelink).toBe(false);
  });
});

describe("bookLocationLabel（重复项的位置文案，v3.2）", () => {
  test("外部绝对路径（原地引用 / 文件夹漫画）原样显示；库内相对路径标明'书库内'", () => {
    expect(bookLocationLabel("D:\\Books\\a.epub")).toBe("D:\\Books\\a.epub");
    expect(bookLocationLabel("E:/Comics/x")).toBe("E:/Comics/x");
    expect(bookLocationLabel("library/epub/x.epub")).toBe("书库内 · library/epub/x.epub");
  });
});

describe("duplicateCopies（重复组按份展开：位置 / 书架 / 大小，v3.2）", () => {
  const shelves: Shelf[] = [
    { id: 1, name: "漫画", parent_id: null, sort_order: 1, created_at: 0 },
    { id: 3, name: "日漫", parent_id: 1, sort_order: 1, created_at: 0 },
  ];
  const mk = (id: string, extra: Partial<Book>): Book => ({ ...book("epub"), id, ...extra });

  test("每份带位置与所在书架（含层级路径）与大小；按导入时间升序（先导入的排前）", () => {
    const books = [
      mk("a", { title: "书", library_path: "library/epub/a.epub", shelf_id: 3, file_size: 2048, added_at: 2000 }),
      mk("b", { title: "书", library_path: "D:\\外部目录\\b.epub", shelf_id: null, file_size: null, added_at: 1000 }),
    ];
    const copies = duplicateCopies({ label: "书", bookIds: ["a", "b"] }, books, shelves);
    expect(copies.map((c) => c.bookId)).toEqual(["b", "a"]);
    expect(copies[0]).toMatchObject({ location: "D:\\外部目录\\b.epub", shelf: "未归书架", size: null, addedAt: 1000 });
    expect(copies[1]).toMatchObject({
      location: "书库内 · library/epub/a.epub",
      shelf: "漫画 / 日漫",
      size: formatFileSize(2048),
      addedAt: 2000,
    });
  });

  test("库里已无记录的副本如实标注，不丢行", () => {
    const [gone] = duplicateCopies({ label: "书", bookIds: ["gone"] }, [], shelves);
    expect(gone).toMatchObject({ bookId: "gone", title: "gone", location: "书库中已无记录", shelf: "未归书架", size: null, addedAt: null });
  });
});

describe("selectionSplit（勾选集按处理方式拆分，v3.2）", () => {
  const health: LibraryHealth = {
    duplicates: [
      { label: "A", bookIds: ["a1", "a2"] },
      { label: "B", bookIds: ["b1", "b2"] },
    ],
    missingSources: [{ bookId: "m1", title: null, path: "p", kind: "library" }],
    missingCovers: [],
  };

  test("失链走'从电脑删除'、重复项走'移入回收站'，顺序沿用清单顺序；整组都被选中的重复组单独计数", () => {
    expect(selectionSplit(new Set(["m1", "a1", "a2", "b2"]), health)).toEqual({
      missingIds: ["m1"],
      dupIds: ["a1", "a2", "b2"],
      dupGroupsFullySelected: 1,
    });
    expect(selectionSplit(new Set(), health)).toEqual({ missingIds: [], dupIds: [], dupGroupsFullySelected: 0 });
    // 不在清单里的 id 不计入
    expect(selectionSplit(new Set(["zzz"]), health)).toEqual({ missingIds: [], dupIds: [], dupGroupsFullySelected: 0 });
  });
});
