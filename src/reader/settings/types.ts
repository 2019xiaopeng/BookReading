export type Theme = "light" | "dark" | "sepia";
export type PageAnimation = "none" | "slide" | "fade";

export type ReaderSettings = {
  theme: Theme;
  fontSizePercent: number;
  pageAnimation: PageAnimation;
};

