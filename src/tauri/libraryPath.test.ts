import { describe, expect, test } from "vitest";

import { coerceToLibraryRelPath } from "./libraryPath";

describe("coerceToLibraryRelPath", () => {
  test("returns library rel when already relative", () => {
    expect(coerceToLibraryRelPath("library/books/a.epub")).toBe("library/books/a.epub");
    expect(coerceToLibraryRelPath("library\\books\\a.epub")).toBe("library/books/a.epub");
  });

  test("extracts library rel from absolute appData prefix", () => {
    const base = "C:\\Users\\me\\AppData\\Roaming\\com.root.bookreading";
    const abs = "C:\\Users\\me\\AppData\\Roaming\\com.root.bookreading\\library\\books\\a.epub";
    expect(coerceToLibraryRelPath(abs, base)).toBe("library/books/a.epub");
  });

  test("extracts library rel from any path containing /library/", () => {
    const abs = "D:\\any\\thing\\library\\covers\\c.jpg";
    expect(coerceToLibraryRelPath(abs)).toBe("library/covers/c.jpg");
  });

  test("returns null when cannot be coerced", () => {
    expect(coerceToLibraryRelPath("C:\\nope\\a.epub")).toBeNull();
  });
});

