// @vitest-environment jsdom
import { describe, expect, test } from "vitest";

import { dropThemeSheet, hasZipEnd } from "./reader";

describe("dropThemeSheet（E7：重选主题前撤掉已注入的样式表）", () => {
  test("只撤指定主题的那张；别的主题、别的文档不动；返回撤掉的张数", () => {
    const a = document.implementation.createHTMLDocument("");
    const b = document.implementation.createHTMLDocument("");
    a.head.innerHTML = '<style id="epubjs-inserted-css-default"></style><style id="epubjs-inserted-css-ink"></style>';
    b.head.innerHTML = '<style id="epubjs-inserted-css-ink"></style><style id="epubjs-inserted-css-sepia"></style>';
    const contents = [{ document: a }, { document: b }, { document: undefined }, null];
    expect(dropThemeSheet(contents, "ink")).toBe(2);
    expect(a.getElementById("epubjs-inserted-css-ink")).toBeNull();
    expect(a.getElementById("epubjs-inserted-css-default")).not.toBeNull();
    expect(b.getElementById("epubjs-inserted-css-ink")).toBeNull();
    expect(b.getElementById("epubjs-inserted-css-sepia")).not.toBeNull();
    // 再撤一次：已经没有了
    expect(dropThemeSheet(contents, "ink")).toBe(0);
    expect(dropThemeSheet([], "ink")).toBe(0);
  });
});

describe("hasZipEnd（R1：尾部的中央目录结束记录）", () => {
  const EOCD = [0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)];
  const HEAD = [0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4];

  test("完整 / 尾部带注释 → true", () => {
    expect(hasZipEnd(new Uint8Array([...HEAD, ...EOCD]))).toBe(true);
    expect(hasZipEnd(new Uint8Array([...HEAD, ...EOCD, 1, 2, 3, 4, 5]))).toBe(true);
    // 注释最长 64KB：EOCD 压在窗口最前面也认得
    const withComment = new Uint8Array([...HEAD, ...EOCD, ...new Array(65530).fill(7)]);
    expect(hasZipEnd(withComment)).toBe(true);
  });

  test("半截 / 空 / 只有签名 / EOCD 在 64KB 窗口之外 → false", () => {
    expect(hasZipEnd(new Uint8Array([...HEAD, 1, 2, 3]))).toBe(false);
    expect(hasZipEnd(new Uint8Array(0))).toBe(false);
    expect(hasZipEnd(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(false);
    expect(hasZipEnd(new Uint8Array([0x50, 0x4b, 0x03, 0x06]))).toBe(false); // 签名差一个字节不算
    const far = new Uint8Array(22 + 70000);
    far.set(EOCD, 0);
    expect(hasZipEnd(far)).toBe(false);
  });
});
