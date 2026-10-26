import { describe, expect, test } from "vitest";

import { tocLabelFor } from "./tocLabel";
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
