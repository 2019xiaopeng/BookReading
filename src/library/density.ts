// 书架密度四档：grid 列模板由 LibraryPage 内联注入网格，封面/卡列/字号联动尺寸在 weread.css 的 --compact/--large/--xl 类
export type LibraryDensity = "compact" | "standard" | "large" | "xl";

export const DENSITY_PRESETS: Record<LibraryDensity, { label: string; grid: string }> = {
  compact: { label: "紧凑", grid: "repeat(auto-fill, minmax(200px, 1fr))" },
  standard: { label: "标准", grid: "repeat(auto-fill, minmax(220px, 1fr))" },
  large: { label: "大图", grid: "repeat(auto-fill, minmax(320px, 1fr))" },
  xl: { label: "特大", grid: "repeat(auto-fill, minmax(420px, 1fr))" },
};

export function normalizeLibraryDensity(v: unknown): LibraryDensity {
  return v === "compact" || v === "large" || v === "xl" ? v : "standard";
}
