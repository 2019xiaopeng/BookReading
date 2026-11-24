// @vitest-environment jsdom
import { describe, expect, test } from "vitest";

import { installDesktopChrome, isBrowserResidueKey, isEditableTarget } from "./desktopChrome";

describe("isBrowserResidueKey（U-22 拦截键判定）", () => {
  test("F5 与 Ctrl+R/P/S/U 命中（Ctrl+Shift+R 也拦）", () => {
    expect(isBrowserResidueKey({ key: "F5" })).toBe(true);
    expect(isBrowserResidueKey({ key: "r", ctrlKey: true })).toBe(true);
    expect(isBrowserResidueKey({ key: "R", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isBrowserResidueKey({ key: "p", ctrlKey: true })).toBe(true);
    expect(isBrowserResidueKey({ key: "s", metaKey: true })).toBe(true);
    expect(isBrowserResidueKey({ key: "u", ctrlKey: true })).toBe(true);
  });

  test("编辑键与普通键放行", () => {
    expect(isBrowserResidueKey({ key: "r" })).toBe(false);
    expect(isBrowserResidueKey({ key: "c", ctrlKey: true })).toBe(false);
    expect(isBrowserResidueKey({ key: "a", ctrlKey: true })).toBe(false);
    expect(isBrowserResidueKey({ key: "F11" })).toBe(false);
    expect(isBrowserResidueKey({ key: "f", ctrlKey: true })).toBe(false);
  });
});

describe("installDesktopChrome（全局拦截安装，幂等）", () => {
  test("右键：普通元素拦下默认菜单，输入框放行；img 拖拽拦下；F5/Ctrl+S 拦下", () => {
    installDesktopChrome();
    installDesktopChrome(); // 幂等：重复安装不叠加监听

    const div = document.createElement("div");
    const input = document.createElement("input");
    const img = document.createElement("img");
    for (const el of [div, input, img]) document.body.appendChild(el);

    const ctx = (el: Element) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(ctx(div)).toBe(true);
    expect(ctx(input)).toBe(false);

    const drag = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    img.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);

    const key = (init: { key: string; ctrlKey?: boolean }) => {
      const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(key({ key: "F5" })).toBe(true);
    expect(key({ key: "s", ctrlKey: true })).toBe(true);
    expect(key({ key: "a", ctrlKey: true })).toBe(false);
  });
});

describe("isEditableTarget", () => {
  test("input/textarea/contenteditable 命中", () => {
    const input = document.createElement("input");
    const ta = document.createElement("textarea");
    const ed = document.createElement("div");
    ed.setAttribute("contenteditable", "true");
    const span = document.createElement("span");
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(ta)).toBe(true);
    expect(isEditableTarget(ed)).toBe(true);
    expect(isEditableTarget(span)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
