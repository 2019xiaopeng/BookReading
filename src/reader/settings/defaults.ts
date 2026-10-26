import type { ReaderSettings } from "./types";

export const defaultSettings: ReaderSettings = {
  theme: "light",
  fontSizePercent: 120,
  pageAnimation: "none",
  layoutMode: "auto",
  lineHeight: 1.9,
  readingMode: "paginated",
  reader_bg: { type: "preset" },
};

export const HIGHLIGHT_COLOR = "#ffe600";
