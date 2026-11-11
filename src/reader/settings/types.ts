import type { LayoutMode } from "./layoutMode";

export type Theme = "light" | "sepia" | "green" | "gray" | "dark" | "darkcontrast" | "ink" | "ink-dark";
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
  /** 翻页动画时长（ms，150-600）：epub fade/slide 与漫画滑动过渡共用 */
  turnSpeedMs: number;
  layoutMode: LayoutMode;
  lineHeight: number;
  fontFamily: FontFamily;
  /** #2 排版细项（v2.6.0）：字重三档 */
  fontWeight: number;
  /** 字间距 px（0-2 步 0.1；0=不注入，书内自带样式保持现状） */
  letterSpacing: number;
  /** 段距 em（0-1 步 0.05，恒注入 margin-bottom） */
  paragraphSpacing: number;
  /** 首行缩进 em（0-2 步 0.1；0=不注入，中文小说默认不缩进保持现状） */
  textIndent: number;
  /** 纸面四边内边距 px（12-48 步 2） */
  pageMargin: number;
  /** 两端对齐（false=不注入 text-align） */
  justify: boolean;
  readingMode: ReadingMode;
  reader_bg: ReaderBackground;
  reader_font: ReaderFont;
};
