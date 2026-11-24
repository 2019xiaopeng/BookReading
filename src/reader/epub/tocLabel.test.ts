import { describe, expect, test } from "vitest";

import { tocItemIsActive, tocLabelFor } from "./tocLabel";
import type { TocItem } from "./reader";

const toc: TocItem[] = [
  { label: "第一章", href: "OEBPS/text/ch1.xhtml" },
  { label: "第二章 起点", href: "OEBPS/text/ch2.xhtml#sec1" },
  { label: "  附录  ", href: "OEBPS/appendix.xhtml" },
];

describe("tocLabelFor", () => {
  test("matches by href ignoring anchors on both sides", () => {
    expect(tocLabelFor(toc, "OEBPS/text/ch2.xhtml#p4")).toBe("第二章 起点");
    expect(tocLabelFor(toc, "OEBPS/text/ch1.xhtml")).toBe("第一章");
  });

  test("trims label, null on unmatched or anchor-only href", () => {
    expect(tocLabelFor(toc, "OEBPS/appendix.xhtml")).toBe("附录");
    expect(tocLabelFor(toc, "OEBPS/none.xhtml")).toBeNull();
    expect(tocLabelFor(toc, "#anchor-only")).toBeNull();
    expect(tocLabelFor(toc, "")).toBeNull();
  });
});

describe("tocItemIsActive（B-1 树节点当前章命中）", () => {
  const tree: TocItem[] = [
    {
      label: "第一卷",
      href: "OEBPS/vol1.xhtml",
      subitems: [
        { label: "第一章", href: "OEBPS/text/ch1.xhtml#sec1" },
        { label: "第二章", href: "OEBPS/text/ch2.xhtml" },
      ],
    },
    { label: "第二卷", href: "OEBPS/vol2.xhtml", subitems: [{ label: "插图片", href: "OEBPS/ill.xhtml" }] },
  ];

  test("自节点与子孙节点都命中（剥 hash + 末段兜底同平铺口径）", () => {
    expect(tocItemIsActive(tree[0], "OEBPS/vol1.xhtml")).toBe(true); // 卷自身
    expect(tocItemIsActive(tree[0], "OEBPS/text/ch1.xhtml")).toBe(true); // 子章（toc 带 #anchor）
    expect(tocItemIsActive(tree[0].subitems![0], "OEBPS/text/ch1.xhtml")).toBe(true); // 叶子自命中
    expect(tocItemIsActive(tree[1], "ill.xhtml")).toBe(true); // 末段比对（relocated 相对路径）
  });

  test("未命中 / 空当前章 → false（叶子的子孙为空不误报）", () => {
    expect(tocItemIsActive(tree[0], "OEBPS/text/ch9.xhtml")).toBe(false);
    expect(tocItemIsActive(tree[1], "OEBPS/text/ch1.xhtml")).toBe(false);
    expect(tocItemIsActive(tree[0], "")).toBe(false);
  });
});
