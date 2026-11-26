import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import * as Menu from "@radix-ui/react-menu";
import { PointMenu, Tooltip, TooltipProvider } from "../ui/radix";

import type { Book } from "../tauri/invoke";
import {
  addBookmark,
  addFavoriteQuote,
  addHighlight,
  addReadingTime,
  deleteBookmark,
  deleteFavoriteQuote,
  deleteHighlight,
  exportAnnotations,
  getBook,
  getReadingState,
  getSettings,
  listBookmarks,
  listBookMedia,
  listFavoriteQuotes,
  listHighlights,
  optimizeEpubNow,
  setBookFavorite,
  setSetting,
  setSettings as setSettingsBatch,
  upsertReadingState,
  type Bookmark,
  type FavoriteQuote,
  type Highlight,
  type MediaEntry,
} from "../tauri/invoke";
import {
  cfiRangesOverlap,
  createReader,
  locationsCacheKey,
  scrollEdgeDirection,
  type ReaderController,
  type RelocatedPayload,
  type SearchResult,
  type SelectionRect,
  type TocItem,
} from "../reader/epub/reader";
import { readerFontFaceCss } from "../reader/epub/iframeFont";
import { tocLabelFor } from "../reader/epub/tocLabel";
import {
  TURN_EFFECT_MS,
  createTurnQueue,
  effectivePageAnimation,
  runViewTurn,
  turnPaperColor,
  viewTurnSupported,
  type TurnHandle,
} from "../reader/epub/turnFx";
import BookmarksPanel from "../reader/components/BookmarksPanel";
import HighlightsPanel from "../reader/components/HighlightsPanel";
import ImageLightbox from "../reader/components/ImageLightbox";
import MediaPanel from "../reader/components/MediaPanel";
import SearchPanel from "../reader/components/SearchPanel";
import SettingsPanel from "../reader/components/SettingsPanel";
import SelectionToolbar from "../reader/components/SelectionToolbar";
import TocPanel from "../reader/components/TocPanel";
import ImageReader, { type ImageReaderApi } from "../reader/image/ImageReader";
import ImageSettingsPanel from "../reader/image/ImageSettingsPanel";
import PagesPanel from "../reader/image/PagesPanel";
import {
  defaultImageReaderSettings,
  imageCfi,
  imageDefaultsFromEffective,
  imageSettingsKey,
  normalizeImageReaderSettings,
  pagePercent,
  parseImageCfi,
  parseImageSettingsOverride,
  resolveImageSettings,
  turnKeyDirection,
  type ImageReaderSettings,
  type ImageSettingsOverride,
} from "../reader/image/layout";
import PdfReader, { type PdfReaderApi } from "../reader/pdf/PdfReader";
import { parsePdfCfi, pdfCfi } from "../reader/pdf/layout";
import { defaultSettings, HIGHLIGHT_COLOR } from "../reader/settings/defaults";
import type { PageAnimation, ReaderSettings } from "../reader/settings/types";
import { normalizeLayoutMode, resolveSpreadMode } from "../reader/settings/layoutMode";
import {
  normalizeBgVeil,
  normalizeFontFamily,
  normalizeFontWeight,
  normalizeLetterSpacing,
  normalizeLineHeight,
  normalizePageAnimation,
  normalizePageMargin,
  normalizeParagraphSpacing,
  normalizeReaderBackground,
  normalizeReaderFont,
  normalizeReadingMode,
  normalizeTextIndent,
  normalizeTtsRate,
  normalizeTurnSpeedMs,
} from "../reader/settings/normalize";
import {
  epubDefaultsFromEffective,
  epubSettingsKey,
  EPUSET_FIELDS,
  parseEpubSettingsOverride,
  resolveEpubSettings,
  type EpubSettingsOverride,
} from "../reader/settings/epuset";
import { speak, stop as ttsStop, subscribeTts, ttsSpeaking, ttsSupported } from "../reader/tts";
import { calcPaperStage } from "../reader/ui/paperStage";
import { showEdgeHint } from "../reader/ui/edgeHint";
import { logFrontend } from "../tauri/frontendLog";
import Drawer from "../ui/Drawer";
import { showAlert, showConfirm } from "../ui/dialog";
import { installDesktopChrome } from "../ui/desktopChrome";
import { WindowControls } from "../ui/TitleBar";
import { useElementSize } from "../ui/useElementSize";
import { useImmersiveChrome } from "../ui/useImmersiveChrome";
import { getBackgroundUrl } from "../ui/appBackground";
import { applyPersistedTheme, getTheme, useTheme } from "../ui/theme";
import {
  IconBookmark,
  IconChevronLeft,
  IconChevronRight,
  IconHeart,
  IconHighlight,
  IconImage,
  IconList,
  IconLock,
  IconLockOpen,
  IconQuote,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSpeaker,
  IconVideo,
} from "../ui/icons";

// 漫画/PDF 共用一套翻页 api 消费面（PDF 增量提供 renderThumb 供页面面板缩略图）
type PageReaderApi = ImageReaderApi & { renderThumb?: (page: number) => Promise<string | undefined> };

type SideTab = "toc" | "bookmarks" | "highlights" | "favorites" | "search" | "settings" | "pages" | "media";

const SIDE_TABS: readonly SideTab[] = ["toc", "bookmarks", "highlights", "favorites", "search", "settings", "pages", "media"];

// H-2 抽屉 tab 会话内记忆（同收藏页 tab 方案）：重开抽屉回到上次 tab
const READER_TAB_KEY = "wr-reader-tab";
/** 纸面为深色的主题（翻页阴影 / 折页高光随之调整） */
const DARK_THEMES = ["dark", "darkcontrast", "ink-dark"];
function initialSideTab(): SideTab {
  try {
    const v = sessionStorage.getItem(READER_TAB_KEY);
    return (SIDE_TABS as readonly string[]).includes(v ?? "") ? (v as SideTab) : "toc";
  } catch {
    return "toc";
  }
}

/** B-2 大书守卫判据：库内 EPUB 且 >64MB（漫画/PDF/非 .epub 不经此路径） */
export function bigEpubGuard(fileSize: number | null, libraryPath: string): boolean {
  return (fileSize ?? 0) > 64_000_000 && /\.epub$/.test(libraryPath);
}

// §8 轻拆（零行为变化）：设置面板 memo——搜索输入/选区/进度拖动等无关重渲不再触面板
const MemoSettingsPanel = memo(SettingsPanel);
const MemoImageSettingsPanel = memo(ImageSettingsPanel);

// 栏淡出/淡入：仅 opacity+transform（栏已是 absolute overlay，不占布局，纸面恒定不 resize）
function chromeBarStyle(visible: boolean, dy: number): React.CSSProperties {
  return {
    transition: "opacity 200ms ease, transform 200ms ease",
    ...(visible ? null : { opacity: 0, transform: `translateY(${dy}px)`, pointerEvents: "none" as const }),
  };
}

/** §8 轻拆：顶栏 memo——热区 bump/ relocated/进度拖动只在涉及自身 props 变化时重渲 */
const ReaderTopBar = memo(function ReaderTopBar(props: {
  visible: boolean;
  title: string;
  percentText: string;
  showEpubTools: boolean;
  showVisualTools: boolean;
  /** V-1：原书含音视频时显示媒体入口 */
  showMedia: boolean;
  isFavorite: boolean;
  /** #5 朗读（EPUB 且 WebView 支持 speechSynthesis） */
  showTts: boolean;
  ttsOn: boolean;
  onToggleSpeak: () => void;
  onBack: () => void;
  onOpenDrawer: (tab: SideTab) => void;
  onToggleFavorite: () => void;
  onLock: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      className="wr-topbar wr-reader-topbar"
      style={chromeBarStyle(props.visible, -8)}
      data-tauri-drag-region=""
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
    >
      <Tooltip content="返回书库">
        <button className="wr-btn wr-icon-btn" aria-label="返回书库" onClick={props.onBack}>
          <IconChevronLeft />
          <span className="wr-topbar-label">返回书库</span>
        </button>
      </Tooltip>
      {/* U-23：书名与中段空隙=拖动区（双击最大化由 Tauri drag-region 处理）；
           窄窗按钮挤满时书名区保底 80px 可拖，spacer 保底 12px */}
      <div
        data-tauri-drag-region=""
        style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 80, flexShrink: 1 }}
      >
        {props.title}
      </div>
      <div data-tauri-drag-region="" style={{ flex: 1, minWidth: 12 }} />
      {props.showEpubTools ? (
        <>
          <Tooltip content="目录">
            <button className="wr-btn wr-icon-btn" aria-label="目录" onClick={() => props.onOpenDrawer("toc")}>
              <IconList />
              <span className="wr-topbar-label">目录</span>
            </button>
          </Tooltip>
          <Tooltip content="书签">
            <button className="wr-btn wr-icon-btn" aria-label="书签" onClick={() => props.onOpenDrawer("bookmarks")}>
              <IconBookmark />
              <span className="wr-topbar-label">书签</span>
            </button>
          </Tooltip>
          <Tooltip content="标注">
            <button className="wr-btn wr-icon-btn" aria-label="标注" onClick={() => props.onOpenDrawer("highlights")}>
              <IconHighlight />
              <span className="wr-topbar-label">标注</span>
            </button>
          </Tooltip>
          <Tooltip content="收藏句子">
            <button className="wr-btn wr-icon-btn" aria-label="收藏句子" onClick={() => props.onOpenDrawer("favorites")}>
              <IconQuote />
              <span className="wr-topbar-label">收藏</span>
            </button>
          </Tooltip>
          <Tooltip content="搜索">
            <button className="wr-btn wr-icon-btn" aria-label="搜索" onClick={() => props.onOpenDrawer("search")}>
              <IconSearch />
              <span className="wr-topbar-label">搜索</span>
            </button>
          </Tooltip>
          {props.showMedia ? (
            <Tooltip content="媒体">
              <button className="wr-btn wr-icon-btn" aria-label="媒体" onClick={() => props.onOpenDrawer("media")}>
                <IconVideo />
                <span className="wr-topbar-label">媒体</span>
              </button>
            </Tooltip>
          ) : null}
        </>
      ) : null}
      {props.showTts ? (
        <Tooltip content={props.ttsOn ? "停止朗读" : "从当前章朗读"}>
          <button
            className="wr-btn wr-icon-btn"
            data-active={props.ttsOn ? "true" : undefined}
            aria-pressed={props.ttsOn}
            aria-label={props.ttsOn ? "停止朗读" : "从当前章朗读"}
            onClick={props.onToggleSpeak}
          >
            <IconSpeaker />
            <span className="wr-topbar-label">朗读</span>
          </button>
        </Tooltip>
      ) : null}
      {props.showVisualTools ? (
        <>
          <Tooltip content={props.isFavorite ? "取消收藏本书" : "收藏本书"}>
            <button
              className="wr-btn wr-icon-btn"
              aria-pressed={props.isFavorite}
              aria-label={props.isFavorite ? "取消收藏本书" : "收藏本书"}
              onClick={props.onToggleFavorite}
            >
              <IconHeart fill={props.isFavorite ? "currentColor" : "none"} aria-hidden />
              <span className="wr-topbar-label">收藏</span>
            </button>
          </Tooltip>
          <Tooltip content="书签">
            <button className="wr-btn wr-icon-btn" aria-label="书签" onClick={() => props.onOpenDrawer("bookmarks")}>
              <IconBookmark />
              <span className="wr-topbar-label">书签</span>
            </button>
          </Tooltip>
          <Tooltip content="页面">
            <button className="wr-btn wr-icon-btn" aria-label="页面" onClick={() => props.onOpenDrawer("pages")}>
              <IconImage />
              <span className="wr-topbar-label">页面</span>
            </button>
          </Tooltip>
        </>
      ) : null}
      <Tooltip content="设置">
        <button className="wr-btn wr-icon-btn" aria-label="设置" onClick={() => props.onOpenDrawer("settings")}>
          <IconSettings />
          <span className="wr-topbar-label">设置</span>
        </button>
      </Tooltip>
      <Tooltip content="锁定沉浸：栏与热区全禁用，角落控件或 Esc 解锁">
        <button className="wr-btn wr-icon-btn" aria-label="锁定沉浸" onClick={props.onLock}>
          <IconLock />
          <span className="wr-topbar-label">锁定</span>
        </button>
      </Tooltip>
      <div className="wr-muted" style={{ fontVariantNumeric: "tabular-nums" }}>
        {props.percentText}
      </div>
      {/* U-23：标题栏并入阅读顶栏——随沉浸 chrome 同步隐藏/顶缘悬停浮现（红线②） */}
      <WindowControls />
    </div>
  );
});

/** §8 轻拆：页脚 memo（含进度条；refs/handlers 由 ReaderPage 稳定传入） */
const ReaderFooter = memo(function ReaderFooter(props: {
  visible: boolean;
  isVisualBook: boolean;
  sliderReady: boolean;
  fill: number;
  dragging: boolean;
  pageText: string;
  onTurn: (direction: "prev" | "next") => void;
  progressRef: React.RefObject<HTMLDivElement | null>;
  onProgressKeyDown: (e: React.KeyboardEvent) => void;
  onProgressPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onProgressPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onProgressPointerEnd: (e: React.PointerEvent<HTMLDivElement>) => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      className="wr-reader-footer"
      style={{
        ...chromeBarStyle(props.visible, 8),
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 10,
      }}
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
    >
      <button className="wr-btn wr-icon-btn" onClick={() => props.onTurn("prev")}>
        <IconChevronLeft />
        {props.isVisualBook ? "上一页" : "上一章"}
      </button>
      <button className="wr-btn wr-icon-btn" onClick={() => props.onTurn("next")}>
        <IconChevronRight />
        {props.isVisualBook ? "下一页" : "下一章"}
      </button>
      <div
        ref={props.progressRef}
        className="wr-progress"
        role={props.sliderReady ? "slider" : undefined}
        aria-hidden={props.sliderReady ? undefined : "true"}
        aria-label={props.sliderReady ? "阅读进度" : undefined}
        aria-valuemin={props.sliderReady ? 0 : undefined}
        aria-valuemax={props.sliderReady ? 100 : undefined}
        aria-valuenow={props.sliderReady ? Math.round(props.fill * 100) : undefined}
        tabIndex={props.sliderReady ? 0 : undefined}
        data-dragging={props.dragging ? "" : undefined}
        onKeyDown={props.onProgressKeyDown}
        onPointerDown={props.onProgressPointerDown}
        onPointerMove={props.onProgressPointerMove}
        onPointerUp={props.onProgressPointerEnd}
        onPointerCancel={props.onProgressPointerEnd}
        style={props.sliderReady ? { cursor: "pointer", touchAction: "none", position: "relative" } : undefined}
      >
        <div style={{ "--wr-fill": String(props.fill) } as React.CSSProperties} />
        {props.sliderReady ? (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              top: "50%",
              // 收进 [5px, 100%-5px]，避免轨道 overflow:hidden 在两端裁掉把手半圆
              left: `calc(5px + (100% - 10px) * ${props.fill})`,
              transform: "translate(-50%, -50%)",
              width: 10,
              height: 10,
              borderRadius: 999,
              background: "var(--wr-accent)",
            }}
          />
        ) : null}
      </div>
      <div className="wr-muted" style={{ fontVariantNumeric: "tabular-nums" }}>
        {props.pageText}
      </div>
    </div>
  );
});

/**
 * 进书加载：纸面中央一枚不断翻动的书页 + 文案。绝对定位浮在纸面上，不占布局（原先的加载块在文档流里，
 * 换成正文时纸面尺寸会跳）；内容就绪后加载层淡出、正文同步淡入，不再是「加载块 → 正文」硬切。
 * 收尾动画结束后才卸载；「减少动态效果」下没有 animationend，靠 CSS 直接隐藏 .is-done。
 */
function BookLoader({ show, text, sub }: { show: boolean; text: string; sub?: string }) {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) setMounted(true);
  }, [show]);
  if (!mounted) return null;
  return (
    <div
      className={`wr-book-loading${show ? "" : " is-done"}`}
      role="status"
      aria-live="polite"
      onAnimationEnd={(e) => {
        if (!show && e.animationName === "wr-book-loading-out") setMounted(false);
      }}
    >
      <div className="wr-book-loading-mark" aria-hidden="true">
        <i />
      </div>
      <div className="wr-book-loading-text">{text}</div>
      {sub ? <div className="wr-state-sub">{sub}</div> : null}
    </div>
  );
}

export default function ReaderPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { bookId } = useParams();
  const theme = useTheme();
  const [book, setBook] = useState<Book | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [tocLoading, setTocLoading] = useState(true);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [errorCopied, setErrorCopied] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [annotationsLoaded, setAnnotationsLoaded] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(defaultSettings);
  const [imageSettings, setImageSettings] = useState<ImageReaderSettings>(defaultImageReaderSettings);
  // 批次16：阅读设置按格式分离——漫画 image_reader_settings / PDF pdf_reader_settings 各自独立记忆
  const [pdfSettings, setPdfSettings] = useState<ImageReaderSettings>(defaultImageReaderSettings);
  // E2 按书记忆：imgset:<bookId> 覆盖键（rtl/layout/fit/webtoonWidth/doubleOffset），叠加在全局默认之上
  const [imgOverride, setImgOverride] = useState<ImageSettingsOverride>({});
  // #3 排版按书记忆：epuset:<bookId> 覆盖键（字号/行距/排版细项），叠加在全局默认之上（字体族不进书级）
  const [epuOverride, setEpuOverride] = useState<EpubSettingsOverride>({});
  // #5 TTS 语速（全局键 ttsRate）与 #7 背景纱浓度（全局键 bg_veil）
  const [ttsRate, setTtsRate] = useState(1);
  const [bgVeil, setBgVeil] = useState(88);
  const [ttsOn, setTtsOn] = useState(false);
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [imagePage, setImagePage] = useState<{ page: number; pageCount: number } | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>(initialSideTab);
  // E-1 已删书死胡同：getBook null（或 90s 仍无书）→ 可返回书库的错误态，不再永久加载
  const [bookGone, setBookGone] = useState(false);
  // B-2 大书守卫：>64MB 且 .opt 缺失 → "生成优化副本"占位进度（done/total），完成自动重试开书
  const [optProgress, setOptProgress] = useState<{ done: number; total: number } | null>(null);
  // 进书正文入场：加载结束的那一刻给叶片挂一段淡入（与加载层的淡出交叉），播完撤类
  const [bookEnter, setBookEnter] = useState(false);
  const bookWasLoadingRef = useRef(false);
  useEffect(() => {
    if (readerError) return;
    if (!book || tocLoading || optProgress) {
      bookWasLoadingRef.current = true;
      return;
    }
    if (!bookWasLoadingRef.current) return;
    bookWasLoadingRef.current = false;
    setBookEnter(true);
    const t = window.setTimeout(() => setBookEnter(false), 700);
    return () => window.clearTimeout(t);
  }, [book, tocLoading, optProgress, readerError]);
  // P-1：iframe 内 img 点击 → 全屏 Lightbox（src=当前 blob，rendition 存续期内有效，关闭不 revoke）
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  // V-1：原书音视频清单（非空才显示媒体 tab；非 epub 后端返回空数组）
  const [media, setMedia] = useState<MediaEntry[] | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [favoriteQuotes, setFavoriteQuotes] = useState<FavoriteQuote[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selection, setSelection] = useState<{ cfiRange: string; text: string; rect: SelectionRect | null } | null>(null);
  const [noteDraft, setNoteDraft] = useState<{ cfiRange: string; text: string } | null>(null);
  const [noteText, setNoteText] = useState("");
  const [chapterHref, setChapterHref] = useState("");
  const [pageBadge, setPageBadge] = useState<{ left: { page: number; total: number } | null; right: { page: number; total: number } | null }>({ left: null, right: null });
  // B12 全局"位置页"（估算，1024 字/页粒度）：locations 就绪后 X/Y 全书页码；未就绪回退章内页码
  const [locPage, setLocPage] = useState<{ index: number; total: number } | null>(null);
  const [lockToast, setLockToast] = useState(false);
  const [speedToast, setSpeedToast] = useState<number | null>(null);
  // B13 滚动模式章续读提示（"已进入 <章名>"1.5s）
  const [chapterToast, setChapterToast] = useState<string | null>(null);
  // E-1（U-14 分区）阅读正文右键菜单：复制/全选（与划词工具条同源的 clipboard 通道）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const [pagerHover, setPagerHover] = useState<"left" | "right" | null>(null);
  const [locationsReady, setLocationsReady] = useState(false);
  const [dragPct, setDragPct] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const speedToastTimerRef = useRef<number | null>(null);
  const chapterToastTimerRef = useRef<number | null>(null);
  const pendingChapterToastRef = useRef(false);
  const viewerSize = useElementSize(viewerRef);
  const controllerRef = useRef<ReaderController | null>(null);
  const settingsRef = useRef<ReaderSettings>(settings);
  const spreadModeRef = useRef<"none" | "always">("none");
  const locationSearchRef = useRef(location.search);
  const persistTimerRef = useRef<number | null>(null);
  const lastCfiRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  const settingsTouchedRef = useRef(false);
  const searchSeqRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const wheelCooldownRef = useRef(0);
  const wheelAccumRef = useRef(0);
  // "先画完再滑入"翻页：入场动画的清理定时器（连按时第一步 clearTimeout 抢占，消灭定时器打架）
  const animTimerRef = useRef(0);
  // V-1 快照翻页：翻页队列与正在播的这一次（动画期间再翻 → interrupt 让它立刻收尾）
  const turnQueueRef = useRef<((dir: 1 | -1) => void) | null>(null);
  const turnRef = useRef<TurnHandle | null>(null);
  const leafRef = useRef<HTMLDivElement | null>(null);
  const imageApiRef = useRef<PageReaderApi | null>(null);
  // B-2：大书守卫的生成等待次数（生成失败也发 done==total → 无限重试死循环，2 次后放行直开走错误态）
  const optRetriesRef = useRef(0);
  // E2：本书覆盖键被面板改过后置位，防迟到的 getSettings 回读覆盖用户刚写的值
  const imgOverrideTouchedRef = useRef(false);
  // #3：epuset 覆盖键同款防回读覆盖；生效排版（全局←书级）与覆盖键的 ref 镜像供稳定回调取用
  const epuOverrideTouchedRef = useRef(false);
  const epuOverrideRef = useRef<EpubSettingsOverride>({});
  const epubSettingsRef = useRef<ReaderSettings>(defaultSettings);
  // 漫画/PDF 皆为"视觉书"：webtoon=原生滚动容器（条漫/PDF 连续滚动共用 webtoon 枚举，滚轮转发不翻页）；
  // 批次15 起空格自动滚动对 PDF 连续滚动同样开放
  const imageCtxRef = useRef({ active: false, rtl: false, webtoon: false, autoscroll: false });
  const progressRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  // 自定义字体 @font-face css（iframe 注入源）：首显前备好，content hook 同步取用
  const fontFaceCssRef = useRef<string | null>(null);
  // 沉浸 chrome（B12 精简版）：显示=指针进顶/底热区（无延迟）；隐藏=离开热区与栏 1.2s / 翻页动作即收 /
  // 开始选字或打开抽屉、错误浮层（disabled=栏隐藏）；锁定=全藏+热区禁用。单击正文不承担收栏职责。
  const chrome = useImmersiveChrome({ disabled: drawerOpen || !!readerError || bookGone || !!selection || !!noteDraft });

  // E 线全局纯化（右键/拖影/残留快捷键）：阅读路由在壳外，独立安装（幂等）
  useEffect(() => installDesktopChrome(), []);

  // E-1 右键菜单：V-2 起行为层（外点/Esc/方向键/焦点）交 Radix Menu

  const contentDoc = () => containerRef.current?.querySelector("iframe")?.contentDocument ?? null;

  function onCtxCopy() {
    const text = contentDoc()?.getSelection?.()?.toString() ?? "";
    setCtxMenu(null);
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
  }

  function onCtxSelectAll() {
    setCtxMenu(null);
    const doc = contentDoc();
    const win = containerRef.current?.querySelector("iframe")?.contentWindow ?? null;
    if (!doc?.body || !win) return;
    const sel = win.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(doc.body);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  // H-2：切 tab 即写 sessionStorage（重开抽屉回到上次 tab；存储被禁仅失去记忆）
  const changeSideTab = useCallback((tab: SideTab) => {
    setSideTab(tab);
    try {
      sessionStorage.setItem(READER_TAB_KEY, tab);
    } catch {
      // 私密窗口等场景存储被禁：仅失去记忆，不影响功能
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // E-1 加载兜底：90s 仍无书（IPC 挂死等）也进 bookGone，防其它死等
    const bail = window.setTimeout(() => {
      if (!cancelled) setBookGone(true);
    }, 90_000);
    (async () => {
      // 单本直取（不再全库拉书后 find）
      const found = await getBook(bookId ?? "").catch(() => null);
      window.clearTimeout(bail);
      if (cancelled) return;
      setBook(found);
      setBookGone(!found);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(bail);
    };
  }, [bookId]);

  const viewerWidth = viewerSize.width || window.innerWidth;
  const viewerHeight = viewerSize.height || window.innerHeight;
  const spreadMode = resolveSpreadMode(settings.layoutMode, viewerWidth);
  const edgeRatio = viewerWidth >= 1400 ? 0.2 : viewerWidth >= 1100 ? 0.18 : 0.16;
  const stage = calcPaperStage({ viewerWidth, viewerHeight, margin: 18, edgeRatio });
  const isImageBook = book?.format === "images";
  const isPdfBook = book?.format === "pdf";
  // E-2：大部头（>64MB EPUB）加载文案提示（.opt 已有但首显仍慢的场景）
  const heavyEpub = !!book && bigEpubGuard(book.file_size, book.library_path);
  // 批次18：从书库书架进入时带 fromShelf state——返回回原书架；其它入口（收藏页）无 state 保持回根
  const fromShelf = (location.state as { fromShelf?: number | null } | null)?.fromShelf;
  // 漫画/PDF 共用视觉阅读管线（顶栏/热区/页码/书签）；分支差异只在设置面板与 api 来源
  const isVisualBook = isImageBook || isPdfBook;

  // E-1/E-2 epub 正文右键与选中色：正文渲染在 epubjs iframe 里，宿主全局监听与 CSS 都够不着——
  // 观察 iframe 增删逐个接线；右键=复制/全选（贴光标，坐标换算宿主视口），::selection 注主题 accent 色
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !book || isVisualBook) return;
    const accent = getComputedStyle(readerRootRef.current ?? document.documentElement)
      .getPropertyValue("--wr-accent-rgb")
      .trim();
    const rgb = accent || "22, 24, 26";
    const attach = (iframe: HTMLIFrameElement) => {
      const doc = iframe.contentDocument;
      if (!doc?.head || !doc.body) return;
      let style = doc.getElementById("wr-iframe-chrome") as HTMLStyleElement | null;
      if (!style) {
        style = doc.createElement("style");
        style.id = "wr-iframe-chrome";
        doc.head.appendChild(style);
        doc.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const text = doc.getSelection?.()?.toString() ?? "";
          const r = iframe.getBoundingClientRect();
          setCtxMenu({ x: r.left + e.clientX, y: r.top + e.clientY, hasSelection: !!text.trim() });
        });
      }
      style.textContent = `::selection{background:rgba(${rgb},0.30)}`;
    };
    const scan = () => root.querySelectorAll("iframe").forEach(attach);
    const mo = new MutationObserver(scan);
    mo.observe(root, { childList: true, subtree: true });
    scan();
    return () => mo.disconnect();
  }, [book?.id, isVisualBook, theme]);
  // 当前视觉书生效设置与持久化键（漫画/PDF 两份全局 state，同 UI 受控切换，互不影响）；
  // E2：生效值 = 全局默认 ← imgset:<bookId> 书级覆盖（面板显示并改的是生效值）
  const visualSettings = useMemo(
    () => resolveImageSettings(isPdfBook ? pdfSettings : imageSettings, imgOverride),
    [isPdfBook, pdfSettings, imageSettings, imgOverride],
  );
  // #3：生效排版 = 全局 ReaderSettings ← epuset:<bookId> 书级覆盖（设置面板显示并改的是生效值）
  const epubSettings = useMemo(() => resolveEpubSettings(settings, epuOverride), [settings, epuOverride]);
  const visualSettingsKey = isPdfBook ? "pdf_reader_settings" : "image_reader_settings";
  const imageEdgeSwap = isImageBook && visualSettings.rtl;
  const pagerEnabled =
    !drawerOpen &&
    !readerError &&
    !selection &&
    !noteDraft &&
    (isVisualBook || settings.readingMode === "paginated") &&
    !(isVisualBook && visualSettings.mode === "webtoon");

  const flatToc = useMemo(() => {
    const out: TocItem[] = [];
    const walk = (xs: TocItem[]) => {
      for (const x of xs) {
        out.push(x);
        if (x.subitems?.length) walk(x.subitems);
      }
    };
    walk(toc);
    return out;
  }, [toc]);

  // 章名随 relocated 更新；toc 晚到时 memo 重算自动补上
  const chapterTitle = useMemo(() => tocLabelFor(flatToc, chapterHref) ?? "正文", [flatToc, chapterHref]);

  const searchRows = useMemo(
    () => searchResults.map((r) => ({ ...r, chapter: tocLabelFor(flatToc, r.sectionHref) ?? "正文" })),
    [searchResults, flatToc],
  );

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    epuOverrideRef.current = epuOverride;
  }, [epuOverride]);

  useEffect(() => {
    epubSettingsRef.current = epubSettings;
  }, [epubSettings]);

  useEffect(() => {
    spreadModeRef.current = spreadMode;
  }, [spreadMode]);

  useEffect(() => {
    const continuous = isVisualBook && visualSettings.mode === "webtoon";
    imageCtxRef.current = {
      active: isVisualBook,
      rtl: isImageBook && visualSettings.rtl,
      webtoon: continuous,
      autoscroll: continuous,
    };
  }, [isVisualBook, isImageBook, visualSettings]);

  useEffect(() => {
    locationSearchRef.current = location.search;
  }, [location.search]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map = await getSettings();
      if (cancelled) return;
      if (settingsTouchedRef.current) return;
      applyPersistedTheme(map.theme);
      const fontSizePercent = Number(map.fontSizePercent ?? defaultSettings.fontSizePercent);
      const pageAnimation = normalizePageAnimation(map.pageAnimation);
      const layoutMode = normalizeLayoutMode(map.layoutMode);
      const lineHeight = normalizeLineHeight(map.lineHeight);
      const fontFamily = normalizeFontFamily(map.fontFamily);
      setSettings({
        fontSizePercent: Number.isFinite(fontSizePercent)
          ? Math.min(200, Math.max(80, fontSizePercent))
          : defaultSettings.fontSizePercent,
        pageAnimation,
        turnSpeedMs: normalizeTurnSpeedMs(map.turnSpeedMs),
        layoutMode,
        lineHeight,
        fontFamily,
        fontWeight: normalizeFontWeight(map.fontWeight),
        letterSpacing: normalizeLetterSpacing(map.letterSpacing),
        paragraphSpacing: normalizeParagraphSpacing(map.paragraphSpacing),
        textIndent: normalizeTextIndent(map.textIndent),
        pageMargin: normalizePageMargin(map.pageMargin),
        justify: map.justify === "true",
        readingMode: normalizeReadingMode(map.readingMode),
        reader_bg: normalizeReaderBackground(map.reader_bg),
        reader_font: normalizeReaderFont(map.reader_font),
      });
      setTtsRate(normalizeTtsRate(map.ttsRate));
      setBgVeil(normalizeBgVeil(map.bg_veil));
      setImageSettings(normalizeImageReaderSettings(map.image_reader_settings));
      // 批次16 旧数据迁移：pdf_reader_settings 缺失时继承 image_reader_settings（用户调过的值继承一次），此后独立演化
      setPdfSettings(normalizeImageReaderSettings(map.pdf_reader_settings ?? map.image_reader_settings));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // E2/#3：随书加载 imgset:<bookId> 与 epuset:<bookId> 覆盖键（换书路由参数变化不重挂本页，按 bookId 重载）
  useEffect(() => {
    let cancelled = false;
    imgOverrideTouchedRef.current = false;
    epuOverrideTouchedRef.current = false;
    optRetriesRef.current = 0; // 换书重置大书守卫重试配额
    setImgOverride({});
    setEpuOverride({});
    if (!bookId) return;
    void getSettings()
      .then((m) => {
        if (cancelled) return;
        if (!imgOverrideTouchedRef.current) setImgOverride(parseImageSettingsOverride(m[imageSettingsKey(bookId)]));
        if (!epuOverrideTouchedRef.current) setEpuOverride(parseEpubSettingsOverride(m[epubSettingsKey(bookId)]));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // V-1 媒体清单：书加载后查一次（仅有多媒体的书显示媒体 tab；失败按无媒体处理）
  useEffect(() => {
    setMedia(null);
    if (!book || isVisualBook) return;
    let cancelled = false;
    void listBookMedia(book.id)
      .then((m) => {
        if (!cancelled) setMedia(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [book?.id, isVisualBook]);

  useEffect(() => {
    let cancelled = false;
    let unlistenOpt: (() => void) | null = null;
    (async () => {
      if (!book) return;
      if (book.format === "images" || book.format === "pdf") {
        setImagePage(null);
        lastCfiRef.current = null; // 换书后旧 CFI 不得进 img 书签/进度
        setTocLoading(false);
        // B4: 漫画书签复用 BookmarksPanel，加载 img:N 书签并放行 loaded 态
        try {
          const bm = await listBookmarks(book.id);
          if (cancelled) return;
          setBookmarks(bm);
        } catch (e) {
          logFrontend(`reader: bookmarks load failed ${book.id} ${String(e)}`);
        }
        setAnnotationsLoaded(true);
        return;
      }

      // B-2 大书守卫：>64MB EPUB 先补生成 .opt——原书直开会内存失控 → 冻结 → 强杀 → 补生成被反复中断
      // 的死循环。optimizeEpubNow 返回 false（.opt 已有/无图可优化）→ 正常开书；true → 挂"生成中"占位，
      // 监听 epub-opt-progress，done==total 后 bump retryKey 重跑本 effect 自动开书。
      if (bigEpubGuard(book.file_size, book.library_path) && optRetriesRef.current < 2) {
        const started = await optimizeEpubNow(book.id).catch(() => false);
        if (cancelled) return;
        if (started) {
          optRetriesRef.current += 1;
          setOptProgress({ done: 0, total: 0 });
          try {
            unlistenOpt = await listen<{ done: number; total: number }>("epub-opt-progress", (e) => {
              if (cancelled) return;
              const p = e.payload;
              setOptProgress({ done: p.done, total: p.total });
              if (p.total > 0 && p.done >= p.total) setRetryKey((k) => k + 1);
            });
          } catch (e) {
            logFrontend(`reader: opt progress listen failed ${String(e)}`);
          }
          if (cancelled) unlistenOpt?.();
          return;
        }
      }
      setOptProgress(null);

      if (!containerRef.current) return;

      const container = containerRef.current;
      container.innerHTML = "";
      setReaderError(null);
      setLocationsReady(false);
      setDragPct(null);
      setPageBadge({ left: null, right: null });
      setLocPage(null);
      setChapterHref("");
      restoredRef.current = false;
      setAnnotationsLoaded(false);
      setToc([]);
      setTocLoading(true);

      const onRelocated = (payload: RelocatedPayload) => {
        if (cancelled) return;
        const { cfi, percent, href } = payload;
        lastCfiRef.current = cfi;
        setChapterHref(href);
        if (typeof percent === "number") setPercent(percent);
        setDragPct(null);
        setSelection(null);
        // 视觉页码徽标：优先全局"位置页"（B12，locations 估算 1024 字/页）；paginated 无 locPage 时回退章内页码
        setLocPage(payload.locPage ?? null);
        if (settingsRef.current.readingMode === "paginated" && !payload.locPage) {
          const left = payload.pageStart;
          const right =
            payload.pageEnd && (payload.endSectionIndex !== payload.sectionIndex || payload.pageEnd.page !== left?.page) ? payload.pageEnd : null;
          setPageBadge({ left, right });
        } else {
          setPageBadge({ left: null, right: null });
        }
        if (!restoredRef.current) return;

        if (persistTimerRef.current) {
          window.clearTimeout(persistTimerRef.current);
        }
        persistTimerRef.current = window.setTimeout(() => {
          const lastCfi = lastCfiRef.current;
          if (!lastCfi) return;
          void upsertReadingState(book.id, lastCfi, typeof percent === "number" ? percent : null);
        }, 1500);
      };

      const onTocLoaded = (toc: TocItem[]) => {
        if (cancelled) return;
        setToc(toc);
        setTocLoading(false);
      };

      const onError = (msg: string) => {
        logFrontend(`reader: onError ${book.id} ${msg}`);
        if (cancelled) return;
        setReaderError(msg);
        setTocLoading(false);
      };

      const onSelected = ({ cfiRange, text, rect }: { cfiRange: string; text: string; rect: SelectionRect | null }) => {
        if (cancelled) return;
        if (!text.trim()) {
          setSelection(null);
          return;
        }
        setSelection({ cfiRange, text, rect });
      };

      let ctrl: ReaderController | null = null;
      // #3：首显即按书级生效值排版（epuset 晚到由 effect 推送兜底）
      const eff = resolveEpubSettings(settingsRef.current, epuOverrideRef.current);
      try {
        // 恢复目标先取（URL cfi > 阅读状态），首显直达恢复点——旧路径先渲第 1 章再 display 恢复 CFI，开书双渲染闪跳
        const cfiFromUrl = new URLSearchParams(locationSearchRef.current).get("cfi");
        let initialTarget: string | undefined = cfiFromUrl ?? undefined;
        if (!initialTarget) {
          const state = await getReadingState(book.id).catch(() => null);
          if (cancelled) return;
          if (state?.cfi) {
            initialTarget = state.cfi;
            if (typeof state.percent === "number") setPercent(state.percent);
          }
        }
        // 自定义字体 css 首显前备好（content hook 同步注入 iframe；就绪前渲染会用回退字体分页）
        try {
          fontFaceCssRef.current = await readerFontFaceCss(settingsRef.current.reader_font);
        } catch (e) {
          fontFaceCssRef.current = null;
          logFrontend(`reader: font load failed ${String(e)}`);
        }
        if (cancelled) return;
        restoredRef.current = true;
        logFrontend(`reader: create ${book.id} ${book.library_path}`);
        ctrl = await createReader({
          container,
          libraryPath: book.library_path,
          spreadMode: spreadModeRef.current,
          readingMode: settingsRef.current.readingMode,
          lineHeight: eff.lineHeight,
          fontFamily: eff.fontFamily,
          typography: {
            fontWeight: eff.fontWeight,
            letterSpacing: eff.letterSpacing,
            paragraphSpacing: eff.paragraphSpacing,
            textIndent: eff.textIndent,
            pageMargin: eff.pageMargin,
            justify: eff.justify,
          },
          initialTarget,
          bookId: book.id,
          locationsKey: () => locationsCacheKey(epubSettingsRef.current.fontFamily, epubSettingsRef.current.fontSizePercent),
          fontFaceCss: () => fontFaceCssRef.current,
          onRelocated,
          onTocLoaded,
          onSelected,
          onLocationsReady: () => {
            if (!cancelled) setLocationsReady(true);
          },
          // iframe 内按下（含开始新选区）即收起旧气泡；B12：单击正文不再承担收栏职责（与点击翻页/选字冲突）
          onContentsPress: () => {
            setSelection(null);
          },
          // P-1：iframe 内 img 点击 → 全屏 Lightbox（reader.ts content hook 挂的监听）
          onImageClick: (p) => setLightbox(p),
          onError,
        });
      } catch (e) {
        logFrontend(`reader: create failed ${book.id} ${String(e)}`);
        if (cancelled) return;
        setReaderError(String(e));
        setTocLoading(false);
        return;
      }

      if (cancelled) {
        ctrl.destroy();
        return;
      }

      controllerRef.current = ctrl;
      ctrl.setTheme(getTheme());
      ctrl.setFontSizePercent(eff.fontSizePercent);
      ctrl.setLineHeight(eff.lineHeight);
      if (settingsRef.current.readingMode !== "scrolled") ctrl.setSpreadMode(spreadModeRef.current);

      try {
        const [bm, hl, fav] = await Promise.all([
          listBookmarks(book.id),
          listHighlights(book.id),
          listFavoriteQuotes({ bookId: book.id }),
        ]);
        if (cancelled) return;
        setBookmarks(bm);
        setHighlights(hl);
        setFavoriteQuotes(fav);
        for (const h of hl) {
          ctrl.addHighlight(h.cfi_range);
        }
      } catch (e) {
        logFrontend(`reader: annotations load failed ${book.id} ${String(e)}`);
      }
      setAnnotationsLoaded(true);
    })();

    return () => {
      cancelled = true;
      unlistenOpt?.();
      unlistenOpt = null;
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      // 换书/重开清掉翻页动画定时器（controller 销毁后 run() 不会再 resolve）；翻页标记一并兜底清掉
      window.clearTimeout(animTimerRef.current);
      delete document.documentElement.dataset.wrTurn;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [book?.id, retryKey]);

  useEffect(() => {
    if (!book) return;
    const flush = () => {
      const cfi = lastCfiRef.current;
      if (!cfi) return;
      void upsertReadingState(book.id, cfi, null);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [book?.id]);

  // E3 阅读时长：页面可见且窗口聚焦时每秒累计，满 60s 落库一次；隐藏/失焦/关书补一次尾款（秒数取整）。
  // S-1：Tauri 最小化不触发 WebView visibilitychange——判据加 document.hasFocus()，另听原生窗口焦点
  // （blur 含最小化即停并 flush 尾款；复焦自然续计），与微信读书同语义：窗口不在前台就不算阅读。
  useEffect(() => {
    if (!book) return;
    const readSecondsRef = { current: 0 };
    const flush = () => {
      const s = Math.floor(readSecondsRef.current);
      if (s <= 0) return;
      readSecondsRef.current -= s;
      void addReadingTime(book.id, s);
    };
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus()) readSecondsRef.current += 1;
      if (readSecondsRef.current >= 60) flush();
    }, 1000);
    const onVisibility = () => {
      if (document.visibilityState !== "visible") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    let disposed = false;
    let unFocus: (() => void) | null = null;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) flush();
      })
      .then((f) => {
        if (disposed) f();
        else unFocus = f;
      })
      .catch((e) => logFrontend(`reader: focus listen failed ${String(e)}`));
    return () => {
      disposed = true;
      unFocus?.();
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [book?.id]);

  useEffect(() => {
    if (!controllerRef.current) return;
    controllerRef.current.setTheme(theme);
    controllerRef.current.setFontSizePercent(epubSettings.fontSizePercent);
    controllerRef.current.setLineHeight(epubSettings.lineHeight);
    controllerRef.current.setFontFamily(epubSettings.fontFamily);
    controllerRef.current.setTypography({
      fontWeight: epubSettings.fontWeight,
      letterSpacing: epubSettings.letterSpacing,
      paragraphSpacing: epubSettings.paragraphSpacing,
      textIndent: epubSettings.textIndent,
      pageMargin: epubSettings.pageMargin,
      justify: epubSettings.justify,
    });
    // scrolled 模式下分栏失效，跳过 spread 以免与 epubjs scrolled 冲突
    if (settings.readingMode !== "scrolled") controllerRef.current.setSpreadMode(spreadMode);
  }, [
    theme,
    epubSettings.fontSizePercent,
    epubSettings.lineHeight,
    epubSettings.fontFamily,
    epubSettings.fontWeight,
    epubSettings.letterSpacing,
    epubSettings.paragraphSpacing,
    epubSettings.textIndent,
    epubSettings.pageMargin,
    epubSettings.justify,
    settings.layoutMode,
    spreadMode,
    settings.readingMode,
  ]);

  // 字号/行距/字体/排版细项变化后重排：章内页码（displayed.total）随新分页更新
  // （v2.5 补 fontFamily：换字体不重排会用旧字体的分页度量，页码/翻页错位；v2.6 排版细项同因）
  useEffect(() => {
    controllerRef.current?.resize();
  }, [
    epubSettings.fontSizePercent,
    epubSettings.lineHeight,
    epubSettings.fontFamily,
    epubSettings.fontWeight,
    epubSettings.letterSpacing,
    epubSettings.paragraphSpacing,
    epubSettings.textIndent,
    epubSettings.pageMargin,
    epubSettings.justify,
  ]);

  useEffect(() => {
    controllerRef.current?.setReadingMode(settings.readingMode);
  }, [settings.readingMode]);

  // 阅读纸面叠加全局背景（单槽缓存与壳共用）；preset 时缓存一并释放
  useEffect(() => {
    if (isVisualBook) {
      setBgUrl(null);
      return;
    }
    let cancelled = false;
    getBackgroundUrl(settings.reader_bg)
      .then((url) => {
        if (!cancelled) setBgUrl(url);
      })
      .catch((e) => {
        logFrontend(`reader: bg load failed ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [settings.reader_bg, isVisualBook]);

  // B11→v2.5：自定义正文字体注入 epubjs iframe（宿主 @font-face 对 iframe 无效）；
  // css 晚于当前渲染就绪时（换字体/装字体）补一次重排，正文按新字体重新分页
  useEffect(() => {
    let cancelled = false;
    readerFontFaceCss(settings.reader_font)
      .then((css) => {
        if (cancelled) return;
        const prev = fontFaceCssRef.current;
        fontFaceCssRef.current = css;
        if (prev !== css && controllerRef.current) controllerRef.current.resize();
      })
      .catch((e) => logFrontend(`reader: font load failed ${String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [settings.reader_font]);

  // #5 TTS 朗读一期：状态订阅驱动顶栏钮高亮；翻章/关书（卸载）/切抽屉自动停。
  // 无跟随高亮——一期明确不做（需 CFI↔段落映射与实时重排）。
  const ttsAvailable = ttsSupported();
  useEffect(() => subscribeTts(() => setTtsOn(ttsSpeaking())), []);
  useEffect(() => {
    ttsStop();
  }, [chapterHref]);
  useEffect(() => {
    if (drawerOpen) ttsStop();
  }, [drawerOpen]);
  useEffect(() => () => ttsStop(), []);
  const toggleSpeak = useCallback(() => {
    if (ttsSpeaking()) {
      ttsStop();
      return;
    }
    // 当前章正文（innerText 按块级元素分行，tts 内再按段切 utterance）
    const doc = containerRef.current?.querySelector("iframe")?.contentDocument;
    const text = doc?.body?.innerText ?? "";
    if (!text.trim()) return;
    speak(text, { rate: ttsRate });
  }, [ttsRate]);

  // #5/#7 全局独立键（ttsRate / bg_veil）：不走 ReaderSettings 批量管线
  const onTtsRateChange = useCallback((v: number) => {
    settingsTouchedRef.current = true;
    setTtsRate(v);
    void setSetting("ttsRate", String(v));
  }, []);
  const onBgVeilChange = useCallback((v: number) => {
    settingsTouchedRef.current = true;
    setBgVeil(v);
    void setSetting("bg_veil", String(v));
  }, []);

  // B12 固定预留：栏显隐只做淡入淡出、布局零变化（不再需要 visible-keyed resize）；
  // 仅锁定切换（padding 62↔0 的一次性 200ms 过渡）后补一次 epub 重排，保持分页正确
  useEffect(() => {
    if (isVisualBook) return;
    const t = window.setTimeout(() => controllerRef.current?.resize(), 220);
    return () => window.clearTimeout(t);
  }, [chrome.locked, isVisualBook]);

  useEffect(() => {
    if (!chrome.locked) return;
    setLockToast(true);
    const t = window.setTimeout(() => setLockToast(false), 2500);
    return () => window.clearTimeout(t);
  }, [chrome.locked]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName?.toLowerCase();
      const isTyping = tag === "input" || tag === "textarea" || active?.isContentEditable;

      if (e.ctrlKey && e.key.toLowerCase() === "f" && !imageCtxRef.current.active) {
        e.preventDefault();
        resetTurnStyles();
        changeSideTab("search");
        setDrawerOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }

      if (e.ctrlKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        chrome.setLocked(!chrome.locked);
        return;
      }

      if (e.ctrlKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        addBookmarkHere();
        changeSideTab("bookmarks");
        return;
      }

      // E7 字号快捷键：Ctrl+= / Ctrl+- / Ctrl+0（走设置面板同一条通道，钳 80-200；#3 书内改动按书钉住）
      if (e.ctrlKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
        e.preventDefault();
        const cur = epubSettingsRef.current.fontSizePercent;
        const v =
          e.key === "0"
            ? defaultSettings.fontSizePercent
            : Math.min(200, Math.max(80, cur + (e.key === "-" ? -5 : 5)));
        if (v === cur) return;
        changeSettingsRef.current({ ...epubSettingsRef.current, fontSizePercent: v });
        return;
      }

      // F11 已上提到 App 全局 keydown（批次19），此处不再处理避免双触发

      if (isTyping) return;

      if (imageCtxRef.current.active) {
        // B12 条漫：空格=自动滚动播放/暂停（缩放态、输入焦点除外，不再触发原生下跳）；
        // 播放中 ↑/↓=速度 ±10（实时生效+轻提示当前速度）——批次15 起 PDF 连续滚动同享空格自动滚动
        if (imageCtxRef.current.autoscroll && !imageApiRef.current?.zoomed?.()) {
          if (e.key === " ") {
            e.preventDefault();
            imageApiRef.current?.toggleAutoScroll();
            return;
          }
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && imageApiRef.current?.autoActive?.()) {
            e.preventDefault();
            nudgeAutoScrollSpeed(e.key === "ArrowUp" ? 10 : -10);
            return;
          }
        }
        const imageDir = turnKeyDirection(e.key, imageCtxRef.current.rtl);
        if (imageDir) {
          e.preventDefault();
          chrome.dismiss(); // B12：翻页动作即收栏（栏可见时）
          void animateTurn(imageDir);
          return;
        }
      } else if (
        !imageCtxRef.current.active &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "PageUp" || e.key === "PageDown")
      ) {
        // 分页=翻页；滚动模式 Arrow 仍整章跳（animateTurn 分流）
        e.preventDefault();
        chrome.dismiss(); // B12：翻页动作即收栏（栏可见时）
        // B13 滚动模式 PageDown/PageUp：章末/章首即时章导航，章中原生滚一屏（键盘优先，不等 400ms 防抖）
        if (settingsRef.current.readingMode !== "paginated" && (e.key === "PageDown" || e.key === "PageUp")) {
          const delta = e.key === "PageDown" ? 1 : -1;
          if (controllerRef.current && !controllerRef.current.scrollStep(delta)) {
            showEdgeHint(readerRootRef.current, delta > 0 ? "next" : "prev", "chapter");
          }
          return;
        }
        void animateTurn(e.key === "ArrowLeft" || e.key === "PageUp" ? "prev" : "next");
        return;
      }

      if (e.key === "Escape") {
        // Esc 顺序语义：关抽屉 > 解除锁定 > 唤醒栏 > 无操作
        if (drawerOpen) {
          e.preventDefault();
          resetTurnStyles();
          setDrawerOpen(false);
          return;
        }
        if (chrome.locked) {
          e.preventDefault();
          chrome.setLocked(false);
          return;
        }
        if (!chrome.visible) {
          e.preventDefault();
          chrome.wake();
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [book, drawerOpen, chrome, visualSettings, chapterTitle, settings.pageAnimation, settings.readingMode]);

  useEffect(() => {
    // B12：热区条上移到根级预留带（viewer overflow:hidden 会裁掉负偏移），滚轮监听同步挂根级
    const el = readerRootRef.current;
    if (!el) return;

    // 热区条盖住的顶/底 48px 带内，iframe/内嵌滚动收不到 wheel——接力给实际滚动容器
    const forwardHotzoneWheel = (e: WheelEvent, host: HTMLElement) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".wr-chrome-hotzone")) return;
      const scroller =
        containerRef.current?.querySelector<HTMLElement>(".epub-container") ??
        host.querySelector<HTMLElement>(".wr-image-webtoon");
      if (scroller) scroller.scrollTop += e.deltaY;
    };

    const onWheel = (e: WheelEvent) => {
      if (drawerOpen) return;
      // epub 滚动模式下 wheel 交给 iframe 原生滚动
      if (!imageCtxRef.current.active && settingsRef.current.readingMode !== "paginated") {
        forwardHotzoneWheel(e, el);
        return;
      }
      // 条漫原生滚动；B6 缩放态滚轮=平移（ImageReader 内部处理）；键盘/热区翻页走 turn 内先复位
      if (imageCtxRef.current.active && (imageCtxRef.current.webtoon || imageApiRef.current?.zoomed?.())) {
        forwardHotzoneWheel(e, el);
        return;
      }
      const now = Date.now();
      if (now - wheelCooldownRef.current < 300) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX) * 1.2) return;
      if (Math.abs(e.deltaY) < 10) return;
      e.preventDefault();
      const d = e.deltaY;
      if ((wheelAccumRef.current > 0 && d < 0) || (wheelAccumRef.current < 0 && d > 0)) {
        wheelAccumRef.current = 0;
      }
      wheelAccumRef.current += d;
      if (Math.abs(wheelAccumRef.current) < 60) return;
      wheelCooldownRef.current = now;
      const dir = wheelAccumRef.current > 0 ? "next" : "prev";
      wheelAccumRef.current = 0;
      chrome.dismiss(); // B12：滚轮翻页即收栏（栏可见时）
      void animateTurn(dir);
    };

    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [drawerOpen, settings.pageAnimation]);

  // B13 滚动模式章续读：滚到章末/章首持续 ~400ms 自动 display 下/上一章（保持 scrolled）+ 轻提示。
  // 章切换落位的程序性滚动（整屏级大跳）不参与判定，避免落位即回跳；短章按滚动方向续读。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || isVisualBook || settings.readingMode !== "scrolled" || drawerOpen) return;
    let timer: number | null = null;
    let lastTop = -1;
    let lastDelta = 1;
    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const onScroll = () => {
      const sc = el.querySelector<HTMLElement>(".epub-container");
      if (!sc || sc.clientHeight <= 0) return;
      const delta = sc.scrollTop - lastTop;
      lastTop = sc.scrollTop;
      if (Math.abs(delta) >= sc.clientHeight * 0.9) return; // display 落位整跳：只同步位置不判定
      if (delta !== 0) lastDelta = delta;
      clearTimer();
      const dir = scrollEdgeDirection(sc.scrollTop, sc.clientHeight, sc.scrollHeight, lastDelta);
      if (!dir) return;
      timer = window.setTimeout(() => {
        timer = null;
        const sc2 = el.querySelector<HTMLElement>(".epub-container");
        const ctrl = controllerRef.current;
        if (!sc2 || sc2.clientHeight <= 0 || !ctrl) return;
        if (scrollEdgeDirection(sc2.scrollTop, sc2.clientHeight, sc2.scrollHeight, lastDelta) !== dir) return;
        pendingChapterToastRef.current = true;
        ctrl.chapterNav(dir);
      }, 400);
    };
    el.addEventListener("scroll", onScroll, true);
    return () => {
      clearTimer();
      el.removeEventListener("scroll", onScroll, true);
    };
  }, [isVisualBook, settings.readingMode, drawerOpen]);

  // 章续读落位（relocated 更新 chapterHref）后弹 1.5s 轻提示
  useEffect(() => {
    if (!pendingChapterToastRef.current) return;
    pendingChapterToastRef.current = false;
    if (!chapterTitle) return;
    setChapterToast(chapterTitle);
    if (chapterToastTimerRef.current) window.clearTimeout(chapterToastTimerRef.current);
    chapterToastTimerRef.current = window.setTimeout(() => setChapterToast(null), 1500);
    return () => {
      if (chapterToastTimerRef.current) window.clearTimeout(chapterToastTimerRef.current);
    };
  }, [chapterTitle]);

  const persistSettings = useCallback(async (next: ReaderSettings) => {
    settingsTouchedRef.current = true;
    // 批量一次 IPC：逐键 setSetting 是 9 次串行调用（拖杆/多键保存时放大）
    await setSettingsBatch({
      fontSizePercent: String(next.fontSizePercent),
      pageAnimation: next.pageAnimation,
      turnSpeedMs: String(next.turnSpeedMs),
      layoutMode: next.layoutMode,
      lineHeight: String(next.lineHeight),
      fontFamily: next.fontFamily,
      fontWeight: String(next.fontWeight),
      letterSpacing: String(next.letterSpacing),
      paragraphSpacing: String(next.paragraphSpacing),
      textIndent: String(next.textIndent),
      pageMargin: String(next.pageMargin),
      justify: String(next.justify),
      readingMode: next.readingMode,
      reader_bg: JSON.stringify(next.reader_bg),
      reader_font: JSON.stringify(next.reader_font),
    });
  }, []);

  // B12 条漫播放中 ↑/↓ 调速：±10 并钳 20-240，实时写入设置（ImageReader autoSpeedRef 即时生效）+ 轻提示
  // E2：autoScrollSpeed 是全局字段（不在 imgset 书级键里），读写都走全局基值
  function nudgeAutoScrollSpeed(delta: number) {
    const base = isPdfBook ? pdfSettings : imageSettings;
    const speed = Math.min(240, Math.max(20, base.autoScrollSpeed + delta));
    const next = { ...base, autoScrollSpeed: speed };
    if (isPdfBook) setPdfSettings(next);
    else setImageSettings(next);
    settingsTouchedRef.current = true;
    void setSetting(visualSettingsKey, JSON.stringify(next));
    setSpeedToast(speed);
    if (speedToastTimerRef.current) window.clearTimeout(speedToastTimerRef.current);
    speedToastTimerRef.current = window.setTimeout(() => setSpeedToast(null), 1200);
  }

  // §8：高频回调 useCallback 稳定化——memo 子组件（ImageReader/顶栏/页脚）在 relocated/热区 bump 下不重渲
  const handleImageRelocated = useCallback(
    (page: number, pageCount: number) => {
      if (!book) return;
      const cfi = book.format === "pdf" ? pdfCfi(page) : imageCfi(page);
      const pct = pagePercent(page, pageCount);
      lastCfiRef.current = cfi;
      setPercent(pct);
      setImagePage({ page, pageCount });
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current);
      }
      persistTimerRef.current = window.setTimeout(() => {
        void upsertReadingState(book.id, cfi, pct);
      }, 1500);
    },
    [book],
  );

  // ═══ V-1 翻页（快照双叶；机制与实测边界见 src/reader/epub/turnFx.ts 与开发计划 V-1「方案改定」）═══
  // 队列：每次按键恰好一页；队列有积压时快进（只遮罩不播动画），队尾那次才播。
  // 动画期间再翻 → 打断当前动画直接续下一页（新态此时已捕获，不会露出未就绪的页面）。
  const resetTurnStyles = useCallback(() => {
    window.clearTimeout(animTimerRef.current);
    turnRef.current?.interrupt();
    const p = containerRef.current;
    if (p) {
      p.style.transition = "none";
      p.style.transform = "";
      p.style.opacity = "";
      p.style.clipPath = "";
    }
    if (viewerRef.current) {
      viewerRef.current.style.transition = "";
      viewerRef.current.style.opacity = "";
    }
  }, []);

  /** v3.1.8 路径（不支持 View Transitions 的老 WebView2）："先画完、再微幅滑入" */
  const legacyTurn = useCallback(async (ctrl: ReaderController, dir: 1 | -1, anim: PageAnimation, reduced: boolean) => {
    const paper = containerRef.current;
    const el = viewerRef.current;
    try {
      await (dir > 0 ? ctrl.next() : ctrl.prev());
    } catch (e) {
      logFrontend(`reader: turn failed ${dir} ${String(e)}`);
    }
    if (anim === "none" || reduced || !paper) return;
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const k = settingsRef.current.turnSpeedMs / 260;
    if (anim === "slide") {
      const inMs = Math.round(200 * k);
      paper.style.transition = "none";
      paper.style.transform = `translateX(${dir > 0 ? 24 : -24}px)`;
      paper.style.opacity = "0.85";
      void paper.offsetHeight;
      paper.style.transition = `transform ${inMs}ms ease-out, opacity ${Math.round(inMs * 0.5)}ms ease-out`;
      paper.style.transform = "translateX(0)";
      paper.style.opacity = "1";
      animTimerRef.current = window.setTimeout(resetTurnStyles, inMs + 50);
    } else if (el) {
      el.style.transition = "none";
      el.style.opacity = "0.3";
      void el.offsetHeight;
      el.style.transition = `opacity ${Math.round(180 * k)}ms ease`;
      el.style.opacity = "1";
      animTimerRef.current = window.setTimeout(resetTurnStyles, Math.round(180 * k) + 50);
    }
  }, [resetTurnStyles]);

  const doTurn = useCallback(async (dir: 1 | -1, fast: boolean) => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    resetTurnStyles();
    const anim = effectivePageAnimation(settingsRef.current.pageAnimation);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!viewTurnSupported()) {
      // shortcut: 老引擎回退路径不提示首 / 末页（拿不到「页面没变」信号）, 有老 WebView2 用户反馈再说
      await legacyTurn(ctrl, dir, anim, reduced);
      return;
    }
    const paper = containerRef.current?.closest<HTMLElement>(".wr-reader-paper");
    const body = containerRef.current?.querySelector("iframe")?.contentDocument?.body ?? null;
    const leaf = leafRef.current ?? containerRef.current;
    if (!leaf) return;
    let moved = true;
    const handle = runViewTurn({
      effect: anim,
      // 即使不播动画也走快照：旧页盖到新页就绪为止，跨章重建 iframe 的空窗不露白
      animate: !fast && !reduced && anim !== "none",
      duration: anim === "none" ? 0 : Math.round(TURN_EFFECT_MS[anim] * (settingsRef.current.turnSpeedMs / 260)),
      leaf,
      dark: DARK_THEMES.includes(document.documentElement.dataset.theme ?? ""),
      // 自定义背景图下没有纸面实色：不画折页高光
      paperColor: paper?.style.backgroundImage ? null : turnPaperColor(readerRootRef.current, body),
      commit: async () => {
        const r = await ctrl.turn(dir);
        moved = r.changed;
        return r;
      },
    });
    turnRef.current = handle;
    await handle.done;
    if (turnRef.current === handle) turnRef.current = null;
    ctrl.reportTurn();
    if (!moved) showEdgeHint(readerRootRef.current, dir > 0 ? "next" : "prev", "page");
  }, [legacyTurn, resetTurnStyles]);

  const animateTurn = useCallback(
    (direction: "next" | "prev") => {
      setSelection(null);
      setNoteDraft(null);
      const ctrl = controllerRef.current;
      const delta = direction === "next" ? 1 : -1;
      if (imageCtxRef.current.active) {
        // B6：翻页不再被缩放阻塞——ImageReader.turn 内部先复位缩放再翻
        if (imageApiRef.current && !imageApiRef.current.turn(direction)) showEdgeHint(readerRootRef.current, direction, "page");
        return;
      }
      // epub 滚动模式无分页语义：键盘/滚轮/热区统一改为上一章/下一章（wheel 仍留给 iframe 原生滚动）
      if (settingsRef.current.readingMode !== "paginated") {
        // V-13：已在首章 / 末章再翻 → 轻提示（下同）
        if (ctrl && !ctrl.chapterNav(delta)) showEdgeHint(readerRootRef.current, direction, "chapter");
        return;
      }
      turnQueueRef.current ??= createTurnQueue(doTurn, () => turnRef.current?.interrupt());
      turnQueueRef.current(delta);
    },
    [doTurn],
  );

  /** footer 上一章/下一章（epub 两模式统一；image 书 footer 仍是页翻，走 animateTurn） */
  const navChapter = useCallback((direction: "next" | "prev") => {
    setSelection(null);
    setNoteDraft(null);
    if (controllerRef.current && !controllerRef.current.chapterNav(direction === "next" ? 1 : -1)) {
      showEdgeHint(readerRootRef.current, direction, "chapter");
    }
  }, []);

  const openDrawer = useCallback(
    (tab: SideTab) => {
      // 开抽屉前清掉翻页动画残留（定时器+样式+未播完的快照），防阅读区"弹一下"、抽屉被快照盖住
      resetTurnStyles();
      changeSideTab(tab);
      setDrawerOpen(true);
      if (tab === "search") requestAnimationFrame(() => searchInputRef.current?.focus());
    },
    [changeSideTab, resetTurnStyles],
  );

  // B4: 书签统一入口——image 书记 img:N、PDF 记 pdf:N + "第N页"，epub 记 CFI + 章名
  function addBookmarkHere() {
    const cfi = lastCfiRef.current;
    if (!book || !cfi) return;
    const imgPage = imageCtxRef.current.active ? (parseImageCfi(cfi) ?? parsePdfCfi(cfi)) : null;
    void (async () => {
      const bm = await addBookmark(book.id, cfi, imgPage !== null ? `第${imgPage + 1}页` : chapterTitle);
      setBookmarks((prev) => (prev.some((x) => x.cfi === bm.cfi) ? prev : [bm, ...prev]));
    })();
  }

  const locate = useCallback((target?: string) => {
    setSelection(null);
    setNoteDraft(null);
    // B4: img:N / pdf:N 书签在视觉书模式分流到 goToPage（此时无 epub controller）
    const imgPage = imageCtxRef.current.active ? (parseImageCfi(target) ?? parsePdfCfi(target)) : null;
    if (imgPage !== null) {
      imageApiRef.current?.goToPage(imgPage);
      return;
    }
    void controllerRef.current?.display(target);
  }, []);

  // locations 就绪后进度条可拖/可点（点击=零位移拖动，同一路径）
  const sliderReady = locationsReady && !isVisualBook && !readerError;
  // 选区与现有高亮相交 → 气泡高亮钮切换为"取消高亮"
  const overlappingHighlights = selection ? highlights.filter((h) => cfiRangesOverlap(h.cfi_range, selection.cfiRange)) : [];

  const pctFromClientX = useCallback((clientX: number): number | null => {
    const el = progressRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return Math.min(0.999, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const seekTo = useCallback(
    (p: number) => {
      const ctrl = controllerRef.current;
      const cfi = ctrl?.progressCfi(p);
      if (!ctrl || !cfi) return;
      setSelection(null);
      setNoteDraft(null);
      // display 完成后清拖动态：relocated 与旧载荷值相同（拖回原位附近）时会被引用去重吞掉，不再负责清 dragPct
      void ctrl.display(cfi).finally(() => setDragPct(null));
    },
    [],
  );

  const onProgressKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!sliderReady) return;
      const base = dragPct ?? percent ?? 0;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekTo(Math.max(0, base - 0.01));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekTo(Math.min(0.999, base + 0.01));
      }
    },
    [sliderReady, dragPct, percent, seekTo],
  );

  const onProgressPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!sliderReady) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      draggingRef.current = true;
      const p = pctFromClientX(e.clientX);
      if (p !== null) setDragPct(p);
    },
    [sliderReady, pctFromClientX],
  );

  const onProgressPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const p = pctFromClientX(e.clientX);
      if (p !== null) setDragPct(p);
    },
    [pctFromClientX],
  );

  const onProgressPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const p = pctFromClientX(e.clientX);
      // 松手才 display（拖动仅更新视觉，避免高频 display 抖动）；跳转触发的 relocated 恢复持久化
      if (p !== null) seekTo(p);
    },
    [pctFromClientX, seekTo],
  );

  // 批次19：返回书架先退出窗口全屏（F11 态不带回书库）；fire-and-forget，不等 setFullscreen 落地再导航
  const backToLibrary = useCallback(() => {
    void (async () => {
      try {
        if (await getCurrentWindow().isFullscreen()) await getCurrentWindow().setFullscreen(false);
      } catch (e) {
        logFrontend(`reader: exit fullscreen failed ${String(e)}`);
      }
    })();
    navigate(typeof fromShelf === "number" ? `/?shelf=${fromShelf}` : "/");
  }, [fromShelf, navigate]);

  const drawerTitle =
    sideTab === "toc"
      ? "目录"
      : sideTab === "bookmarks"
        ? "书签"
        : sideTab === "highlights"
          ? "标注"
          : sideTab === "favorites"
            ? "收藏句子"
            : sideTab === "search"
              ? "搜索"
              : sideTab === "pages"
                ? "页面"
                : sideTab === "media"
                  ? "媒体"
                  : "阅读设置";

  // §8：页码徽标样式已迁 weread.css（wr-page-badge--left/--right），此处只留文案

  // §8：视觉书 api 回调稳定化（memo 的 ImageReader/PdfReader 不因无关重渲换引用）
  const handleImageApi = useCallback((api: ImageReaderApi) => {
    imageApiRef.current = api;
  }, []);
  const handlePdfApi = useCallback((api: PdfReaderApi) => {
    imageApiRef.current = api;
  }, []);
  // #3 排版按书记忆：面板显示/改的是生效值；被改的书级字段（epuset 八项）钉进 epuset:<bookId>，
  // 其余字段（翻页动画/速度/版式/字体族/阅读模式/背景/字体槽）仍写全局键，作为新书默认。
  const onSettingsPanelChange = useCallback(
    (next: ReaderSettings) => {
      const prevEff = epubSettingsRef.current;
      const o: EpubSettingsOverride = { ...epuOverrideRef.current };
      let overrideDirty = false;
      for (const k of EPUSET_FIELDS) {
        if (next[k] !== prevEff[k]) {
          (o as Record<typeof k, unknown>)[k] = next[k];
          overrideDirty = true;
        }
      }
      const base = settingsRef.current;
      const globalNext: ReaderSettings = {
        ...base,
        pageAnimation: next.pageAnimation,
        turnSpeedMs: next.turnSpeedMs,
        layoutMode: next.layoutMode,
        fontFamily: next.fontFamily,
        readingMode: next.readingMode,
        reader_bg: next.reader_bg,
        reader_font: next.reader_font,
      };
      setSettings(globalNext);
      void persistSettings(globalNext);
      if (overrideDirty) {
        epuOverrideTouchedRef.current = true;
        // ref 立即同步：同批次连续改动（拖杆连击）diff 不到旧 state 也不丢字段
        epuOverrideRef.current = o;
        epubSettingsRef.current = resolveEpubSettings(globalNext, o);
        setEpuOverride(o);
        void setSetting(epubSettingsKey(bookId ?? ""), JSON.stringify(o));
      }
    },
    [persistSettings, bookId],
  );
  const changeSettingsRef = useRef(onSettingsPanelChange);
  changeSettingsRef.current = onSettingsPanelChange;
  const onVisualSettingsChange = useCallback(
    (next: ImageReaderSettings) => {
      // E2：书级字段（rtl/layout/fit/webtoonWidth/doubleOffset）被改动才钉进 imgset:<bookId>（面板显示合并后的生效值）；
      // 其余字段（mode/pageAnimation/autoScrollSpeed）仍写全局键，作为新书默认
      const prev = visualSettings;
      const o: ImageSettingsOverride = { ...imgOverride };
      let overrideDirty = false;
      if (next.rtl !== prev.rtl) {
        o.rtl = next.rtl;
        overrideDirty = true;
      }
      if (next.layout !== prev.layout) {
        o.layout = next.layout;
        overrideDirty = true;
      }
      if (next.fit !== prev.fit) {
        o.fit = next.fit;
        overrideDirty = true;
      }
      if (next.webtoonWidth !== prev.webtoonWidth) {
        o.webtoonWidth = next.webtoonWidth;
        overrideDirty = true;
      }
      if (next.doubleOffset !== prev.doubleOffset) {
        o.doubleOffset = next.doubleOffset;
        overrideDirty = true;
      }
      const base = isPdfBook ? pdfSettings : imageSettings;
      const globalNext: ImageReaderSettings = {
        ...base,
        mode: next.mode,
        pageAnimation: next.pageAnimation,
        autoScrollSpeed: next.autoScrollSpeed,
      };
      const globalDirty =
        globalNext.mode !== base.mode ||
        globalNext.pageAnimation !== base.pageAnimation ||
        globalNext.autoScrollSpeed !== base.autoScrollSpeed;
      settingsTouchedRef.current = true;
      if (overrideDirty) {
        imgOverrideTouchedRef.current = true;
        setImgOverride(o);
        void setSetting(imageSettingsKey(bookId ?? ""), JSON.stringify(o));
      }
      if (globalDirty) {
        if (isPdfBook) setPdfSettings(globalNext);
        else setImageSettings(globalNext);
        void setSetting(visualSettingsKey, JSON.stringify(globalNext));
      }
    },
    [isPdfBook, visualSettingsKey, visualSettings, imgOverride, imageSettings, pdfSettings, bookId],
  );
  const toggleFavorite = useCallback(() => {
    if (!book) return;
    const next = !book.is_favorite;
    setBook({ ...book, is_favorite: next });
    void setBookFavorite(book.id, next);
  }, [book]);
  // G-1「设为我的默认」：当前生效的书级字段写回全局键（新书起点=当前习惯；本书覆盖不动，互不传染）
  const setEpubDefault = useCallback(() => {
    const globalNext = epubDefaultsFromEffective(settingsRef.current, epubSettingsRef.current);
    settingsTouchedRef.current = true;
    setSettings(globalNext);
    void persistSettings(globalNext);
  }, [persistSettings]);
  // G-2「本书恢复默认」：清 epuset:<bookId> 覆盖（空串即清——parse 对空/坏 JSON 回空覆盖）
  const resetEpubBook = useCallback(() => {
    epuOverrideTouchedRef.current = true;
    epuOverrideRef.current = {};
    epubSettingsRef.current = resolveEpubSettings(settingsRef.current, {});
    setEpuOverride({});
    void setSetting(epubSettingsKey(bookId ?? ""), "");
  }, [bookId]);
  const setVisualDefault = useCallback(() => {
    const base = isPdfBook ? pdfSettings : imageSettings;
    const globalNext = imageDefaultsFromEffective(base, visualSettings);
    settingsTouchedRef.current = true;
    if (isPdfBook) setPdfSettings(globalNext);
    else setImageSettings(globalNext);
    void setSetting(visualSettingsKey, JSON.stringify(globalNext));
  }, [isPdfBook, pdfSettings, imageSettings, visualSettings, visualSettingsKey]);
  const resetVisualBook = useCallback(() => {
    imgOverrideTouchedRef.current = true;
    setImgOverride({});
    void setSetting(imageSettingsKey(bookId ?? ""), "");
  }, [bookId]);
  // E4 标注导出：save 对话框（默认"标注-<书名>.md"）→ exportAnnotations 写出 Markdown
  const exportHighlights = useCallback(() => {
    void (async () => {
      if (!book) return;
      const safeName = (book.title ?? "未命名").replace(/[\\/:*?"<>|]/g, "_");
      const dest = await save({
        defaultPath: `标注-${safeName}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof dest !== "string") return;
      try {
        const written = await exportAnnotations(book.id, dest);
        await showAlert("导出成功", written);
      } catch (e) {
        await showAlert("导出失败", String(e));
      }
    })();
  }, [book]);
  const lockChrome = useCallback(() => chrome.setLocked(true), [chrome]);
  const footerTurn = useCallback(
    (direction: "prev" | "next") => {
      if (isVisualBook) void animateTurn(direction);
      else navChapter(direction);
    },
    [isVisualBook, animateTurn, navChapter],
  );

  return (
    <TooltipProvider>
    <div
      data-theme={theme}
      className="wr-reader-root"
      ref={readerRootRef}
      onContextMenu={(e) => {
        // E-1 宿主面（漫画/PDF/纸边距）右键只拦不出菜单；epub 文本视图给 复制/全选（输入框放行）
        if ((e.target as HTMLElement).closest?.("input, textarea, [contenteditable]")) return;
        e.preventDefault();
        if (!book || isVisualBook || drawerOpen || !!readerError || chrome.locked) return;
        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          hasSelection: !!(contentDoc()?.getSelection?.()?.toString().trim()),
        });
      }}
    >
      {!chrome.locked ? (
        <ReaderTopBar
          visible={chrome.visible}
          title={book?.title ?? "阅读"}
          percentText={typeof percent === "number" ? `${Math.round(percent * 100)}%` : ""}
          showEpubTools={!!book && !isImageBook}
          showVisualTools={isVisualBook && !!book}
          showMedia={!!media && media.length > 0}
          showTts={ttsAvailable && !!book && !isVisualBook}
          ttsOn={ttsOn}
          onToggleSpeak={toggleSpeak}
          isFavorite={!!book?.is_favorite}
          onBack={backToLibrary}
          onOpenDrawer={openDrawer}
          onToggleFavorite={toggleFavorite}
          onLock={lockChrome}
          onEnter={chrome.enter}
          onLeave={chrome.leave}
        />
      ) : null}

      {/* B12 固定预留：非锁定态 stage 恒定 padding 62px（栏在预留区内淡入淡出，内容零位移）；锁定态一次性收 0；
          B13 漫画：栏为悬浮玻璃条后无需让位，padding 恒 0（见 weread.css [data-image]） */}
      <div
        className="wr-reader-stage"
        data-locked={chrome.locked ? "true" : undefined}
        data-image={isVisualBook || undefined}
      >
        <div
          ref={viewerRef}
          className="wr-reader-viewer"
        >
          <Drawer
            open={drawerOpen}
            title={drawerTitle}
            onClose={() => {
              setDrawerOpen(false);
            }}
          >
            {sideTab === "settings" && isVisualBook ? (
              <MemoImageSettingsPanel
                value={visualSettings}
                pdf={isPdfBook}
                onChange={onVisualSettingsChange}
                hasOverride={Object.keys(imgOverride).length > 0}
                onSetDefault={setVisualDefault}
                onResetBook={resetVisualBook}
              />
            ) : null}

            {sideTab === "settings" && !isVisualBook ? (
              <MemoSettingsPanel
                value={epubSettings}
                bgUrl={bgUrl}
                ttsRate={ttsRate}
                onTtsRate={onTtsRateChange}
                bgVeil={bgVeil}
                onBgVeil={onBgVeilChange}
                onChange={onSettingsPanelChange}
                hasOverride={Object.keys(epuOverride).length > 0}
                onSetDefault={setEpubDefault}
                onResetBook={resetEpubBook}
              />
            ) : null}

            {sideTab === "media" && book && media && media.length > 0 ? <MediaPanel bookId={book.id} items={media} /> : null}

            {sideTab === "pages" && isVisualBook && book && imagePage ? (
              <PagesPanel
                bookId={book.id}
                pageCount={imagePage.pageCount}
                currentPage={imagePage.page}
                goTo={(p) => imageApiRef.current?.goToPage(p)}
                getResidentUrl={isImageBook ? (p) => imageApiRef.current?.getPageUrl(p) : undefined}
                fetchThumb={isPdfBook ? (p) => imageApiRef.current?.renderThumb?.(p) : undefined}
              />
            ) : null}

            {sideTab === "toc" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {tocLoading ? (
                  <div className="wr-state wr-state-loading">
                    <span className="wr-state-icon" aria-hidden="true">
                      <IconRefresh />
                    </span>
                    <div className="wr-state-title">加载中</div>
                  </div>
                ) : toc.length === 0 ? (
                  <div className="wr-state">
                    <span className="wr-state-icon" aria-hidden="true">
                      <IconList />
                    </span>
                    <div className="wr-state-title">暂无目录</div>
                  </div>
                ) : (
                  <TocPanel toc={toc} chapterHref={chapterHref} onOpen={locate} />
                )}
              </div>
            ) : null}

            {sideTab === "bookmarks" ? (
              <BookmarksPanel
                items={bookmarks}
                loaded={annotationsLoaded}
                onAdd={addBookmarkHere}
                onOpen={(cfi) => locate(cfi)}
                onDelete={(id) => {
                  void (async () => {
                    const ok = await showConfirm("删除书签", "确定删除该书签吗？", { danger: true, confirmText: "删除" });
                    if (!ok) return;
                    await deleteBookmark(id);
                    setBookmarks((prev) => prev.filter((b) => b.id !== id));
                  })();
                }}
                onClear={() => {
                  // D-4 清空：一次确认 + 逐条现有命令循环（书内量级小，无批量后端）
                  void (async () => {
                    const ok = await showConfirm("清空书签", `确定删除本书全部 ${bookmarks.length} 个书签吗？`, {
                      danger: true,
                      confirmText: "清空",
                    });
                    if (!ok) return;
                    for (const b of bookmarks) await deleteBookmark(b.id);
                    setBookmarks([]);
                  })();
                }}
              />
            ) : null}

            {sideTab === "highlights" ? (
              <HighlightsPanel
                items={highlights}
                loaded={annotationsLoaded}
                onExport={exportHighlights}
                onOpen={(cfiRange) => locate(cfiRange)}
                onClear={() => {
                  void (async () => {
                    const ok = await showConfirm("清空标注", `确定删除本书全部 ${highlights.length} 条标注吗？笔记将一并删除。`, {
                      danger: true,
                      confirmText: "清空",
                    });
                    if (!ok) return;
                    for (const h of highlights) {
                      await deleteHighlight(h.id);
                      controllerRef.current?.removeHighlight(h.cfi_range);
                    }
                    setHighlights([]);
                  })();
                }}
                onDelete={(id) => {
                  void (async () => {
                    const ok = await showConfirm("删除标注", "确定删除该标注吗？笔记将一并删除。", {
                      danger: true,
                      confirmText: "删除",
                    });
                    if (!ok) return;
                    const h = highlights.find((x) => x.id === id);
                    await deleteHighlight(id);
                    setHighlights((prev) => prev.filter((x) => x.id !== id));
                    if (h) controllerRef.current?.removeHighlight(h.cfi_range);
                  })();
                }}
              />
            ) : null}

            {sideTab === "favorites" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {!annotationsLoaded ? (
                  <div className="wr-state wr-state-loading">
                    <span className="wr-state-icon" aria-hidden="true">
                      <IconRefresh />
                    </span>
                    <div className="wr-state-title">加载中</div>
                  </div>
                ) : favoriteQuotes.length === 0 ? (
                  <div className="wr-state">
                    <span className="wr-state-icon" aria-hidden="true">
                      <IconQuote />
                    </span>
                    <div className="wr-state-title">还没有收藏</div>
                    <div className="wr-state-sub">选中正文一段文字试试</div>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {favoriteQuotes.map((q) => (
                      <div key={q.id} className="wr-card" style={{ padding: 10 }}>
                        <div style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>{q.text}</div>
                        {q.note ? <div className="wr-muted" style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>{q.note}</div> : null}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="wr-btn" onClick={() => locate(q.cfi_range)}>
                            打开定位
                          </button>
                          <button
                            className="wr-btn"
                            onClick={() => {
                              void (async () => {
                                const ok = await showConfirm("删除收藏", "确定删除这条收藏吗？", {
                                  danger: true,
                                  confirmText: "删除",
                                });
                                if (!ok) return;
                                await deleteFavoriteQuote(q.id);
                                setFavoriteQuotes((prev) => prev.filter((x) => x.id !== q.id));
                              })();
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {sideTab === "search" ? (
              <SearchPanel
                inputRef={searchInputRef}
                query={searchQuery}
                onQueryChange={setSearchQuery}
                loading={searchLoading}
                searched={searched}
                results={searchRows}
                onSearch={() => {
                  void (async () => {
                    const ctrl = controllerRef.current;
                    if (!ctrl) return;
                    const seq = ++searchSeqRef.current;
                    setSearchLoading(true);
                    setSearched(true);
                    try {
                      const res = await ctrl.search(searchQuery);
                      if (searchSeqRef.current !== seq) return;
                      setSearchResults(res);
                    } finally {
                      if (searchSeqRef.current === seq) setSearchLoading(false);
                    }
                  })();
                }}
                onOpen={(cfi) => locate(cfi)}
              />
            ) : null}

            {sideTab === "highlights" && noteDraft ? (
              <div className="wr-card" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontWeight: 700 }}>添加笔记</div>
                <div className="wr-muted" style={{ whiteSpace: "pre-wrap" }}>
                  {noteDraft.text}
                </div>
                <textarea
                  className="wr-textarea"
                  value={noteText}
                  onChange={(e) => setNoteText(e.currentTarget.value)}
                  placeholder="写下你的想法（可空）"
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="wr-btn wr-btn-primary"
                    onClick={() => {
                      const d = noteDraft;
                      if (!book || !d) return;
                      void (async () => {
                        const h = await addHighlight(book.id, d.cfiRange, HIGHLIGHT_COLOR, noteText.trim() ? noteText : null, d.text);
                        setHighlights((prev) => (prev.some((x) => x.cfi_range === h.cfi_range) ? prev : [h, ...prev]));
                        controllerRef.current?.addHighlight(d.cfiRange);
                        setNoteDraft(null);
                        setNoteText("");
                        setSelection(null);
                      })();
                    }}
                  >
                    保存
                  </button>
                  <button
                    className="wr-btn"
                    onClick={() => {
                      setNoteDraft(null);
                      setNoteText("");
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}
          </Drawer>

          <div
            className={isVisualBook ? "wr-reader-paper-wrap wr-paper-image" : "wr-reader-paper-wrap"}
            style={isVisualBook ? undefined : { position: "relative" }}
          >
            {isVisualBook && book ? (
              isImageBook ? (
                <ImageReader
                  key={book.id}
                  book={book}
                  settings={visualSettings}
                  turnSpeedMs={settings.turnSpeedMs}
                  onRelocated={handleImageRelocated}
                  theme={theme}
                  onApi={handleImageApi}
                />
              ) : (
                <PdfReader
                  key={book.id}
                  book={book}
                  settings={visualSettings}
                  turnSpeedMs={settings.turnSpeedMs}
                  onRelocated={handleImageRelocated}
                  theme={theme}
                  onApi={handlePdfApi}
                />
              )
            ) : (
              <>
                {chrome.locked ? null : (
                  // 纸面上方章节小字（占顶部 18px padding 带，零 layout 影响）
                  <div
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 18,
                      lineHeight: "18px",
                      textAlign: "center",
                      fontSize: 12,
                      color: "var(--wr-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      pointerEvents: "none",
                    }}
                  >
                    {chapterTitle}
                  </div>
                )}
                {bookGone ? (
                  // E-1 已删书死胡同：getBook null（或 90s 兜底）→ 错误态可返回书库，不再永久加载
                  <div className="wr-state wr-state-gone" style={{ margin: "auto" }} role="alert">
                    <div className="wr-state-title">书已删除或不存在</div>
                    <div className="wr-state-sub">可能已被删除，或链接已过期</div>
                    <div className="wr-state-actions">
                      <button className="wr-btn wr-btn-primary" onClick={backToLibrary}>
                        返回书库
                      </button>
                    </div>
                  </div>
                ) : !readerError && (!book || tocLoading || optProgress) ? (
                  <BookLoader
                    show={!book || tocLoading || !!optProgress}
                    text={
                      optProgress
                        ? `正在生成优化副本…${optProgress.total > 0 ? `（${optProgress.done}/${optProgress.total}）` : ""}`
                        : heavyEpub
                          ? "正在加载大部头…"
                          : "正在翻开…"
                    }
                    sub={optProgress ? "大书首次打开需要几分钟，完成后自动进入" : undefined}
                  />
                ) : null}
                <div
                  className={
                    settings.readingMode === "paginated" && spreadMode === "always"
                      ? "wr-reader-paper wr-reader-paper--wide"
                      : "wr-reader-paper"
                  }
                  style={
                    bgUrl
                      ? { backgroundImage: `url("${bgUrl}")`, backgroundSize: "cover", backgroundPosition: "center" }
                      : undefined
                  }
                >
                  {bgUrl ? <div className="wr-reader-bg-veil" aria-hidden="true" style={{ opacity: bgVeil / 100 }} /> : null}
                  {/* V-1 叶片：正文 + 页码徽标，翻页时作为整体进快照 */}
                  <div className={`wr-reader-leaf${bookEnter ? " wr-reader-enter" : ""}`} ref={leafRef}>
                    <div ref={containerRef} style={{ height: "100%", position: "relative" }} />
                    {/* B12 页码徽标：locations 就绪显示全书"位置页" X / Y（1024 字/页估算；双页两角 X 与 X+1 近似）；未就绪回退章内页码 */}
                    {locPage ? (
                      <div aria-hidden="true" className="wr-page-badge-layer">
                        {pageBadge.right ? (
                          <>
                            <span className="wr-page-badge wr-page-badge--left">
                              {locPage.index + 1} / {locPage.total}
                            </span>
                            <span className="wr-page-badge wr-page-badge--right">
                              {Math.min(locPage.index + 2, locPage.total)} / {locPage.total}
                            </span>
                          </>
                        ) : (
                          // 单页：只右下角一枚
                          <span className="wr-page-badge wr-page-badge--right">
                            {locPage.index + 1} / {locPage.total}
                          </span>
                        )}
                      </div>
                    ) : pageBadge.left || pageBadge.right ? (
                      <div aria-hidden="true" className="wr-page-badge-layer">
                        {pageBadge.right ? (
                          <>
                            {pageBadge.left ? (
                              <span className="wr-page-badge wr-page-badge--left">
                                {pageBadge.left.page}/{pageBadge.left.total}
                              </span>
                            ) : null}
                            <span className="wr-page-badge wr-page-badge--right">
                              {pageBadge.right.page}/{pageBadge.right.total}
                            </span>
                          </>
                        ) : pageBadge.left ? (
                          // 单页：只右下角一枚
                          <span className="wr-page-badge wr-page-badge--right">
                            {pageBadge.left.page}/{pageBadge.left.total}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </div>

          {pagerEnabled ? (
            /* §8：热区静态样式迁 weread.css（wr-edge-pager/glow/tap），宽度随视口计算仍内联 */
            <div className="wr-edge-pager">
              {pagerHover ? (
                <div
                  className={`wr-edge-glow wr-edge-glow--${pagerHover}`}
                  style={{ width: pagerHover === "left" ? stage.leftEdgeWidth : stage.rightEdgeWidth }}
                />
              ) : null}
              <div
                className="wr-edge-tap wr-edge-tap--left"
                style={{ width: stage.leftEdgeWidth }}
                onClick={() => {
                  chrome.dismiss(); // B12：边缘热区点击翻页即收栏
                  void animateTurn(imageEdgeSwap ? "next" : "prev");
                }}
                onMouseEnter={() => setPagerHover("left")}
                onMouseLeave={() => setPagerHover(null)}
              />
              <div
                className="wr-edge-tap wr-edge-tap--right"
                style={{ width: stage.rightEdgeWidth }}
                onClick={() => {
                  chrome.dismiss(); // B12：边缘热区点击翻页即收栏
                  void animateTurn(imageEdgeSwap ? "prev" : "next");
                }}
                onMouseEnter={() => setPagerHover("right")}
                onMouseLeave={() => setPagerHover(null)}
              />
            </div>
          ) : null}
          <SelectionToolbar
            open={!!selection && !drawerOpen && !readerError}
            rect={selection?.rect ?? null}
            removeMode={overlappingHighlights.length > 0}
            onCopy={() => {
              const s = selection;
              if (!s) return;
              // E1 划选复制：写剪贴板后收起气泡（与高亮/收藏流互不影响）
              navigator.clipboard
                ?.writeText(s.text)
                .catch(() => {})
                .finally(() => setSelection(null));
            }}
            onHighlight={() => {
              const s = selection;
              if (!book || !s) return;
              if (overlappingHighlights.length > 0) {
                const dead = overlappingHighlights;
                void (async () => {
                  for (const h of dead) {
                    await deleteHighlight(h.id);
                    controllerRef.current?.removeHighlight(h.cfi_range);
                  }
                  const ids = new Set(dead.map((h) => h.id));
                  setHighlights((prev) => prev.filter((h) => !ids.has(h.id)));
                  setSelection(null);
                })();
                return;
              }
              void (async () => {
                // E5：选中文本入 text 列（面板渲染原文+笔记双行），note 留空回归纯笔记语义
                const h = await addHighlight(book.id, s.cfiRange, HIGHLIGHT_COLOR, null, s.text);
                setHighlights((prev) => (prev.some((x) => x.cfi_range === h.cfi_range) ? prev : [h, ...prev]));
                controllerRef.current?.addHighlight(s.cfiRange);
                setSelection(null);
                openDrawer("highlights");
              })();
            }}
            onFavorite={() => {
              const s = selection;
              if (!book || !s) return;
              void (async () => {
                const q = await addFavoriteQuote(book.id, s.cfiRange, s.text, null);
                setFavoriteQuotes((prev) => [q, ...prev]);
                setSelection(null);
                openDrawer("favorites");
              })();
            }}
            onNote={() => {
              const s = selection;
              if (!s) return;
              setNoteDraft(s);
              setNoteText("");
              openDrawer("highlights");
            }}
            onClose={() => setSelection(null)}
          />

          {/* E-1 阅读正文右键菜单（iframe 内右键同款，见上方接线 effect）；V-2 起走 Radix Menu */}
          {ctxMenu && !drawerOpen && !readerError && !chrome.locked ? (
            <PointMenu point={ctxMenu} onClose={() => setCtxMenu(null)} label="正文操作">
              <Menu.Item asChild disabled={!ctxMenu.hasSelection} onSelect={onCtxCopy}>
                <button type="button" className="wr-menu-item">复制</button>
              </Menu.Item>
              <Menu.Item asChild onSelect={onCtxSelectAll}>
                <button type="button" className="wr-menu-item">全选（本章）</button>
              </Menu.Item>
            </PointMenu>
          ) : null}
          {readerError ? (
            <div
              role="alert"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
                background: "var(--wr-scrim)",
                zIndex: "var(--wr-z-overlay)",
              }}
            >
              <div className="wr-card wr-state wr-state-error" style={{ maxWidth: 720, width: "100%" }}>
                <div className="wr-state-title">加载失败</div>
                <div className="wr-state-sub" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "30vh", overflow: "auto" }}>
                  {readerError}
                </div>
                <div className="wr-state-actions">
                  <button
                    onClick={() => {
                      navigator.clipboard
                        ?.writeText(readerError)
                        .then(() => {
                          setErrorCopied(true);
                          window.setTimeout(() => setErrorCopied(false), 1500);
                        })
                        .catch(() => {});
                    }}
                    className="wr-btn"
                  >
                    {errorCopied ? "已复制" : "复制错误"}
                  </button>
                  <button
                    onClick={() => {
                      setReaderError(null);
                      setTocLoading(true);
                      setRetryKey((k) => k + 1);
                    }}
                    className="wr-btn wr-btn-primary"
                  >
                    重试
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* B12 顶/底热区条：根级正对 stage 的 62px 预留带（栏所在处；viewer overflow:hidden 会裁掉负偏移故挂根级），
          鼠标进入唤出栏；透明覆盖、z(14) 低于栏(16)与抽屉(20)，点击穿透照常翻页 */}
      {!chrome.locked ? (
        <>
          <div
            aria-hidden="true"
            className="wr-chrome-hotzone wr-chrome-hotzone--top"
            onMouseEnter={chrome.enter}
            onMouseLeave={chrome.leave}
          />
          <div
            aria-hidden="true"
            className="wr-chrome-hotzone wr-chrome-hotzone--bottom"
            onMouseEnter={chrome.enter}
            onMouseLeave={chrome.leave}
          />
        </>
      ) : null}

      {!chrome.locked ? (
        <ReaderFooter
          visible={chrome.visible}
          isVisualBook={isVisualBook}
          sliderReady={sliderReady}
          fill={dragPct ?? percent ?? 0}
          dragging={dragPct !== null}
          pageText={
            isVisualBook && imagePage !== null
              ? `${imagePage.page + 1} / ${imagePage.pageCount}`
              : locPage
                ? // B12 全局位置页（估算，与角标一致）；未就绪回退百分比
                  `${locPage.index + 1} / ${locPage.total}`
                : typeof percent === "number"
                  ? `${Math.round(percent * 100)}%`
                  : ""
          }
          onTurn={footerTurn}
          progressRef={progressRef}
          onProgressKeyDown={onProgressKeyDown}
          onProgressPointerDown={onProgressPointerDown}
          onProgressPointerMove={onProgressPointerMove}
          onProgressPointerEnd={onProgressPointerEnd}
          onEnter={chrome.enter}
          onLeave={chrome.leave}
        />
      ) : null}

      {!chrome.locked ? null : (
        /* 锁定态常驻退出控件：半透明、hover 提亮，角落 24px 内边距不遮正文 */
        <div className="wr-immersive-exit">
          <span className="wr-immersive-exit-chapter">{isVisualBook ? book?.title : chapterTitle}</span>
          <button
            type="button"
            className="wr-immersive-exit-btn"
            aria-label="退出沉浸模式"
            title="退出沉浸模式（Esc）"
            onClick={() => chrome.setLocked(false)}
          >
            <IconLockOpen />
          </button>
        </div>
      )}

      {chrome.locked && lockToast ? (
        <div role="status" className="wr-toast">
          已锁定 · Esc 解锁
        </div>
      ) : null}

      {speedToast !== null ? (
        <div role="status" className="wr-toast wr-toast--tabular">
          自动滚动 {speedToast}px/s
        </div>
      ) : null}

      {chapterToast !== null ? (
        <div role="status" className="wr-toast wr-toast--up">
          已进入 {chapterToast}
        </div>
      ) : null}

      {/* P-1 图片 Lightbox：iframe img 点击唤起；z 取 hud 之下最高（toast 之上） */}
      {lightbox ? <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} /> : null}
    </div>
    </TooltipProvider>
  );
}
