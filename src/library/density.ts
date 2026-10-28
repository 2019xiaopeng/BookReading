// 书架密度三档：grid 列模板由 LibraryPage 内联注入网格，封面/卡列/字号联动尺寸在 weread.css 的 --large/--xl 类
export type LibraryDensity = "standard" | "large" | "xl";

export const DENSITY_PRESETS: Record<LibraryDensity, { label: string; grid: string }> = {
  standard: { label: "标准", grid: "repeat(auto-fill, minmax(220px, 1fr))" },
  large: { label: "宽松", grid: "repeat(auto-fill, minmax(320px, 1fr))" },
  xl: { label: "特大", grid: "repeat(auto-fill, minmax(420px, 1fr))" },
};

export function normalizeLibraryDensity(v: unknown): LibraryDensity {
  // 旧四档里的 "compact"（已删）迁移到 standard，其余非法值同样回退
  return v === "large" || v === "xl" ? v : "standard";
}
