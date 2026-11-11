import { describe, expect, test } from "vitest";

// 壳纱浓度（F1-6）：壳层读 settings 键 bg_veil；数值钳位走统一 normalizer（阅读器侧同键共用），
// 壳层只补一条本项目约定——空串=未设置（library_status 同款），不能当 0 钳到 60
import { parseBgVeil } from "./AppShell";

describe("parseBgVeil（bg_veil 解析钳位）", () => {
  test("缺省与非法输入回 88", () => {
    expect(parseBgVeil(undefined)).toBe(88);
    expect(parseBgVeil("")).toBe(88);
    expect(parseBgVeil("abc")).toBe(88);
  });

  test("60–95 区间内原样生效（小数四舍五入）", () => {
    expect(parseBgVeil("88")).toBe(88);
    expect(parseBgVeil("60")).toBe(60);
    expect(parseBgVeil("95")).toBe(95);
    expect(parseBgVeil("72.4")).toBe(72);
  });

  test("越界钳到 60–95", () => {
    expect(parseBgVeil("10")).toBe(60);
    expect(parseBgVeil("100")).toBe(95);
    expect(parseBgVeil("-5")).toBe(60);
  });
});
