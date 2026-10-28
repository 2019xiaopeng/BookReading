import type { ReaderSettings } from "./types";

export const defaultSettings: ReaderSettings = {
  fontSizePercent: 120,
  pageAnimation: "none",
  turnSpeedMs: 260,
  layoutMode: "auto",
  lineHeight: 1.9,
  fontFamily: "default",
  readingMode: "paginated",
  reader_bg: { type: "preset" },
  reader_font: { type: "preset" },
};

export const HIGHLIGHT_COLOR = "#ffe600";
