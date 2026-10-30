import ePub, { EpubCFI } from "epubjs";

import type { FontFamily, ReadingMode, Theme } from "../settings/types";
import { readAppDataFile } from "../../tauri/appDataPaths";
import type { SpreadMode } from "../settings/layoutMode";
import { logFrontend } from "../../tauri/frontendLog";
import { loadBookLocations, saveBookLocations } from "../../tauri/invoke";

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

/** 章内视觉页码（relocated 的 displayed；0.3.93 paginated 才有分页语义，缺失容错 null） */
export type PageEdge = { page: number; total: number };

export type RelocatedPayload = {
  cfi: string;
  percent: number | null;
  href: string;
  /** location.start.index（spine 序号） */
  sectionIndex: number;
  /** location.end.index；页码徽标仅在跨章/跨页时补右角 */
  endSectionIndex: number;
  pageStart: PageEdge | null;
  pageEnd: PageEdge | null;
  /** B12 全局"位置页"（估算，1024 字/页粒度）：locations 就绪后 index=当前页-1、total=总页数；未就绪 null */
  locPage: { index: number; total: number } | null;
};

function pageEdge(edge: any): PageEdge | null {
  const d = edge?.displayed;
  return typeof d?.page === "number" && typeof d?.total === "number" && d.total > 0 ? { page: d.page, total: d.total } : null;
}

/** locations 持久化键：字体字号档变了 locations 才重算（ReadPage 用它调 save/loadBookLocations） */
export function locationsCacheKey(fontFamily: FontFamily, fontSizePercent: number): string {
  return `${fontFamily}|${fontSizePercent}`;
}

/** relocated 载荷值等价（页码/locPage 两层 nullable 字段逐值比）：滚动/resize 高频触发时值未变不下发新引用 */
export function sameRelocatedPayload(a: RelocatedPayload | null, b: RelocatedPayload | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.cfi === b.cfi &&
    a.percent === b.percent &&
    a.href === b.href &&
    a.sectionIndex === b.sectionIndex &&
    a.endSectionIndex === b.endSectionIndex &&
    a.pageStart?.page === b.pageStart?.page &&
    a.pageStart?.total === b.pageStart?.total &&
    a.pageEnd?.page === b.pageEnd?.page &&
    a.pageEnd?.total === b.pageEnd?.total &&
    a.locPage?.index === b.locPage?.index &&
    a.locPage?.total === b.locPage?.total
  );
}

/** range CFI 边缘的位置键：[spinePos, ...path.steps.index, ...edge.steps.index, terminal.offset]，字典序可比 */
function cfiKey(cfi: any, edge: "start" | "end"): number[] | null {
  const path = cfi?.path;
  if (!Array.isArray(path?.steps)) return null;
  // 非 range 退化为 path 本身（terminal 在 path 上，steps 不得重复拼接）
  const e = cfi?.range ? cfi[edge] : path;
  if (!e) return null;
  const idx = (s: any) => (typeof s?.index === "number" ? s.index : 0);
  const steps = e === path ? path.steps : [...path.steps, ...(Array.isArray(e.steps) ? e.steps : [])];
  return [
    typeof cfi.spinePos === "number" ? cfi.spinePos : -1,
    ...steps.map(idx),
    typeof e.terminal?.offset === "number" ? e.terminal.offset : -1,
  ];
}

function keyCmp(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** 选区与现有高亮的 range CFI 是否相交（闭区间；解析失败按不相交处理）。 */
export function cfiRangesOverlap(a: string, b: string): boolean {
  try {
    const A: any = new EpubCFI(a);
    const B: any = new EpubCFI(b);
    const as = cfiKey(A, "start");
    const ae = cfiKey(A, "end");
    const bs = cfiKey(B, "start");
    const be = cfiKey(B, "end");
    if (!as || !ae || !bs || !be) return false;
    return keyCmp(as, be) <= 0 && keyCmp(bs, ae) <= 0;
  } catch {
    return false;
  }
}

export type ReaderController = {
  next: () => Promise<void>;
  prev: () => Promise<void>;
  display: (target?: string) => Promise<void>;
  chapterNav: (delta: number) => void;
  /** B13 滚动模式翻屏（PageDown/PageUp）：章末/章首即时章导航，章中滚动一屏；返回触发的章方向或 null */
  scrollStep: (dir: 1 | -1) => 1 | -1 | null;
  progressCfi: (percentage: number) => string | null;
  setTheme: (theme: Theme) => void;
  setFontSizePercent: (percent: number) => void;
  setLineHeight: (lineHeight: number) => void;
  setFontFamily: (fontFamily: FontFamily) => void;
  setSpreadMode: (mode: SpreadMode) => void;
  setReadingMode: (mode: ReadingMode) => void;
  addHighlight: (cfiRange: string) => void;
  removeHighlight: (cfiRange: string) => void;
  /** 强制重排（容器尺寸变化/字号行距变化后刷新章内页码）；clear+display 当前 CFI */
  resize: () => void;
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
/** 滚动模式章末/章首判定（B13 章续读）：距端 <40px 视为到边；短章整章可见时按滚动方向续读。 */
export function scrollEdgeDirection(scrollTop: number, clientHeight: number, scrollHeight: number, lastDelta: number): 1 | -1 | null {
  if (scrollHeight <= clientHeight) return lastDelta < 0 ? -1 : 1;
  if (scrollHeight - scrollTop - clientHeight < 40) return 1;
  if (scrollTop < 40) return -1;
  return null;
}

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

// iframe 内容无法继承宿主 CSS 变量，此处色值与 tokens.css / weread.css [data-theme] 同步
// （dark 纸面=--panel-solid、darkcontrast 纸面=--wr-paper；inkRgb=--wr-ink-rgb，sepia/green/gray 未覆盖沿用默认；
//  ink/ink-dark=M2 纸墨双主题：纸面非纯白/纯黑，注入不透明纸面防止 epub 自带浅底透出）
const THEME_STYLES: Record<Theme, { paper: string | null; fg: string; inkRgb: string }> = {
  light: { paper: null, fg: "#16181a", inkRgb: "22, 24, 26" },
  sepia: { paper: null, fg: "rgba(38, 29, 18, 0.9)", inkRgb: "22, 24, 26" },
  green: { paper: null, fg: "#223325", inkRgb: "22, 24, 26" },
  gray: { paper: null, fg: "#2b2b28", inkRgb: "22, 24, 26" },
  dark: { paper: "#11151b", fg: "rgba(255, 255, 255, 0.92)", inkRgb: "255, 255, 255" },
  darkcontrast: { paper: "#050505", fg: "#f5f5f5", inkRgb: "255, 255, 255" },
  ink: { paper: "#FAFAF7", fg: "#242321", inkRgb: "36, 35, 33" },
  "ink-dark": { paper: "#191816", fg: "#EDECE7", inkRgb: "237, 236, 231" },
};

// B11 正文字体：default=悦读栈（思源宋优先、回退等线/宋体，未装字体自动落下一步），custom=文件安装的 wr-custom
const FONT_STACKS: Record<FontFamily, string> = {
  default: `"Source Han Serif SC", "Noto Serif CJK SC", "DengXian", "等线", serif`,
  custom: `"wr-custom", serif`,
  songti: `"SimSun", "NSimSun", "Songti SC", "STSong", serif`,
  heiti: `"Microsoft YaHei", "PingFang SC", "SimHei", sans-serif`,
  kaiti: `"KaiTi", "楷体", "STKaiti", serif`,
  fangsong: `"FangSong", "仿宋", "STFangsong", serif`,
};

export async function createReader(opts: {
  container: HTMLElement;
  libraryPath: string;
  spreadMode?: SpreadMode;
  readingMode?: ReadingMode;
  lineHeight?: number;
  fontFamily?: FontFamily;
  /** 首显直达目标（CFI）；缺省第 1 章。恢复点在首渲前注入，消除"先渲第 1 章再 display 恢复 CFI"的双渲染 */
  initialTarget?: string;
  /** locations 持久化的书 id（缺省不持久化，仅会话内生成） */
  bookId?: string;
  /** locations 持久化键（字体|字号，惰性取值——生成时机晚于设置回填） */
  locationsKey?: () => string;
  /** 自定义正文 @font-face css（注入 iframe；宿主注入对 iframe 无效）。null=无自定义字体 */
  fontFaceCss?: () => string | null;
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

  const requestedFlow: ReadingMode = opts.readingMode === "scrolled" ? "scrolled" : "paginated";
  // B13：冷启动统一按分页渲染（App 内被反复验证的成熟路径），scrolled 在首显成功后立即运行时切换。
  // 原先 scrolled 直建（重进书场景：设置先于书就绪，restore 走 createReader 冷路径）与运行时切换
  // 产生不同的 manager/view 初始化时序，重进后滚动失效（B13 2a 卡死）；收敛为单一路径后两条路径等价。
  let currentFlow: ReadingMode = "paginated";
  let lastSpreadMode: SpreadMode = opts.spreadMode ?? "none";
  const rendition: any = book.renderTo(opts.container, {
    width: "100%",
    height: "100%",
    spread: opts.spreadMode ?? "none",
    flow: "paginated",
  });

  const onDisplayError = (e: any) => {
    opts.onError?.(`章节渲染失败：${String(e ?? "displayerror")}`);
  };
  rendition.on?.("displayerror", onDisplayError);

  let currentTheme: Theme = "light";
  let currentLineHeight = opts.lineHeight ?? 1.9;
  let currentFontSizePercent = 120;
  let currentFontFamily: FontFamily = opts.fontFamily ?? "default";
  const registerThemes = (lineHeight: number, fontFamily: FontFamily) => {
    const common: Record<string, any> = {
      "*, *::before, *::after": { "box-sizing": "border-box" },
      img: { "max-width": "100%", height: "auto" },
      svg: { "max-width": "100%" },
      table: { "max-width": "100%", width: "100%" },
    };
    for (const t of Object.keys(THEME_STYLES) as Theme[]) {
      const s = THEME_STYLES[t];
      const opaque = s.paper !== null;
      // 滚动模式的滚动条在 iframe 内，宿主全局 CSS 管不到：随主题注入镜像 ink 色的滚动条样式。
      // 8px 轨道 + 2px 透明边框 + background-clip 得 4px 圆角细 thumb；
      // :has 份用于命中 html 根（iframe 视口滚动条挂在根上，body 类选择器够不着；WebView2 Chromium105+ 支持）
      const scrollbar = (pseudo: string) =>
        [
          `body.${t} ${pseudo}`,
          `body.${t}${pseudo}`,
          `html:has(body.${t}) ${pseudo}`,
          `html:has(body.${t})${pseudo}`,
        ].join(", ");
      // 规则按主题类作用域（themes.select 靠 body class 切换），避免多主题样式表共存时后者压死前者
      rendition.themes.register(t, {
        ...common,
        [scrollbar("::-webkit-scrollbar")]: { width: "8px", height: "8px" },
        [scrollbar("::-webkit-scrollbar-track")]: { background: "transparent" },
        [scrollbar("::-webkit-scrollbar-thumb")]: {
          background: `rgba(${s.inkRgb}, 0.28)`,
          "border-radius": "999px",
          border: "2px solid transparent",
          "background-clip": "padding-box",
        },
        [scrollbar("::-webkit-scrollbar-thumb:hover")]: { background: `rgba(${s.inkRgb}, 0.45)` },
        [`body.${t}`]: {
          margin: "0 auto",
          padding: "24px 20px",
          "line-height": String(lineHeight),
          "font-family": `${FONT_STACKS[fontFamily]} !important`,
          "word-break": "break-word",
          "overflow-wrap": "anywhere",
          // epub 自带浅底会透出暗色壳：dark/darkcontrast 注入不透明纸面（!important 压过 epub 自身规则），浅色主题保持 transparent
          background: opaque ? `${s.paper} !important` : "transparent",
          color: opaque ? `${s.fg} !important` : s.fg,
        },
        // 段落常自带 line-height / font-family（比 body 继承更具体——继承必输给直命中 p 的声明），
        // 须直接命中 p 且加 !important（B12 字体不生效根因即书内 p/类选择器压过了 body 继承）
        [`body.${t} p, body.${t}`]: {
          "line-height": `${lineHeight} !important`,
          "font-family": `${FONT_STACKS[fontFamily]} !important`,
        },
      });
    }
    rendition.themes.select(currentTheme);
  };
  registerThemes(opts.lineHeight ?? 1.9, currentFontFamily);
  rendition.themes.fontSize("120%");
  rendition.themes.default({
    "::selection": { background: "rgba(255, 230, 0, 0.35)" },
    ".epubjs-hl": { fill: "rgba(255, 230, 0, 0.35)", "fill-opacity": "0.35", "mix-blend-mode": "multiply" },
  });

  // 自定义正文 @font-face 注入 iframe（正文在 epubjs iframe 里，宿主 document 的 @font-face 完全无效）。
  // spine content hook 在每个 section 内容创建时触发（含 clear 后重 display），addStylesheetCss 按 key 幂等覆盖。
  // 字体就绪前排版度量错误：epubjs 自带的 fontLoadListeners 已被上游注释停用，这里补 fonts.ready → resizeCheck 重排。
  if (opts.fontFaceCss) {
    book.spine.hooks.content.register((contents: any) => {
      const css = opts.fontFaceCss?.();
      const doc = contents?.document;
      if (!css || !doc) return;
      try {
        contents.addStylesheetCss(css, "wr-custom-font");
      } catch (e) {
        logOnce("reader.fontFace.inject", `reader: @font-face inject failed ${String(e)}`);
      }
      try {
        doc.fonts?.ready?.then(() => {
          try {
            contents.resizeCheck?.();
          } catch {
            // 字体就绪重排失败：保持现有分页，下次翻章自然按新度量排版
          }
        });
      } catch {
        // iframe 无 FontFaceSet（老 WebView）：不等待，直接用回退字体排版
      }
    });
  }

  let lastEmitted: RelocatedPayload | null = null;
  let prefetchedSection: number | null = null;

  const onRelocated = (location: any) => {
    const cfi: string | undefined = location?.start?.cfi;
    if (!cfi) return;
    lastLocation = location;
    const percent =
      typeof book.locations?.percentageFromCfi === "function"
        ? (book.locations.percentageFromCfi(cfi) as number)
        : null;
    // B12 全局位置页（估算页，locations.generate(1024) 粒度）：locationFromCfi 返回索引数字（-1=未就绪）
    let locPage: { index: number; total: number } | null = null;
    const locTotal = typeof book.locations?.length === "function" ? book.locations.length() : 0;
    if (locTotal > 0 && typeof book.locations?.locationFromCfi === "function") {
      const loc = book.locations.locationFromCfi(cfi);
      if (typeof loc === "number" && loc >= 0) locPage = { index: loc, total: locTotal };
    }
    const href = String(location?.start?.href ?? "").split("#")[0];
    const sectionIndex = typeof location?.start?.index === "number" ? location.start.index : -1;
    const endSectionIndex = typeof location?.end?.index === "number" ? location.end.index : sectionIndex;
    const payload: RelocatedPayload = {
      cfi,
      percent,
      href,
      sectionIndex,
      endSectionIndex,
      pageStart: pageEdge(location?.start),
      pageEnd: pageEdge(location?.end),
      locPage,
    };
    // 引用去重：relocated 在滚动/resize/flow 切换下高频触发，值未变不下发新对象（宿主 setState 级联全树重渲）
    if (sameRelocatedPayload(lastEmitted, payload)) return;
    lastEmitted = payload;
    opts.onRelocated?.(payload);
    // 章节预取：进章即预载下一章（section.load 缓存于 section，display 时免一次解析）。
    // 比章尾预取更早且无"距章尾 N 页"探测成本；任意时刻至多多驻留一章 DOM。
    // !== 去重（同章内 relocated 每页都触发；向前/向后跳章都能补拉新邻章，重复 load 命中 section 缓存为零成本）
    const nextIndex = sectionIndex + 1;
    if (nextIndex !== prefetchedSection) {
      const item = book.spine?.spineItems?.[nextIndex];
      if (item?.linear) {
        prefetchedSection = nextIndex;
        item.load(book.load.bind(book)).catch(() => undefined);
      } else {
        prefetchedSection = nextIndex;
      }
    }
  };
  rendition.on("relocated", onRelocated);

  // locations 根治：不再与首显并发、不再 30s 超时降 4096（>300 章的书永远跑不完还卡主线程）。
  // 首显完成后 idle 启动：先试持久化灌注（book.locations.load，命中即就绪零成本），未命中才 generate(1024)；
  // epubjs 每章 100ms 停顿保留（库内部节流）。生成结果 5s 防抖落库；换字体字号（key 变）重算。
  let locationsKeyCurrent: string | null = null;
  let locationsGen = 0;
  let locationsSaveTimer: number | null = null;

  const locationsReady = () => {
    opts.onLocationsReady?.();
    if (lastLocation?.start?.cfi) onRelocated(lastLocation);
  };

  const scheduleLocationsSave = () => {
    if (locationsSaveTimer !== null) window.clearTimeout(locationsSaveTimer);
    locationsSaveTimer = window.setTimeout(() => {
      locationsSaveTimer = null;
      const payload = (() => {
        try {
          return book.locations?.save?.() ?? null;
        } catch {
          return null;
        }
      })();
      if (payload && opts.bookId) void saveBookLocations(opts.bookId, locationsKeyCurrent ?? "", payload);
    }, 5_000);
  };

  const idleRun = (fn: () => void) => {
    const ric = (window as any).requestIdleCallback;
    if (typeof ric === "function") ric(() => fn(), { timeout: 3_000 });
    else window.setTimeout(fn, 300);
  };

  const startLocationsGenerate = (gen: number) => {
    idleRun(() => {
      if (gen !== locationsGen) return;
      book.locations
        .generate(1024)
        .then(() => {
          if (gen !== locationsGen) return;
          locationsReady();
          if (opts.bookId) scheduleLocationsSave();
        })
        .catch((e: unknown) => {
          logOnce("reader.locations.generate", `reader: locations.generate(1024) failed ${String(e)}`);
        });
    });
  };

  const ensureLocations = () => {
    const key = opts.locationsKey?.() ?? locationsCacheKey(currentFontFamily, currentFontSizePercent);
    if (locationsKeyCurrent === key) return;
    locationsKeyCurrent = key;
    const gen = ++locationsGen;
    // 换 key 先停旧生成队列；同实例二次 generate 会 concat 追加（混合粒度毁掉二分查找），必须新实例
    const Ctor = (book.locations as any)?.constructor;
    try {
      book.locations?.destroy?.();
    } catch {
      // best effort
    }
    if (typeof Ctor !== "function") return;
    book.locations = new Ctor(book.spine, book.load.bind(book));
    if (!opts.bookId) {
      startLocationsGenerate(gen);
      return;
    }
    loadBookLocations(opts.bookId, key)
      .then((cached) => {
        if (gen !== locationsGen) return;
        if (typeof cached === "string" && cached) {
          try {
            book.locations.load(cached);
            locationsReady();
            return;
          } catch (e) {
            logOnce("reader.locations.load", `reader: locations.load failed ${String(e)}`);
          }
        }
        startLocationsGenerate(gen);
      })
      .catch(() => startLocationsGenerate(gen));
  };

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

  const chapterNav = (delta: number) => {
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
  };

  /**
   * flow 双向切换统一路径（B13 2a/2b）：spread 先于 flow 设置列度量（flow 内部重挂即按新度量渲染）；
   * epubjs 0.3.93 rendition.flow() 仅在 manager 已渲染且 location 就绪时自 clear+display——
   * 早切（display 刚 resolve、relocated 尚未跑完，重进书/快速切换）会留下按分页度量裁切的旧视图
   * （scrolled 下滚动失效、paginated 下双栏错切），故 location 缺失时统一补 clear+display(currentCfi)。
   */
  const applyFlow = (mode: ReadingMode) => {
    if (mode === currentFlow) return;
    currentFlow = mode;
    try {
      const cfi = rendition.currentLocation?.()?.start?.cfi;
      const target = typeof cfi === "string" ? cfi : undefined;
      const spreadFn = rendition?.spread;
      if (typeof spreadFn === "function") spreadFn.call(rendition, mode === "scrolled" ? "none" : lastSpreadMode);
      rendition.flow(mode);
      if (!rendition.location) {
        rendition.clear?.();
        void rendition.display?.(target);
      } else if (mode === "paginated") {
        rendition.resize?.();
      }
    } catch (e) {
      logOnce("reader.flow", `reader: flow switch failed ${String(e)}`);
    }
  };

  // D6 首显直达：带 initialTarget（恢复 CFI/URL cfi）直接 display，不先渲第 1 章再跳（双渲染+闪跳）；
  // 坏 CFI（书源变更等）退回第 1 章，不让进度残留砖掉开书
  const firstTarget = opts.initialTarget ?? undefined;
  const fatal = (e: unknown) => {
    const msg = `首次渲染超时/失败：${String(e)}`;
    opts.onError?.(msg);
    rendition?.destroy?.();
    book.destroy?.();
    throw new Error(msg);
  };
  try {
    await withTimeout(rendition.display(firstTarget), 30_000);
  } catch (e) {
    if (firstTarget) {
      logOnce("reader.display", `reader: initial target failed, fallback to start ${String(e)}`);
      await withTimeout(rendition.display(), 30_000).catch(fatal);
    } else {
      fatal(e);
    }
  }

  // 冷启动收敛：请求 scrolled 时在首显成功后立即切换（见 renderTo 注释）
  if (requestedFlow === "scrolled") applyFlow("scrolled");

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
      currentFontSizePercent = percent;
      ensureLocations(); // locations 按 字体|字号 档缓存：换档重算（命中持久化则零成本灌注）
    },
    setLineHeight: (lineHeight: number) => {
      if (lineHeight === currentLineHeight) return;
      currentLineHeight = lineHeight;
      registerThemes(lineHeight, currentFontFamily);
    },
    setFontFamily: (fontFamily: FontFamily) => {
      if (fontFamily === currentFontFamily) return;
      currentFontFamily = fontFamily;
      registerThemes(currentLineHeight, fontFamily);
      ensureLocations();
    },
    setSpreadMode: (mode: SpreadMode) => {
      if (mode === lastSpreadMode) return;
      lastSpreadMode = mode;
      const cfi = rendition.currentLocation?.()?.start?.cfi;
      applySpreadMode(rendition, mode, typeof cfi === "string" ? cfi : undefined);
    },
    setReadingMode: (mode: ReadingMode) => applyFlow(mode),
    chapterNav,
    /** B13 滚动模式键盘翻屏：章末/章首即时 chapterNav，章中原生滚动一屏。返回触发的章方向（null=章内滚动） */
    scrollStep: (dir: 1 | -1) => {
      try {
        if (currentFlow !== "scrolled") return null;
        const scroller = opts.container.querySelector<HTMLElement>(".epub-container");
        if (!scroller) return null;
        if (scrollEdgeDirection(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight, dir) === dir) {
          chapterNav(dir);
          return dir;
        }
        scroller.scrollBy({ top: dir * Math.max(1, scroller.clientHeight - 48), behavior: "auto" });
        return null;
      } catch (e) {
        logOnce("reader.scrollStep", `reader: scrollStep failed ${String(e)}`);
        return null;
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
        // annotations.remove 以 encodeURI(cfiRange+type) 为 hash，不传 type 拼上 "undefined" 永不命中（DB 删了渲染层残留）
        rendition.annotations.remove(cfiRange, "highlight");
      } catch (e) {
        logOnce("reader.removeHighlight", `reader: removeHighlight failed ${String(e)}`);
      }
    },
    resize: () => {
      try {
        // 同尺寸下 rendition.resize() 会被 manager 提前返回（不重排页码），统一走 clear+display 当前 CFI；
        // scrolled 模式 spread 必须保持 none（与 setSpreadMode 跳过逻辑一致）
        const cfi = rendition.currentLocation?.()?.start?.cfi;
        applySpreadMode(rendition, currentFlow === "scrolled" ? "none" : lastSpreadMode, typeof cfi === "string" ? cfi : undefined);
      } catch (e) {
        logOnce("reader.resize", `reader: resize failed ${String(e)}`);
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
      // 关书兜底：locations 生成的防抖落库若还在排队，立即一次写完（book.destroy 会作废 locations）
      locationsGen += 1;
      if (locationsSaveTimer !== null) {
        window.clearTimeout(locationsSaveTimer);
        locationsSaveTimer = null;
        const payload = (() => {
          try {
            return book.locations?.save?.() ?? null;
          } catch {
            return null;
          }
        })();
        if (payload && opts.bookId) void saveBookLocations(opts.bookId, locationsKeyCurrent ?? "", payload);
      }
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
