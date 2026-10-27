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

export type SelectionRect = { x: number; y: number; w: number; h: number };

/** 把 iframe 内选区矩形换算到宿主视口坐标（气泡锚定用）；必须在清除选区前同步调用。 */
function selectionHostRect(contents: any): SelectionRect | null {
  try {
    const win = contents?.window;
    const sel = win?.getSelection?.();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r || (r.width <= 0 && r.height <= 0)) return null;
    const frame = win.frameElement as HTMLElement | null | undefined;
    const frameRect = frame?.getBoundingClientRect?.();
    const iw = win.innerWidth;
    const ih = win.innerHeight;
    if (!frameRect || !iw || !ih) return null;
    const sx = frameRect.width / iw;
    const sy = frameRect.height / ih;
    return { x: frameRect.left + r.left * sx, y: frameRect.top + r.top * sy, w: r.width * sx, h: r.height * sy };
  } catch {
    return null;
  }
}

/** 章节导航兜底：从 CFI 的 spine 段（/6/<2N>!）解析 spine 索引。 */
export function spineIndexFromCfi(cfi: unknown): number | null {
  const m = /\/6\/(\d+)!/.exec(String(cfi ?? ""));
  if (!m) return null;
  const idx = Math.floor(Number(m[1]) / 2) - 1;
  return Number.isFinite(idx) && idx >= 0 ? idx : null;
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
  chapterNav: (delta: number) => void;
  progressCfi: (percentage: number) => string | null;
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

/**
 * spread 切换只改列度量不重绘当前内容，会留下按旧度量裁切的残影；
 * 统一路径：spread(mode) → clear() → display(target)。无 target（尚未渲染）时退回 resize。
 */
export function applySpreadMode(rendition: any, mode: SpreadMode, target?: string): void {
  try {
    const spreadFn = rendition?.spread;
    if (typeof spreadFn === "function") spreadFn.call(rendition, mode);
  } catch (e) {
    logOnce("reader.spread", `reader: spread failed ${String(e)}`);
  }
  if (!target) {
    try {
      rendition?.resize?.();
    } catch (e) {
      logOnce("reader.resize", `reader: resize failed ${String(e)}`);
    }
    return;
  }
  try {
    rendition.clear?.();
    void rendition.display?.(target);
  } catch (e) {
    logOnce("reader.spread.redisplay", `reader: spread redisplay failed ${String(e)}`);
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

// iframe 内容无法继承宿主 CSS 变量，此处色值与 tokens.css [data-theme] 同步（dark 纸面=--panel-solid、darkcontrast 纸面=--wr-paper）
const THEME_STYLES: Record<Theme, { paper: string | null; fg: string }> = {
  light: { paper: null, fg: "#16181a" },
  sepia: { paper: null, fg: "rgba(38, 29, 18, 0.9)" },
  green: { paper: null, fg: "#223325" },
  gray: { paper: null, fg: "#2b2b28" },
  dark: { paper: "#11151b", fg: "rgba(255, 255, 255, 0.92)" },
  darkcontrast: { paper: "#050505", fg: "#f5f5f5" },
};

export async function createReader(opts: {
  container: HTMLElement;
  libraryPath: string;
  spreadMode?: SpreadMode;
  readingMode?: ReadingMode;
  lineHeight?: number;
  onRelocated?: (payload: RelocatedPayload) => void;
  onTocLoaded?: (toc: TocItem[]) => void;
  onSelected?: (payload: { cfiRange: string; text: string; rect: SelectionRect | null }) => void;
  onLocationsReady?: () => void;
  onContentsPress?: () => void;
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

  let lastLocation: any = null;

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
  let currentLineHeight = opts.lineHeight ?? 1.9;
  const registerThemes = (lineHeight: number) => {
    const common: Record<string, any> = {
      "*, *::before, *::after": { "box-sizing": "border-box" },
      img: { "max-width": "100%", height: "auto" },
      svg: { "max-width": "100%" },
      table: { "max-width": "100%", width: "100%" },
    };
    for (const t of Object.keys(THEME_STYLES) as Theme[]) {
      const s = THEME_STYLES[t];
      const opaque = s.paper !== null;
      // 规则按主题类作用域（themes.select 靠 body class 切换），避免多主题样式表共存时后者压死前者
      rendition.themes.register(t, {
        ...common,
        [`body.${t}`]: {
          margin: "0 auto",
          padding: "24px 20px",
          "line-height": String(lineHeight),
          "word-break": "break-word",
          "overflow-wrap": "anywhere",
          // epub 自带浅底会透出暗色壳：dark/darkcontrast 注入不透明纸面（!important 压过 epub 自身规则），浅色主题保持 transparent
          background: opaque ? `${s.paper} !important` : "transparent",
          color: opaque ? `${s.fg} !important` : s.fg,
        },
        // 段落常自带 line-height（比 body 继承更具体），须直接命中 p 且加 !important
        [`body.${t} p, body.${t}`]: { "line-height": `${lineHeight} !important` },
      });
    }
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
    lastLocation = location;
    const percent =
      typeof book.locations?.percentageFromCfi === "function"
        ? (book.locations.percentageFromCfi(cfi) as number)
        : null;
    const href = String(location?.start?.href ?? "").split("#")[0];
    opts.onRelocated?.({ cfi, percent, href });
  };
  rendition.on("relocated", onRelocated);

  // 超时不置终态：1024 超时后换新 Locations 实例降级 4096 后台重试一次（共享队列复用旧实例会重复追加）
  void (async () => {
    for (const [attempt, interval] of [1024, 4096].entries()) {
      try {
        if (attempt > 0) {
          const Ctor = (book.locations as any)?.constructor;
          if (typeof Ctor !== "function") throw new Error("no Locations ctor");
          const old = book.locations as any;
          book.locations = new Ctor(book.spine, book.load.bind(book));
          // destroy() 会 q.stop() 终止旧 1024 间隔的 generate 队列，否则两轮全文解析并发白耗主线程
          try {
            old?.destroy?.();
          } catch {
            // best effort：停不掉也只是旧队列继续跑完
          }
        }
        await withTimeout(book.locations.generate(interval), 30_000);
      } catch (e) {
        logOnce(`reader.locations.${interval}`, `reader: locations.generate(${interval}) failed ${String(e)}`);
        continue;
      }
      opts.onLocationsReady?.();
      if (lastLocation?.start?.cfi) onRelocated(lastLocation);
      return;
    }
  })();

  const onSelected = (cfiRange: string, contents: any) => {
    const rect = selectionHostRect(contents);
    void (async () => {
      let text = "";
      try {
        const range = await book.getRange(cfiRange);
        text = range?.toString?.() ?? "";
      } catch (e) {
        logOnce("reader.getRange", `reader: getRange failed ${String(e)}`);
      }

      opts.onSelected?.({ cfiRange, text, rect });
      try {
        contents?.window?.getSelection()?.removeAllRanges();
      } catch {
      }
    })();
  };
  rendition.on("selected", onSelected);

  // iframe 内按下即收起选区气泡（DOM_EVENTS 中继；先于新选区触发，时序安全）
  const onContentsPress = () => opts.onContentsPress?.();
  rendition.on?.("mousedown", onContentsPress);
  rendition.on?.("touchstart", onContentsPress);

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
      if (theme === currentTheme) return;
      currentTheme = theme;
      rendition.themes.select(theme);
    },
    setFontSizePercent: (percent: number) => {
      rendition.themes.fontSize(`${percent}%`);
    },
    setLineHeight: (lineHeight: number) => {
      if (lineHeight === currentLineHeight) return;
      currentLineHeight = lineHeight;
      registerThemes(lineHeight);
    },
    setSpreadMode: (mode: SpreadMode) => {
      if (mode === lastSpreadMode) return;
      lastSpreadMode = mode;
      const cfi = rendition.currentLocation?.()?.start?.cfi;
      applySpreadMode(rendition, mode, typeof cfi === "string" ? cfi : undefined);
    },
    setReadingMode: (mode: ReadingMode) => {
      if (mode === currentFlow) return;
      currentFlow = mode;
      try {
        const cfi = rendition.currentLocation?.()?.start?.cfi;
        // epubjs 0.3.93 rendition.flow() 为运行时切换 API：内部自动 clear + display(当前 CFI)
        rendition.flow(mode);
        applySpreadMode(rendition, mode === "scrolled" ? "none" : lastSpreadMode, typeof cfi === "string" ? cfi : undefined);
        if (mode === "paginated") rendition.resize?.();
      } catch (e) {
        logOnce("reader.flow", `reader: flow switch failed ${String(e)}`);
      }
    },
    chapterNav: (delta: number) => {
      try {
        if (!delta) return;
        const loc = rendition.currentLocation?.();
        let idx: number | null = loc?.start?.index;
        if (typeof idx !== "number" || !Number.isFinite(idx) || idx < 0) idx = spineIndexFromCfi(loc?.start?.cfi);
        if (idx === null) return;
        const count: number = book.spine?.spineItems?.length ?? 0;
        const next = Math.min(count - 1, Math.max(0, idx + delta));
        if (next === idx) return;
        const href = book.spine.get?.(next)?.href;
        if (typeof href === "string" && href) void rendition.display(href);
      } catch (e) {
        logOnce("reader.chapterNav", `reader: chapterNav failed ${String(e)}`);
      }
    },
    progressCfi: (percentage: number) => {
      try {
        const p = Math.min(0.999, Math.max(0, percentage));
        const cfi = book.locations?.cfiFromPercentage?.(p);
        return typeof cfi === "string" && cfi ? cfi : null;
      } catch {
        return null;
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
        rendition.off?.("mousedown", onContentsPress);
        rendition.off?.("touchstart", onContentsPress);
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
