import ePub from "epubjs";

import type { Theme } from "../settings/types";
import { readAppDataFile } from "../../tauri/appDataPaths";
import type { SpreadMode } from "../settings/layoutMode";

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
  setSpreadMode: (mode: SpreadMode) => void;
  addHighlight: (cfiRange: string) => void;
  removeHighlight: (cfiRange: string) => void;
  search: (query: string) => Promise<{ cfi: string; excerpt: string }[]>;
  destroy: () => void;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]);
}

export function applySpreadMode(rendition: any, mode: SpreadMode): void {
  try {
    const spreadFn = rendition?.spread;
    if (typeof spreadFn === "function") spreadFn.call(rendition, mode);
  } catch {
  }
}

export async function createReader(opts: {
  container: HTMLElement;
  libraryPath: string;
  spreadMode?: SpreadMode;
  onRelocated?: (payload: RelocatedPayload) => void;
  onTocLoaded?: (toc: TocItem[]) => void;
  onSelected?: (payload: { cfiRange: string; text: string }) => void;
  onError?: (message: string) => void;
}): Promise<ReaderController> {
  const bytes = await readAppDataFile(opts.libraryPath);
  const book: any = ePub(toArrayBuffer(bytes));
  let openFailed: string | null = null;
  if (typeof book?.on === "function") {
    book.on("openFailed", (e: any) => {
      openFailed = String(e ?? "openFailed");
      opts.onError?.(`EPUB 打开失败：${openFailed}`);
    });
  }

  await withTimeout(book.ready, 60_000).catch((e) => {
    const msg = openFailed ? `EPUB 打开失败：${openFailed}` : `EPUB 解析超时/失败：${String(e)}`;
    opts.onError?.(msg);
    throw new Error(msg);
  });

  void (async () => {
    try {
      await withTimeout(book.locations.generate(1024), 30_000);
    } catch {
    }
  })();

  const rendition: any = book.renderTo(opts.container, {
    width: "100%",
    height: "100%",
    spread: opts.spreadMode ?? "none",
    flow: "paginated",
  });

  rendition.on?.("displayerror", (e: any) => {
    opts.onError?.(`章节渲染失败：${String(e ?? "displayerror")}`);
  });

  const common: Record<string, any> = {
    "*, *::before, *::after": { "box-sizing": "border-box" },
    img: { "max-width": "100%", height: "auto" },
    svg: { "max-width": "100%" },
    table: { "max-width": "100%", width: "100%" },
    body: {
      margin: "0 auto",
      padding: "24px 20px",
      "line-height": "1.85",
      "word-break": "break-word",
      "overflow-wrap": "anywhere",
    },
  };

  rendition.themes.register("light", {
    ...common,
    body: { ...common.body, background: "#ffffff", color: "#111111" },
  });
  rendition.themes.register("dark", {
    ...common,
    body: { ...common.body, background: "#0f1115", color: "#e8eaf0" },
  });
  rendition.themes.register("sepia", {
    ...common,
    body: { ...common.body, background: "#f7f1e1", color: "#2b2620" },
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

  void (async () => {
    try {
      const navigation: any = await withTimeout<any>(book.loaded.navigation as Promise<any>, 30_000);
      const toc: TocItem[] =
        navigation?.toc?.map((i: any) => ({
          label: i.label,
          href: i.href,
          subitems: i.subitems?.map((s: any) => ({ label: s.label, href: s.href, subitems: [] })),
        })) ?? [];
      opts.onTocLoaded?.(toc);
    } catch (e) {
      opts.onError?.(`目录解析失败：${String(e)}`);
      opts.onTocLoaded?.([]);
    }
  })();

  await withTimeout(rendition.display(), 30_000).catch((e) => {
    const msg = `首次渲染超时/失败：${String(e)}`;
    opts.onError?.(msg);
    throw new Error(msg);
  });

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
    setSpreadMode: (mode: SpreadMode) => {
      applySpreadMode(rendition, mode);
      try {
        rendition.resize?.();
      } catch {
      }
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
        } finally {
          try {
            section.unload?.();
          } catch {
          }
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
