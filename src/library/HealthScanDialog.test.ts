import { describe, expect, test } from "vitest";

import type { Book } from "../tauri/invoke";
import { missingSourceLabel, missingSourceRow } from "./HealthScanDialog";

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
