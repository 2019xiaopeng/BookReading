export type Theme = "light" | "dark" | "sepia";
export type PageAnimation = "none" | "slide" | "fade";
export type LayoutMode = "single" | "double" | "auto";

export type ReaderSettings = {
  theme: Theme;
  fontSizePercent: number;
  pageAnimation: PageAnimation;
  layoutMode: LayoutMode;
};
