// 书架密度三档：grid 列模板由 LibraryPage 内联注入网格，封面/卡列联动尺寸在 weread.css 的 --compact/--large 类
export type LibraryDensity = "compact" | "standard" | "large";

export const DENSITY_PRESETS: Record<LibraryDensity, { label: string; grid: string }> = {
  compact: { label: "紧凑", grid: "repeat(auto-fill, minmax(200px, 1fr))" },
  standard: { label: "标准", grid: "repeat(auto-fill, minmax(220px, 1fr))" },
  large: { label: "大图", grid: "repeat(auto-fill, minmax(320px, 1fr))" },
};

export function normalizeLibraryDensity(v: unknown): LibraryDensity {
  return v === "compact" || v === "large" ? v : "standard";
}
