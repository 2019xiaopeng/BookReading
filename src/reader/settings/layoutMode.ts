export type LayoutMode = "single" | "double" | "auto";

export type SpreadMode = "none" | "both";

export function normalizeLayoutMode(v: unknown): LayoutMode {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "single" || s === "double" || s === "auto") return s;
  return "auto";
}

export function resolveSpreadMode(mode: LayoutMode, containerWidth: number): SpreadMode {
  if (mode === "single") return "none";
  if (mode === "double") return "both";
  return containerWidth >= 980 ? "both" : "none";
}

