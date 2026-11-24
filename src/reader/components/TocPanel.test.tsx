// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import TocPanel from "./TocPanel";
import type { TocItem } from "../epub/reader";

// 实测样本形态（母上攻略：toc.ncx depth=2，卷嵌套章）
const NESTED: TocItem[] = [
  {
    label: "第一卷",
    href: "text/vol1.xhtml",
    subitems: [
      { label: "第一章", href: "text/ch1.xhtml" },
      { label: "第二章", href: "text/ch2.xhtml" },
    ],
  },
  {
    label: "第二卷",
    href: "text/vol2.xhtml",
    subitems: [{ label: "第三章", href: "text/ch3.xhtml" }],
  },
];

const FLAT: TocItem[] = [
  { label: "第一章", href: "text/ch1.xhtml" },
  { label: "第二章", href: "text/ch2.xhtml" },
];

afterEach(cleanup);

describe("TocPanel（B-1 目录分层渲染）", () => {
  test("嵌套目录：卷=可折叠分组（默认全展），章=叶子归属其卷", () => {
    render(<TocPanel toc={NESTED} chapterHref="" onOpen={() => {}} />);
    const vol1 = screen.getByRole("button", { name: /第一卷/ });
    expect(vol1.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "第一章" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "第三章" })).toBeTruthy();
  });

  test("点击卷头收起该卷叶子，其它卷不受影响；再点展开", () => {
    render(<TocPanel toc={NESTED} chapterHref="" onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /第一卷/ }));
    expect(screen.queryByRole("button", { name: "第一章" })).toBeNull();
    expect(screen.getByRole("button", { name: /第一卷/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "第三章" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /第一卷/ }));
    expect(screen.getByRole("button", { name: "第一章" })).toBeTruthy();
  });

  test("当前章所在卷强制展开（用户折叠过也不生效），叶子高亮并滚动定位", () => {
    const spy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = spy;
    render(<TocPanel toc={NESTED} chapterHref="text/ch1.xhtml" onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /第一卷/ })); // 折叠 → 命中当前章仍强制展开
    expect(screen.getByRole("button", { name: /第一卷/ }).getAttribute("aria-expanded")).toBe("true");
    const leaf = screen.getByRole("button", { name: "第一章" });
    expect(leaf.getAttribute("data-active")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /第二卷/ })); // 未含当前章的卷照常可收起
    expect(screen.queryByRole("button", { name: "第三章" })).toBeNull();
    return waitFor(() => expect(spy).toHaveBeenCalledWith({ block: "center" }));
  });

  test("扁平目录（txt 转制 depth=1）退化为平铺：无分组头、无缩进噪音", () => {
    render(<TocPanel toc={FLAT} chapterHref="text/ch2.xhtml" onOpen={() => {}} />);
    expect(document.querySelector(".wr-toc-group")).toBeNull();
    expect(document.querySelectorAll(".wr-toc-leaf").length).toBe(2);
    expect(document.querySelectorAll(".wr-toc-item[data-active='true']").length).toBe(1);
  });

  test("点叶子回调 onOpen(href)；卷头点击不触发导航", () => {
    const onOpen = vi.fn();
    render(<TocPanel toc={NESTED} chapterHref="" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    expect(onOpen).toHaveBeenCalledWith("text/ch2.xhtml");
    fireEvent.click(screen.getByRole("button", { name: /第一卷/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
