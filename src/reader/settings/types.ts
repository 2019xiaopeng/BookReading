import type { LayoutMode } from "./layoutMode";

export type Theme = "light" | "sepia" | "green" | "gray" | "dark" | "darkcontrast";
export type PageAnimation = "none" | "slide" | "fade";
export type ReadingMode = "paginated" | "scrolled";
export type FontFamily = "default" | "songti" | "heiti" | "kaiti" | "fangsong" | "custom";
export type ReaderBackground = { type: "preset" } | { type: "image"; path: string };
/** B11 自定义正文字体：单槽（appdata library/fonts/font.<ext>），preset=未安装 */
export type ReaderFont = { type: "preset" } | { type: "custom"; path: string };

export type ReaderSettings = {
  // theme 已提升为应用级（src/ui/theme.ts 单一事实源），不再随阅读设置对象流转
  fontSizePercent: number;
  pageAnimation: PageAnimation;
  layoutMode: LayoutMode;
  lineHeight: number;
  fontFamily: FontFamily;
  readingMode: ReadingMode;
  reader_bg: ReaderBackground;
  reader_font: ReaderFont;
};
