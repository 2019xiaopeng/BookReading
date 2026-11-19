import { describe, expect, test } from "vitest";

// C-1/C-2：settings 键 close_action 读取优先级纯函数（空串=未设置 → 每次询问，本项目 settings 约定）
import { resolveCloseAction } from "./closeAction";

describe("resolveCloseAction（close_action 解析）", () => {
  test("tray/exit 原样通过（容忍大小写与空白）", () => {
    expect(resolveCloseAction("tray")).toBe("tray");
    expect(resolveCloseAction("exit")).toBe("exit");
    expect(resolveCloseAction(" TRAY ")).toBe("tray");
    expect(resolveCloseAction("Exit")).toBe("exit");
  });

  test("未设置（undefined/空串）与垃圾值 → 每次询问", () => {
    expect(resolveCloseAction(undefined)).toBe("ask");
    expect(resolveCloseAction("")).toBe("ask");
    expect(resolveCloseAction("nope")).toBe("ask");
  });
});
