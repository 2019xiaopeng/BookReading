import ePub from "epubjs";

import type { ReadingMode, Theme } from "../settings/types";
import { readAppDataFile } from "../../tauri/appDataPaths";
import type { SpreadMode } from "../settings/layoutMode";
import { logFrontend } from "../../tauri/frontendLog";

const loggedKeys = new Set<string>();

function logOnce(key: string, line: string): void {
  if (loggedKeys.has(key)) return;
  loggedKeys.add(key);
  logFrontend(line);
}

export type TocItem = {
  label: string;
  href: string;
  subitems?: TocItem[];
};

export type SearchResult = {
  cfi: string;
  excerpt: string;
  sectionHref: string;
  percent?: number;
};

export type RelocatedPayload = {
  cfi: string;
  percent: number | null;
  href: string;
};

export type ReaderController = {
  next: () => Promise<void>;
  prev: () => Promise<void>;
  display: (target?: string) => Promise<void>;
  setTheme: (theme: Theme) => void;
  setFontSizePercent: (percent: number) => void;
  setLineHeight: (lineHeight: number) => void;
  setSpreadMode: (mode: SpreadMode) => void;
  setReadingMode: (mode: ReadingMode) => void;
  addHighlight: (cfiRange: string) => void;
  removeHighlight: (cfiRange: string) => void;
  search: (query: string) => Promise<SearchResult[]>;
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
  } catch (e) {
    logOnce("reader.spread", `reader: spread failed ${String(e)}`);
  }
}

function percentFromCfi(book: any, cfi: string): number | undefined {
  try {
    const locs = book?.locations;
    if (typeof locs?.length === "function" && locs.length() > 0 && typeof locs.percentageFromCfi === "function") {
      const p = locs.percentageFromCfi(cfi);
      if (typeof p === "number" && Number.isFinite(p)) return p;
    }
  } catch {
  }
  return undefined;
}

export async function createReader(opts: {
  container: HTMLElement;
  libraryPath: string;
  spreadMode?: SpreadMode;
  readingMode?: ReadingMode;
  lineHeight?: number;
  onRelocated?: (payload: RelocatedPayload) => void;
  onTocLoaded?: (toc: TocItem[]) => void;
  onSelected?: (payload: { cfiRange: string; text: string }) => void;
  onError?: (message: string) => void;
}): Promise<ReaderController> {
  const bytes = await readAppDataFile(opts.libraryPath);
  const book: any = ePub(toArrayBuffer(bytes));
  let openFailed: string | null = null;
  const onOpenFailed = (e: any) => {
    openFailed = String(e ?? "openFailed");
    opts.onError?.(`EPUB 打开失败：${openFailed}`);
  };
  if (typeof book?.on === "function") {
    book.on("openFailed", onOpenFailed);
  }

  await withTimeout(book.ready, 60_000).catch((e) => {
    const msg = openFailed ? `EPUB 打开失败：${openFailed}` : `EPUB 解析超时/失败：${String(e)}`;
    opts.onError?.(msg);
    book.destroy?.();
    throw new Error(msg);
  });

  void (async () => {
    try {
      await withTimeout(book.locations.generate(1024), 30_000);
    } catch (e) {
      logOnce("reader.locations", `reader: locations.generate failed ${String(e)}`);
    }
  })();

  const flow: ReadingMode = opts.readingMode === "scrolled" ? "scrolled" : "paginated";
  let currentFlow: ReadingMode = flow;
  let lastSpreadMode: SpreadMode = opts.spreadMode ?? "none";
  const rendition: any = book.renderTo(opts.container, {
    width: "100%",
    height: "100%",
    spread: flow === "scrolled" ? "none" : opts.spreadMode ?? "none",
    flow,
  });

  const onDisplayError = (e: any) => {
    opts.onError?.(`章节渲染失败：${String(e ?? "displayerror")}`);
  };
  rendition.on?.("displayerror", onDisplayError);

  let currentTheme: Theme = "light";
  const registerThemes = (lineHeight: number) => {
    const common: Record<string, any> = {
      "*, *::before, *::after": { "box-sizing": "border-box" },
      img: { "max-width": "100%", height: "auto" },
      svg: { "max-width": "100%" },
      table: { "max-width": "100%", width: "100%" },
      body: {
        margin: "0 auto",
        padding: "24px 20px",
        "line-height": String(lineHeight),
        "word-break": "break-word",
        "overflow-wrap": "anywhere",
      },
    };

    rendition.themes.register("light", {
      ...common,
      body: { ...common.body, background: "transparent", color: "#16181a" },
    });
    rendition.themes.register("dark", {
      ...common,
      body: { ...common.body, background: "transparent", color: "rgba(255, 255, 255, 0.92)" },
    });
    rendition.themes.register("sepia", {
      ...common,
      body: { ...common.body, background: "transparent", color: "rgba(38, 29, 18, 0.9)" },
    });
    // 新增三主题正文色与 tokens.css [data-theme] 值同步（批次3 spec §2.2）
    rendition.themes.register("green", {
      ...common,
      body: { ...common.body, background: "transparent", color: "#223325" },
    });
    rendition.themes.register("gray", {
      ...common,
      body: { ...common.body, background: "transparent", color: "#2b2b28" },
    });
    rendition.themes.register("darkcontrast", {
      ...common,
      body: { ...common.body, background: "transparent", color: "#f5f5f5" },
    });
    rendition.themes.select(currentTheme);
  };
  registerThemes(opts.lineHeight ?? 1.9);
  rendition.themes.fontSize("120%");
  rendition.themes.default({
    "::selection": { background: "rgba(255, 230, 0, 0.35)" },
    ".epubjs-hl": { fill: "rgba(255, 230, 0, 0.35)", "fill-opacity": "0.35", "mix-blend-mode": "multiply" },
  });

  const onRelocated = (location: any) => {
    const cfi: string | undefined = location?.start?.cfi;
    if (!cfi) return;
    const percent =
      typeof book.locations?.percentageFromCfi === "function"
        ? (book.locations.percentageFromCfi(cfi) as number)
        : null;
    const href = String(location?.start?.href ?? "").split("#")[0];
    opts.onRelocated?.({ cfi, percent, href });
  };
  rendition.on("relocated", onRelocated);

  const onSelected = (cfiRange: string, contents: any) => {
    void (async () => {
      let text = "";
      try {
        const range = await book.getRange(cfiRange);
        text = range?.toString?.() ?? "";
      } catch (e) {
        logOnce("reader.getRange", `reader: getRange failed ${String(e)}`);
      }

      opts.onSelected?.({ cfiRange, text });
      try {
        contents?.window?.getSelection()?.removeAllRanges();
      } catch {
      }
    })();
  };
  rendition.on("selected", onSelected);

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
    rendition?.destroy?.();
    book.destroy?.();
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
      try {
        await withTimeout(rendition.display(target), 30_000);
      } catch (e) {
        logOnce("reader.display", `reader: display failed ${String(e)}`);
      }
    },
    setTheme: (theme: Theme) => {
      currentTheme = theme;
      rendition.themes.select(theme);
    },
    setFontSizePercent: (percent: number) => {
      rendition.themes.fontSize(`${percent}%`);
    },
    setLineHeight: (lineHeight: number) => {
      registerThemes(lineHeight);
    },
    setSpreadMode: (mode: SpreadMode) => {
      lastSpreadMode = mode;
      applySpreadMode(rendition, mode);
      try {
        rendition.resize?.();
      } catch (e) {
        logOnce("reader.resize", `reader: resize failed ${String(e)}`);
      }
    },
    setReadingMode: (mode: ReadingMode) => {
      if (mode === currentFlow) return;
      currentFlow = mode;
      try {
        // epubjs 0.3.93 rendition.flow() 为运行时切换 API：内部自动 clear + display(当前 CFI)
        rendition.flow(mode);
        applySpreadMode(rendition, mode === "scrolled" ? "none" : lastSpreadMode);
        if (mode === "paginated") rendition.resize?.();
      } catch (e) {
        logOnce("reader.flow", `reader: flow switch failed ${String(e)}`);
      }
    },
    addHighlight: (cfiRange: string) => {
      try {
        rendition.annotations.highlight(cfiRange, {}, () => {});
      } catch (e) {
        logOnce("reader.addHighlight", `reader: addHighlight failed ${String(e)}`);
      }
    },
    removeHighlight: (cfiRange: string) => {
      try {
        rendition.annotations.remove(cfiRange);
      } catch (e) {
        logOnce("reader.removeHighlight", `reader: removeHighlight failed ${String(e)}`);
      }
    },
    search: async (query: string) => {
      const q = query.trim();
      if (!q) return [];
      const items: any[] = Array.isArray(book.spine?.spineItems) ? book.spine.spineItems : [];
      const matches: SearchResult[] = [];
      let errors = 0;
      let lastError: unknown = null;

      for (const section of items) {
        try {
          const sectionHref = String(section.href ?? "").split("#")[0];
          await section.load(book.load.bind(book));
          const found: any[] = section.find(q) || [];
          for (const m of found) {
            if (m?.cfi && m?.excerpt) {
              matches.push({ cfi: String(m.cfi), excerpt: String(m.excerpt), sectionHref, percent: percentFromCfi(book, String(m.cfi)) });
              if (matches.length >= 200) return matches;
            }
          }
        } catch (e) {
          errors += 1;
          lastError = e;
        } finally {
          try {
            section.unload?.();
          } catch {
          }
        }
      }

      if (errors && !matches.length) {
        logOnce("reader.search", `reader: search failed errors=${errors} last=${String(lastError)}`);
      }
      return matches;
    },
    destroy: () => {
      try {
        rendition.off?.("displayerror", onDisplayError);
        rendition.off?.("relocated", onRelocated);
        rendition.off?.("selected", onSelected);
        book.off?.("openFailed", onOpenFailed);
      } catch (e) {
        logOnce("reader.off", `reader: off failed ${String(e)}`);
      }
      try {
        rendition.destroy();
      } catch (e) {
        logOnce("reader.rendition.destroy", `reader: rendition.destroy failed ${String(e)}`);
      }
      try {
        book.destroy();
      } catch (e) {
        logOnce("reader.book.destroy", `reader: book.destroy failed ${String(e)}`);
      }
    },
  };
}
