import ePub from "epubjs";
import { readFile } from "@tauri-apps/plugin-fs";

import type { Theme } from "../settings/types";

export type TocItem = {
  label: string;
  href: string;
  subitems?: TocItem[];
};

export type RelocatedPayload = {
  cfi: string;
  percent: number | null;
};

export type ReaderController = {
  next: () => Promise<void>;
  prev: () => Promise<void>;
  display: (target?: string) => Promise<void>;
  setTheme: (theme: Theme) => void;
  setFontSizePercent: (percent: number) => void;
  addHighlight: (cfiRange: string) => void;
  removeHighlight: (cfiRange: string) => void;
  search: (query: string) => Promise<{ cfi: string; excerpt: string }[]>;
  destroy: () => void;
};

export async function createReader(opts: {
  container: HTMLElement;
  libraryPath: string;
  onRelocated?: (payload: RelocatedPayload) => void;
  onTocLoaded?: (toc: TocItem[]) => void;
  onSelected?: (payload: { cfiRange: string; text: string }) => void;
}): Promise<ReaderController> {
  const bytes = await readFile(opts.libraryPath);
  const book: any = ePub(bytes.buffer);
  await book.ready;

  try {
    await book.locations.generate(1024);
  } catch {
  }

  const rendition: any = book.renderTo(opts.container, {
    width: "100%",
    height: "100%",
    spread: "none",
    flow: "paginated",
  });

  rendition.themes.register("light", {
    body: { background: "#ffffff", color: "#111111" },
  });
  rendition.themes.register("dark", {
    body: { background: "#0f1115", color: "#e8eaf0" },
  });
  rendition.themes.register("sepia", {
    body: { background: "#f7f1e1", color: "#2b2620" },
  });
  rendition.themes.select("light");
  rendition.themes.fontSize("120%");
  rendition.themes.default({
    "::selection": { background: "rgba(255, 230, 0, 0.35)" },
    ".epubjs-hl": { fill: "rgba(255, 230, 0, 0.35)", "fill-opacity": "0.35", "mix-blend-mode": "multiply" },
  });

  rendition.on("relocated", (location: any) => {
    const cfi: string | undefined = location?.start?.cfi;
    if (!cfi) return;
    const percent =
      typeof book.locations?.percentageFromCfi === "function"
        ? (book.locations.percentageFromCfi(cfi) as number)
        : null;
    opts.onRelocated?.({ cfi, percent });
  });

  rendition.on("selected", (cfiRange: string, contents: any) => {
    void (async () => {
      let text = "";
      try {
        const range = await book.getRange(cfiRange);
        text = range?.toString?.() ?? "";
      } catch {
      }

      opts.onSelected?.({ cfiRange, text });
      try {
        contents?.window?.getSelection()?.removeAllRanges();
      } catch {
      }
    })();
  });

  const navigation = await book.loaded.navigation;
  const toc: TocItem[] =
    navigation?.toc?.map((i: any) => ({
      label: i.label,
      href: i.href,
      subitems: i.subitems?.map((s: any) => ({ label: s.label, href: s.href, subitems: [] })),
    })) ?? [];
  opts.onTocLoaded?.(toc);

  await rendition.display();

  return {
    next: async () => {
      await rendition.next();
    },
    prev: async () => {
      await rendition.prev();
    },
    display: async (target?: string) => {
      await rendition.display(target);
    },
    setTheme: (theme: Theme) => {
      rendition.themes.select(theme);
    },
    setFontSizePercent: (percent: number) => {
      rendition.themes.fontSize(`${percent}%`);
    },
    addHighlight: (cfiRange: string) => {
      rendition.annotations.highlight(cfiRange, {}, () => {});
    },
    removeHighlight: (cfiRange: string) => {
      try {
        rendition.annotations.remove(cfiRange);
      } catch {
      }
    },
    search: async (query: string) => {
      const q = query.trim();
      if (!q) return [];
      const items: any[] = Array.isArray(book.spine?.spineItems) ? book.spine.spineItems : [];
      const matches: { cfi: string; excerpt: string }[] = [];

      for (const section of items) {
        try {
          await section.load(book.load.bind(book));
          const found: any[] = section.find(q) || [];
          for (const m of found) {
            if (m?.cfi && m?.excerpt) {
              matches.push({ cfi: String(m.cfi), excerpt: String(m.excerpt) });
              if (matches.length >= 200) return matches;
            }
          }
        } catch {
        }
      }

      return matches;
    },
    destroy: () => {
      try {
        rendition.destroy();
      } catch {
      }
      try {
        book.destroy();
      } catch {
      }
    },
  };
}
