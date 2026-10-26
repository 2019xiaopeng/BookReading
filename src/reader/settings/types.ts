import type { LayoutMode } from "./layoutMode";

export type Theme = "light" | "sepia" | "green" | "gray" | "dark" | "darkcontrast";
export type PageAnimation = "none" | "slide" | "fade";
export type ReadingMode = "paginated" | "scrolled";
export type ReaderBackground = { type: "preset" } | { type: "image"; path: string };

export type ReaderSettings = {
  theme: Theme;
  fontSizePercent: number;
  pageAnimation: PageAnimation;
  layoutMode: LayoutMode;
  lineHeight: number;
  readingMode: ReadingMode;
  reader_bg: ReaderBackground;
};
