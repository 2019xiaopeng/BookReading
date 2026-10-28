import { describe, expect, test } from "vitest";

import { defaultPdfReaderSettings, normalizePdfReaderSettings, pagePercent, parsePdfCfi, pdfCfi } from "./layout";

describe("pdf cfi", () => {
  test("round trip pdf:N", () => {
    expect(pdfCfi(0)).toBe("pdf:0");
    expect(pdfCfi(41)).toBe("pdf:41");
    expect(parsePdfCfi("pdf:41")).toBe(41);
    expect(parsePdfCfi("pdf:0")).toBe(0);
  });

  test("rejects non-pdf / malformed cfis", () => {
    expect(parsePdfCfi(null)).toBeNull();
    expect(parsePdfCfi("")).toBeNull();
    expect(parsePdfCfi("img:3")).toBeNull();
    expect(parsePdfCfi("epubcfi(/6/4)")).toBeNull();
    expect(parsePdfCfi("pdf:-1")).toBeNull();
    expect(parsePdfCfi("pdf:x")).toBeNull();
  });

  test("percent = page / pageCount", () => {
    expect(pagePercent(0, 10)).toBe(0);
    expect(pagePercent(5, 10)).toBe(0.5);
    expect(pagePercent(9, 10)).toBe(0.9);
    expect(pagePercent(99, 10)).toBe(1);
    expect(pagePercent(0, 0)).toBe(0);
  });
});

describe("normalizePdfReaderSettings", () => {
  test("defaults and json string input", () => {
    expect(normalizePdfReaderSettings(null)).toEqual(defaultPdfReaderSettings);
    expect(normalizePdfReaderSettings("{}")).toEqual(defaultPdfReaderSettings);
    expect(normalizePdfReaderSettings(JSON.stringify({ fit: "width", mode: "scroll" }))).toEqual({
      fit: "width",
      mode: "scroll",
    });
  });

  test("unknown values fall back to defaults", () => {
    expect(normalizePdfReaderSettings({ fit: "nope", mode: "webtoon" })).toEqual(defaultPdfReaderSettings);
  });
});
