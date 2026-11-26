import ePub, { EpubCFI } from "epubjs";
import { patchEpubjsBook } from "./epubjsPatch"; // 上游 replacementUrls 索引错位补丁

import type { FontFamily, ReadingMode, Theme } from "../settings/types";
import { readAppDataFile } from "../../tauri/appDataPaths";
import type { SpreadMode } from "../settings/layoutMode";
import { logFrontend } from "../../tauri/frontendLog";
import { loadBookLocations, readBookFile, saveBookLocations } from "../../tauri/invoke";

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
  /**
   * V-1 翻页提交（快照翻页的 DOM 更新回调内调用）。那段回调期间浏览器不产帧、rAF 冻结，而 rendition 队列靠
   * rAF 推进——所以直接调 manager.next/prev（= Rendition.next 去掉队列包装），位置上报交给 reportTurn 在回调外补。
   * 返回新页进入的一侧、页面是否真的变了（到书的首尾时不变）。
   */
  turn: (direction: 1 | -1) => Promise<{ dir: 1 | -1; changed: boolean; axis: "horizontal" | "vertical" }>;
  /** turn 之后的 relocated 上报（不在更新回调里跑：它内部也用 rAF） */
  reportTurn: () => void;
  display: (target?: string) => Promise<void>;
  /** 返回 false = 已在首章 / 末章、没翻动（V-13 轻提示用） */
  chapterNav: (delta: number) => boolean;
  /** B13 滚动模式翻屏（PageDown/PageUp）：章末/章首即时章导航，章中滚动一屏；返回 false = 已到书的首尾、没动 */
  scrollStep: (dir: 1 | -1) => boolean;
  progressCfi: (percentage: number) => string | null;
  setTheme: (theme: Theme) => void;
  setFontSizePercent: (percent: number) => void;
  setLineHeight: (lineHeight: number) => void;
  setFontFamily: (fontFamily: FontFamily) => void;
  /** #2 排版细项（字重/字间距/段距/首行缩进/页边距/两端对齐）：合并当前值重注册主题样式 */
  setTypography: (t: Partial<TypographyParams>) => void;
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

/** E-4：iframe 图片懒加载仅滚动模式（纵向滚动 lazy 语义正确；分页横向分栏下永不清算→破图） */
export function lazyImagesForFlow(flow: string): boolean {
  return flow === "scrolled";
}

/**
 * ZIP 的中央目录结束记录（EOCD，PK\x05\x06）在文件尾部、其后最多跟 64KB 注释：尾部找不到 = 被截断 / 不是 zip。
 * 只做这个最便宜的完整性判断——它挡的是「落盘中途断电留下的半截 .opt.epub」，不是通用的 zip 校验。
 */
export function hasZipEnd(b: Uint8Array): boolean {
  const tail = b.subarray(Math.max(0, b.length - 22 - 65535));
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) return true;
  }
  return false;
}

/**
 * 撤掉某主题已注入各章节 iframe 的样式表（epub.js 给每个主题建一张 <style id="epubjs-inserted-css-主题名">）。
 * 上游 Themes.add 是往这张表里 insertRule 追加而不是替换——每次重选同一主题，规则就多一份。
 * 撤掉后再 select，epub.js 会按当前规则重建一张。返回撤掉的张数。
 */
export function dropThemeSheet(contents: unknown[], theme: string): number {
  let n = 0;
  for (const c of contents) {
    const sheet = (c as { document?: Document } | null)?.document?.getElementById(`epubjs-inserted-css-${theme}`);
    if (sheet) {
      sheet.remove();
      n += 1;
    }
  }
  return n;
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

/** #2 排版细项全集（registerThemes 注入 iframe；lineHeight/fontFamily 与既有键同源） */
export type TypographyParams = {
  lineHeight: number;
  fontFamily: FontFamily;
  fontWeight: number;
  letterSpacing: number;
  paragraphSpacing: number;
  textIndent: number;
  pageMargin: number;
  justify: boolean;
};

/**
 * U-8 页边距默认档自适应：未手动调过（=默认 24px）时随纸面宽 clamp——窄窗边距收窄、正文区放大；
 * 手动档（含 epuset 书级钉住的值）保持固定 px。vw 在 epubjs iframe 内解析=纸面宽（非窗口宽），
 * 纸面有 760/1100 上限，故 ≥~800px 窗口恒为 24px 上限=大屏维持现有观感。
 */
export function pageMarginCss(pageMargin: number, defaultMargin: number): string {
  return pageMargin === defaultMargin ? "clamp(12px, 3.2vw, 24px)" : `${pageMargin}px`;
}

export async function createReader(opts: {
  container: HTMLElement;
  libraryPath: string;
  spreadMode?: SpreadMode;
  readingMode?: ReadingMode;
  lineHeight?: number;
  fontFamily?: FontFamily;
  /** 排版细项初始值（ReaderPage 传书级生效值；缺省用默认档） */
  typography?: Partial<TypographyParams>;
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
  /** P-1：iframe 内 img 点击（payload=当前 blob src 与 alt；src 已是 epubjs 替换后的 blob） */
  onImageClick?: (payload: { src: string; alt: string }) => void;
}): Promise<ReaderController> {
  // A 的前端半：优先开导入侧生成的 .opt.epub 阅读优化副本（插图缩放重打包），不存在回落原书。
  // 导入侧扩展名固定小写 .epub，大写 .EPUB 不探测。
  // v2.7.0 M-2：引用书（绝对路径）走 read_book_file 桥（readAppDataFile 的 isSafeRelPath 拒盘符）；
  // 引用书不生成 .opt（禁止写用户目录），直读原书。
  let bytes: Uint8Array;
  const isReference = /^[a-zA-Z]:[\\/]/.test(opts.libraryPath);
  if (isReference) {
    if (!opts.bookId) throw new Error("引用书缺少 bookId");
    bytes = await readBookFile(opts.bookId);
  } else if (/\.epub$/.test(opts.libraryPath)) {
    let opt: Uint8Array | null = null;
    try {
      opt = await readAppDataFile(opts.libraryPath.replace(/\.epub$/, ".opt.epub"));
    } catch {
      // 没有优化副本
    }
    // R1：.opt 在、但不是完整的 zip（落盘中途断电 / 被截断）→ 回落原书；坏文件由启动时的补生成重做。
    // 原先只有「读不到文件」才回落：读得到却打不开时直接报「EPUB 打开失败」
    if (opt && hasZipEnd(opt)) {
      bytes = opt;
    } else {
      if (opt) logFrontend(`reader: .opt.epub 不完整，回落原书 ${opts.libraryPath}`);
      bytes = await readAppDataFile(opts.libraryPath);
    }
  } else {
    bytes = await readAppDataFile(opts.libraryPath);
  }
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
  patchEpubjsBook(book); // book.ready 后 resources/archive 已建：在实际运行类上打对齐补丁

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
  // 章节切换重建 iframe——每次 rendered 后重新应用当前主题（否则切章后字体丢失）。
  // selectTheme 先撤旧表：主题 hook 已经给新 iframe 注入过一份，直接 select 会再追加一份
  rendition.on?.("rendered", () => {
    try { selectTheme(currentTheme); } catch {}
  });

  let currentTheme: Theme = "light";
  /** 上游 Themes.add 往同一张 <style> 里追加而不是替换：重选前先把该主题已注入的样式表撤掉，规则不会越选越多（E7） */
  const selectTheme = (t: Theme) => {
    dropThemeSheet(rendition.getContents?.() ?? [], t);
    rendition.themes.select(t);
  };
  let currentFontSizePercent = 120;
  const DEFAULT_TYPO: TypographyParams = {
    lineHeight: 1.9,
    fontFamily: "default",
    fontWeight: 400,
    letterSpacing: 0,
    paragraphSpacing: 0,
    textIndent: 0,
    pageMargin: 24,
    justify: false,
  };
  let typo: TypographyParams = {
    ...DEFAULT_TYPO,
    lineHeight: opts.lineHeight ?? 1.9,
    fontFamily: opts.fontFamily ?? "default",
    ...(opts.typography ?? {}),
  };

  const registerThemes = () => {
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
      // #2 排版细项：中性档不注入（字重 400/字间距 0/缩进 0/段距 0/不两端对齐——书内自带样式保持现状，存量书零回归）；
      // !important 同 p 的 line-height 理由：压过书内自带规则。
      const pRules: Record<string, string> = {};
      if (typo.paragraphSpacing > 0) pRules["margin-bottom"] = `${typo.paragraphSpacing}em !important`;
      if (typo.fontWeight !== DEFAULT_TYPO.fontWeight) pRules["font-weight"] = `${typo.fontWeight} !important`;
      if (typo.letterSpacing > 0) pRules["letter-spacing"] = `${typo.letterSpacing}px !important`;
      if (typo.textIndent > 0) pRules["text-indent"] = `${typo.textIndent}em !important`;
      if (typo.justify) pRules["text-align"] = "justify !important";
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
          // #2 纸面四边内边距（pageMargin，12-48px）；默认档走 U-8 自适应 clamp
          padding: pageMarginCss(typo.pageMargin, DEFAULT_TYPO.pageMargin),
          "line-height": String(typo.lineHeight),
          "font-family": `${FONT_STACKS[typo.fontFamily]} !important`,
          "word-break": "break-word",
          "overflow-wrap": "anywhere",
          // epub 自带浅底会透出暗色壳：dark/darkcontrast 注入不透明纸面（!important 压过 epub 自身规则），浅色主题保持 transparent
          background: opaque ? `${s.paper} !important` : "transparent",
          color: opaque ? `${s.fg} !important` : s.fg,
        },
        // 段落常自带 line-height / font-family（比 body 继承更具体——继承必输给直命中 p 的声明），
        // 须直接命中 p 且加 !important（B12 字体不生效根因即书内 p/类选择器压过了 body 继承）
        [`body.${t} p, body.${t}`]: {
          "line-height": `${typo.lineHeight} !important`,
          "font-family": `${FONT_STACKS[typo.fontFamily]} !important`,
        },
        [`body.${t} p`]: pRules,
      });
    }
    // 防御+重试：iframe 未就绪时 sheet 为 null——首次失败延迟到 rendition.ready 后重试注入
    try {
      selectTheme(currentTheme);
    } catch {
      rendition.ready.then(() => {
        try { selectTheme(currentTheme); } catch {}
      }).catch(() => {});
    }
  };
  registerThemes();
  rendition.themes.fontSize("120%");
  rendition.themes.default({
    "::selection": { background: "rgba(255, 230, 0, 0.35)" },
    ".epubjs-hl": { fill: "rgba(255, 230, 0, 0.35)", "fill-opacity": "0.35", "mix-blend-mode": "multiply" },
  });

  // B2 图片惰性解码 + E-4 回归修复：loading=lazy/decoding=async 仅滚动模式注入——
  // 分页模式是横向分栏容器，lazy 判定认为图不在视口 → 永不加载 → 章节装饰图/logo 全破（v2.6.0 回归，
  // 极品家丁第一章实锤）。currentFlow 闭包可读：applyFlow 先改值再重渲染，hook 每节内容挂载时取当前值。
  // P-1：img 点击 → 宿主 Lightbox（stopPropagation 防 epubjs 选区/链接处理；hook 时机 src 已是 blob，
  // 原始条目名不可反查——Lightbox 放大显示 .opt 当前 blob）。
  // 注意挂 rendition.hooks.content（参数=Contents 对象，与 themes 注入同管线，已验证触发）；
  // book.spine.hooks.content 的参数是裸 document——v2.6.0 验收发现原先挂错位置导致静默空转（字体注入同病，见下）。
  rendition.hooks.content.register((contents: any) => {
    try {
      const imgs = contents?.document?.querySelectorAll?.("img");
      if (!imgs) return;
      const lazy = lazyImagesForFlow(currentFlow);
      for (const img of Array.from(imgs) as HTMLImageElement[]) {
        if (lazy) {
          img.loading = "lazy";
          img.decoding = "async";
        } else {
          img.loading = "eager";
        }
        img.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          const src = img.currentSrc || img.src;
          if (src) opts.onImageClick?.({ src, alt: img.alt });
        });
      }
    } catch {
      // 属性赋值在老 WebView 被忽略，无害
    }
  });

  // 自定义正文 @font-face 注入 iframe（正文在 epubjs iframe 里，宿主 document 的 @font-face 完全无效）。
  // 同样必须挂 rendition.hooks.content（Contents.addStylesheetCss 按 key 幂等覆盖）——
  // v2.5.0 起此 hook 误挂 spine.hooks（参数是 document 无 addStylesheetCss，异常被吞）致自定义字体一直未生效，本批修正。
  // 字体就绪前排版度量错误：epubjs 自带的 fontLoadListeners 已被上游注释停用，这里补 fonts.ready → resizeCheck 重排。
  if (opts.fontFaceCss) {
    rendition.hooks.content.register((contents: any) => {
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

  // ═══ V-1 翻页提交（快照翻页的 DOM 更新回调内调用；机制见 ReaderController.turn 注释）═══
  /** 等 rendition 的下一次 rendered（跨章后主题 / 字体 / 脚本注入完毕）。超时放行，不让翻页卡住 */
  const nextRendered = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        window.clearTimeout(timer);
        rendition.off?.("rendered", done);
        resolve();
      };
      const timer = window.setTimeout(done, 1500);
      rendition.on?.("rendered", done);
    });

  /**
   * 新页就绪度（拍新态快照之前）：等字体与屏内图片解码完成（上限 600ms），再同步做一次"内容尺寸变了就重新量宽"。
   * 平时后者由 ResizeObserver → rAF 触发，而更新回调里不产帧；不补的话跨章首帧可能按主题注入前的宽度拍下来。
   */
  const settlePage = async (view: any) => {
    const doc: Document | undefined = view?.contents?.document;
    if (!doc) return;
    const jobs: Promise<unknown>[] = [];
    try {
      if (doc.fonts?.ready) jobs.push(doc.fonts.ready);
    } catch {
      // 无 FontFaceSet
    }
    const box = opts.container.querySelector(".epub-container")?.getBoundingClientRect();
    const frame = view.iframe?.getBoundingClientRect?.();
    if (box && frame) {
      for (const img of Array.from(doc.images)) {
        const r = img.getBoundingClientRect();
        if (frame.left + r.right > box.left && frame.left + r.left < box.right) jobs.push(img.decode());
      }
    }
    await withTimeout(Promise.allSettled(jobs), 600).catch(() => undefined);
    try {
      view.contents?.resizeCheck?.();
    } catch {
      // 重排失败：保持现有分页
    }
  };

  const turn = async (direction: 1 | -1): Promise<{ dir: 1 | -1; changed: boolean; axis: "horizontal" | "vertical" }> => {
    const manager = rendition.manager;
    const viewBefore = lastView();
    const scroller = opts.container.querySelector<HTMLElement>(".epub-container");
    // 竖排书纵向分页：翻页是容器竖向滚动
    const axis: "horizontal" | "vertical" = manager.settings?.axis === "vertical" ? "vertical" : "horizontal";
    const pos = () => (axis === "vertical" ? scroller?.scrollTop ?? 0 : scroller?.scrollLeft ?? 0);
    const x0 = pos();
    const seq = renderedSeq;
    try {
      if (direction > 0) await manager.next();
      else await manager.prev();
    } catch (e) {
      logOnce("reader.turn", `reader: turn failed ${direction} ${String(e)}`);
    }
    const view = lastView();
    // RTL 书往前翻，新页自左入
    const forward: 1 | -1 = manager.settings?.direction === "rtl" ? (direction > 0 ? -1 : 1) : direction;
    if (view === viewBefore) {
      // 章内只是容器横向滚动：滚动方向即新页进入的一侧（RTL 容器的 scrollLeft 语义相反，正好自洽）
      const x1 = pos();
      if (view && x1 !== x0) await settlePage(view);
      return { dir: x1 === x0 ? forward : x1 > x0 ? 1 : -1, changed: !!view && x1 !== x0, axis };
    }
    if (view) {
      // 跨章：manager.next 的 promise 不保证主题 / 脚本已注入完（那是不被等待的 hooks 链）
      if (renderedSeq === seq) await nextRendered();
      await settlePage(view);
    }
    return { dir: forward, changed: !!view, axis };
  };

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

  // V-1 翻页提交要认“当前显示的是哪个视图”“新章注入是否已发过 rendered”
  let renderedSeq = 0;
  rendition.on?.("rendered", () => {
    renderedSeq += 1;
  });
  const lastView = (): any => rendition.views().last();

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
    const key = opts.locationsKey?.() ?? locationsCacheKey(typo.fontFamily, currentFontSizePercent);
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
      // B-1：保留 epub.js 嵌套层级（ncx parseNcx / epub3 parseNav 均有 subitems）——递归全深度映射
      const mapNav = (i: any): TocItem => ({
        label: i.label,
        href: i.href,
        subitems: i.subitems?.length ? i.subitems.map(mapNav) : undefined,
      });
      const toc: TocItem[] = navigation?.toc?.map(mapNav) ?? [];
      opts.onTocLoaded?.(toc);
    } catch (e) {
      opts.onError?.(`目录解析失败：${String(e)}`);
      opts.onTocLoaded?.([]);
    }
  })();

  const chapterNav = (delta: number): boolean => {
    try {
      if (!delta) return true;
      const loc = rendition.currentLocation?.();
      let idx: number | null = loc?.start?.index;
      if (typeof idx !== "number" || !Number.isFinite(idx) || idx < 0) idx = spineIndexFromCfi(loc?.start?.cfi);
      if (idx === null) return true;
      const count: number = book.spine?.spineItems?.length ?? 0;
      const next = Math.min(count - 1, Math.max(0, idx + delta));
      if (next === idx) return false;
      const href = book.spine.get?.(next)?.href;
      if (typeof href === "string" && href) void rendition.display(href);
    } catch (e) {
      logOnce("reader.chapterNav", `reader: chapterNav failed ${String(e)}`);
    }
    return true;
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
  // 首章 display 完成——此刻 iframe 已创建并渲染，themes.select 才有 document 可注入
  // （registerThemes 的初始调用在 display 之前，sheet 为 null 是必然；dev 版仅靠时序偶然通过）
  try { selectTheme(currentTheme); } catch {}

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
    turn,
    reportTurn: () => {
      try {
        rendition.reportLocation();
      } catch (e) {
        logOnce("reader.reportTurn", `reader: reportLocation failed ${String(e)}`);
      }
    },
    setTheme: (theme: Theme) => {
      if (theme === currentTheme) return;
      currentTheme = theme;
      selectTheme(theme);
    },
    setFontSizePercent: (percent: number) => {
      rendition.themes.fontSize(`${percent}%`);
      currentFontSizePercent = percent;
      ensureLocations(); // locations 按 字体|字号 档缓存：换档重算（命中持久化则零成本灌注）
    },
    setLineHeight: (lineHeight: number) => {
      if (lineHeight === typo.lineHeight) return;
      typo = { ...typo, lineHeight };
      registerThemes();
    },
    setFontFamily: (fontFamily: FontFamily) => {
      if (fontFamily === typo.fontFamily) return;
      typo = { ...typo, fontFamily };
      registerThemes();
      ensureLocations();
    },
    setTypography: (t: Partial<TypographyParams>) => {
      const next: TypographyParams = { ...typo, ...t };
      const changed = (Object.keys(next) as (keyof TypographyParams)[]).some((k) => next[k] !== typo[k]);
      if (!changed) return;
      typo = next;
      registerThemes();
    },
    setSpreadMode: (mode: SpreadMode) => {
      if (mode === lastSpreadMode) return;
      lastSpreadMode = mode;
      const cfi = rendition.currentLocation?.()?.start?.cfi;
      applySpreadMode(rendition, mode, typeof cfi === "string" ? cfi : undefined);
    },
    setReadingMode: (mode: ReadingMode) => applyFlow(mode),
    chapterNav,
    /** B13 滚动模式键盘翻屏：章末/章首即时 chapterNav，章中原生滚动一屏。返回 false = 已到书的首尾、没动 */
    scrollStep: (dir: 1 | -1) => {
      try {
        if (currentFlow !== "scrolled") return true;
        const scroller = opts.container.querySelector<HTMLElement>(".epub-container");
        if (!scroller) return true;
        if (scrollEdgeDirection(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight, dir) === dir) {
          return chapterNav(dir);
        }
        scroller.scrollBy({ top: dir * Math.max(1, scroller.clientHeight - 48), behavior: "auto" });
        return true;
      } catch (e) {
        logOnce("reader.scrollStep", `reader: scrollStep failed ${String(e)}`);
        return true;
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
