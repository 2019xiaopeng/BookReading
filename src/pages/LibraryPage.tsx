import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";

import type { Book, ManualStatus, Shelf, Tag, UpdateBookMetadataRequest } from "../tauri/invoke";
import {
  addTagsToBooks,
  createShelf,
  deleteBooks,
  deleteBooksFromDisk,
  deleteShelf,
  getSettings,
  listBooks,
  listImageSubdirs,
  listReadingTimes,
  listShelves,
  listTags,
  listTrash,
  moveBooksToShelf,
  moveShelf,
  purgeBooks,
  renameShelf,
  repairBookMetadata,
  restoreBooks,
  revealBookLocation,
  saveReaderBackground,
  setBookCover,
  setBookFavorite,
  setBookManualStatus,
  setBooksOrder,
  setSetting,
  setTrashRetentionDays,
  updateBookMetadata,
} from "../tauri/invoke";
import { needsMetadataRepair } from "../library/metadataRepair";
import { effectiveStatus, READING_STATUS_LABELS, type ReadingStatus } from "../library/readingStatus";
import { formatReadingTime } from "../library/readingTime";
import { bookMatchesQuery, formatAuthor, formatTitle } from "../library/bookFormat";
import BookDetailsDialog from "../library/BookDetailsDialog";
import BookCard from "../library/BookCard";
import { BatchTagDialog, ManageTagsDialog, TagFilterMenu } from "../library/TagDialogs";
import StatusFilterMenu from "../library/StatusFilterMenu";
import {
  countByShelf,
  countByShelfDeep,
  descendantIds,
  filterShelvesBySearch,
  firstBooksByShelf,
  shelfPath,
  shelfTreeRows,
  sortShelves,
  trashRemainingDays,
} from "../library/shelves";
import { DENSITY_PRESETS, normalizeLibraryDensity, type LibraryDensity } from "../library/density";
import { BOOKS_CHANGED_EVENT, importSingle, runImports } from "../library/importRunner";
import { invalidateCoverUrl, requestCoverUrl, useCoverUrls } from "../library/useCoverUrls";
import { notifyBackgroundChanged, resetBackgroundCache } from "../ui/appBackground";
import type { ReaderBackground } from "../reader/settings/types";
import { logFrontend } from "../tauri/frontendLog";
import AppShell, { setShelvesCache, useShellShelves } from "../ui/AppShell";
import { showAlert, showConfirm } from "../ui/dialog";
import { showToast } from "../ui/toast";
import { IconBook, IconCheckSquare, IconDensity, IconFolder, IconImage, IconRefresh, IconReveal, IconShelf, IconSort, IconTrash } from "../ui/icons";

type SortKey = "recent" | "title" | "added" | "custom";

const SORT_LABELS: Record<SortKey, string> = {
  recent: "最近阅读",
  title: "书名",
  added: "导入时间",
  custom: "自定义",
};

// K-2 文件夹排序（settings 键 folder_sort）：默认=创建序（sortShelves 兜底）
type FolderSortKey = "default" | "title-asc" | "title-desc" | "count-desc";

const FOLDER_SORT_LABELS: Record<FolderSortKey, string> = {
  default: "默认（创建序）",
  "title-asc": "书名升序",
  "title-desc": "书名降序",
  "count-desc": "书数降序",
};

// S-4 ⋯ 菜单「状态」段：三档手动状态 + 恢复自动（null=清除覆盖回推导）
const MANUAL_STATUS_OPTIONS: { value: ManualStatus | null; label: string }[] = [
  { value: "unread", label: READING_STATUS_LABELS.unread },
  { value: "reading", label: READING_STATUS_LABELS.reading },
  { value: "finished", label: READING_STATUS_LABELS.finished },
  { value: null, label: "恢复自动" },
];

// F1-5 滚动位置记忆（会话内，不落盘）：视图键 → scrollTop。卸载不清空，从阅读器返回原书架时还原。
const scrollMemory = new Map<string, number>();

/** 视图键：回收站 / 根书架 / 各书架各自记忆 */
export function viewKey(trashView: boolean, shelfId: number | null): string {
  return trashView ? "trash" : shelfId == null ? "root" : `s${shelfId}`;
}

/** T-4 回收站行内搜索过滤（书名+作者）：全选口径=本过滤结果而非全库（与主视图一致） */
export function filterTrash(list: Book[], query: string): Book[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((b) => `${formatTitle(b)} ${formatAuthor(b)}`.toLowerCase().includes(q));
}

type MenuState =
  | { kind: "sort"; x: number; y: number }
  | { kind: "grid"; x: number; y: number }
  | { kind: "book"; x: number; y: number; book: Book }
  | { kind: "shelf"; x: number; y: number; shelf: Shelf };

type PromptState = {
  title: string;
  value: string;
  /** true = 空提交合法（备注留空即清除） */
  allowEmpty: boolean;
  onConfirm: (value: string) => void;
};

/** 树形选择对话框：移动书（单/批量）或移动书架到目标书架（null=根） */
type MoveDialog = { kind: "books"; bookIds: string[] } | { kind: "shelf"; shelfId: number };

export default function LibraryPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [books, setBooks] = useState<Book[]>([]);
  // E3 阅读时长：bookId → 累计秒数（书卡“已读 X 小时 Y 分”chip）
  const [readingTimes, setReadingTimes] = useState<Record<string, number>>({});
  // 书架树与侧栏同源（AppShell 模块单例）：本页增删改后 refresh 推写，两侧零闪烁同步
  const shelves = useShellShelves();
  const [tags, setTags] = useState<Tag[]>([]);
  const [trash, setTrash] = useState<Book[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [loading, setLoading] = useState(false);
  // 导入按钮各自独立 busy 文案：loading 共用于防并发（任一导入中其余导入入口全禁），
  // "导入中…"只显示在实际触发的那颗上；删除/收藏等其它 loading 操作不再误显导入中
  const [importing, setImporting] = useState<"books" | "images" | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [sortAsc, setSortAsc] = useState(false);
  const [folderSort, setFolderSort] = useState<FolderSortKey>("default");
  const [density, setDensity] = useState<LibraryDensity>("standard");
  const [tagFilter, setTagFilter] = useState<Set<number>>(new Set());
  const [statusFilter, setStatusFilter] = useState<"all" | ReadingStatus>("all");
  const [detailsBook, setDetailsBook] = useState<Book | null>(null);
  const [batchTags, setBatchTags] = useState(false);
  const [manageTagsOpen, setManageTagsOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [moveDialog, setMoveDialog] = useState<MoveDialog | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // DnD 载荷（HTML5 dataTransfer 在 dragover 里读不到自定义类型，拖拽中用 state 旁路）
  const [dragBookId, setDragBookId] = useState<string | null>(null);
  const [dragShelfId, setDragShelfId] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const repairingRef = useRef<Set<string>>(new Set());
  const attemptedRef = useRef<Set<string>>(new Set());
  // 竞态加固：settings 恢复完成前不回写默认值（挂载首帧 sort/status effect 会先把默认值落盘覆盖存量）
  const settingsHydratedRef = useRef(false);

  // 回收站视图与当前书架都走 URL（?trash=1 / ?shelf=id），侧栏树与面包屑同源
  const trashView = searchParams.get("trash") === "1";
  const shelfParam = searchParams.get("shelf");
  const parsedShelf = shelfParam ? Number(shelfParam) : null;
  const currentShelfId =
    !trashView && parsedShelf != null && Number.isFinite(parsedShelf) ? parsedShelf : null;

  const shelvesSorted = useMemo(() => sortShelves(shelves), [shelves]);
  const subShelves = useMemo(
    () => shelvesSorted.filter((s) => (s.parent_id ?? null) === currentShelfId),
    [shelvesSorted, currentShelfId],
  );
  const path = useMemo(() => shelfPath(shelves, currentShelfId), [shelves, currentShelfId]);
  const counts = useMemo(() => countByShelf(books), [books]);
  // K-3 计数含子孙：卡面"N 本"=递归总数；+N 徽章与四宫格仍用直属（counts），视觉口径不变
  const deepCounts = useMemo(() => countByShelfDeep(shelves, books), [shelves, books]);
  const shelfBooks = useMemo(
    () => books.filter((b) => (b.shelf_id ?? null) === currentShelfId),
    [books, currentShelfId],
  );
  // 书架卡四宫格：固定每架前 4 本（与封面加载状态无关，不随到达顺序洗牌）；未就绪格显示骨架
  const topBooksByShelf = useMemo(() => firstBooksByShelf(books), [books]);

  const searching = query.trim().length > 0;
  // W-1 搜索态子书架过滤（名匹配或子树命中书），非搜索=全部子架 hits=0；K-2 文件夹排序只作用于书架卡
  const folderEntries = useMemo(() => {
    const entries = searching
      ? filterShelvesBySearch(shelves, currentShelfId, books, query)
      : subShelves.map((shelf) => ({ shelf, hits: 0 }));
    if (folderSort === "title-asc" || folderSort === "title-desc") {
      const dir = folderSort === "title-asc" ? 1 : -1;
      return [...entries].sort(
        (a, b) => dir * a.shelf.name.localeCompare(b.shelf.name, "zh") || a.shelf.id - b.shelf.id,
      );
    }
    if (folderSort === "count-desc") {
      return [...entries].sort(
        (a, b) => (deepCounts.get(b.shelf.id) ?? 0) - (deepCounts.get(a.shelf.id) ?? 0) || a.shelf.id - b.shelf.id,
      );
    }
    return entries;
  }, [shelves, currentShelfId, books, query, searching, subShelves, folderSort, deepCounts]);

  const booksFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // E6 全局搜索：有搜索词时源改全库 books（跨书架命中直接以书卡列出，点击正常打开）；无搜索词仍按当前书架
    let list = q ? books : shelfBooks;
    if (q) {
      // 搜索匹配：书名 + 作者 + 文件名（与文件夹过滤同口径，bookMatchesQuery）
      list = list.filter((b) => bookMatchesQuery(b, q));
    }
    if (tagFilter.size > 0) {
      // 标签多选 = AND：选中标签全部命中
      const wanted = [...tagFilter];
      list = list.filter((b) => {
        const ids = b.tags.map((t) => t.id);
        return wanted.every((id) => ids.includes(id));
      });
    }
    if (statusFilter !== "all") {
      // S-5 过滤走合并口径（手动状态优先）
      list = list.filter((b) => effectiveStatus(b) === statusFilter);
    }
    const dir = sortAsc ? 1 : -1;
    return [...list].sort((a, b) => {
      const pinned = Number(!!b.pinned_at) - Number(!!a.pinned_at);
      if (pinned !== 0) return pinned;
      // custom：无序值（从未排过）的沉底
      if (sortKey === "custom") return (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER);
      if (sortKey === "title") return dir * formatTitle(a).localeCompare(formatTitle(b), "zh");
      if (sortKey === "added") return dir * (a.added_at - b.added_at);
      return dir * ((a.last_opened_at ?? a.added_at) - (b.last_opened_at ?? b.added_at));
    });
  }, [books, shelfBooks, query, tagFilter, statusFilter, sortKey, sortAsc]);

  // K-1 置顶=无视分组的真最顶：渲染顺序 置顶书→新建卡→书架组→普通书（booksFiltered 已置顶优先，这里只切两段）
  const pinnedBooks = useMemo(() => booksFiltered.filter((b) => b.pinned_at), [booksFiltered]);
  const unpinnedBooks = useMemo(() => booksFiltered.filter((b) => !b.pinned_at), [booksFiltered]);

  // T-4 回收站过滤集（全选与渲染同源）
  const trashFiltered = useMemo(() => filterTrash(trash, query), [trash, query]);

  // 封面请求集 = 当前过滤视图 + 可见子书架卡固定前 4 本（书架卡也要封面；搜索态隐藏的架不请求）
  const coverItems = useMemo(() => {
    const items: { id: string; cover_path: string | null }[] = [];
    for (const { shelf } of folderEntries) {
      for (const b of topBooksByShelf.get(shelf.id) ?? []) items.push(b);
    }
    for (const b of booksFiltered) items.push(b);
    return items;
  }, [folderEntries, topBooksByShelf, booksFiltered]);
  // preferThumb：书架封面走 480px 缩略档（缺失自动回退原图，见 useCoverUrls）；详情页大封面不在此列
  const coverUrls = useCoverUrls(coverItems, { preferThumb: true });
  const trashCoverUrls = useCoverUrls(trash, { preferThumb: true });

  // refresh 只依赖稳定的 invoke 与 setter，引用恒定（供 useCallback 依赖与自愈批处理使用）
  const refresh = useCallback(async () => {
    const [list, shelfList, tagList] = await Promise.all([listBooks(), listShelves(), listTags()]);
    setBooks(list);
    setShelvesCache(shelfList);
    setTags(tagList);
  }, []);

  async function refreshTrash() {
    setTrash(await listTrash());
  }

  // 拖拽导入（壳层入口）与设置里清理封面后广播：列表/封面元数据可能已变
  useEffect(() => {
    const onChanged = () => void refresh();
    window.addEventListener(BOOKS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(BOOKS_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    refresh();
    getSettings()
      .then((m) => {
        setDensity(normalizeLibraryDensity(m.library_density));
        // 排序与密度同法持久化：退书/切视图重挂后不回落默认“最近阅读·降序”
        try {
          const s = JSON.parse(m.library_sort ?? "{}") as { key?: unknown; asc?: unknown };
          if (typeof s.key === "string" && s.key in SORT_LABELS) setSortKey(s.key as SortKey);
          if (typeof s.asc === "boolean") setSortAsc(s.asc);
        } catch {}
        // K-2 文件夹排序持久化恢复（非法值回落默认）
        if (typeof m.folder_sort === "string" && m.folder_sort in FOLDER_SORT_LABELS) {
          setFolderSort(m.folder_sort as FolderSortKey);
        }
        // 状态过滤（在读/未读）同法持久化，与侧栏快捷 chips 联动不断档
        if (m.library_status === "reading" || m.library_status === "finished" || m.library_status === "unread") {
          setStatusFilter(m.library_status);
        }
        const r = Number(m.trash_retention_days);
        if (Number.isFinite(r) && r >= 0) setRetentionDays(r);
      })
      .catch(() => {})
      .finally(() => {
        settingsHydratedRef.current = true;
      });
    // E3：时长随书库一起拉（回书库页重挂即刷新，阅读中每 60s 落库一次）
    listReadingTimes()
      .then((m) => setReadingTimes(m))
      .catch(() => {});
  }, []);

  // 进入回收站视图拉取清单；切书架/切视图时退出批量选择
  useEffect(() => {
    if (trashView) void refreshTrash();
  }, [trashView]);

  useEffect(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, [currentShelfId, trashView]);

  // 当前书架被删（含在别的窗口删）→ 回根，避免渲染悬空路径
  useEffect(() => {
    if (currentShelfId == null || shelves.length === 0) return;
    if (!shelves.some((s) => s.id === currentShelfId)) navigate("/", { replace: true });
  }, [shelves, currentShelfId]);

  // ---- F1-5 滚动位置记忆：视图数据首达时还原；滚动持续写入（容器=AppShell 的 .wr-main-scroll）----
  const viewScrollKey = viewKey(trashView, currentShelfId);
  const viewKeyRef = useRef(viewScrollKey);
  viewKeyRef.current = viewScrollKey;
  const restoredKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // 数据未到不还原（高度不足会被钳到顶部）；本挂载内每键只还原一次（防视图内刷新覆盖用户新位置）
    if ((trashView ? trash : books).length === 0 || restoredKeysRef.current.has(viewScrollKey)) return;
    restoredKeysRef.current.add(viewScrollKey);
    const el = document.querySelector<HTMLElement>(".wr-main-scroll");
    if (el) el.scrollTop = scrollMemory.get(viewScrollKey) ?? 0;
  }, [trashView, currentShelfId, viewScrollKey, trash, books]);
  // 重新挂载（从阅读器/收藏页返回）= 新一次访问：清还原标记、保留位置记忆——否则第二次进入被"只还原一次"跳过
  useEffect(() => () => restoredKeysRef.current.clear(), []);

  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".wr-main-scroll");
    if (!el) return;
    const onScroll = () => {
      const st = el.scrollTop;
      // 切视图瞬间容器被钳回 0 会发 scroll 事件——还原未发生前不记录，防把记忆清零
      if (st === 0 && !restoredKeysRef.current.has(viewKeyRef.current)) return;
      scrollMemory.set(viewKeyRef.current, st);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  function changeDensity(v: LibraryDensity) {
    setDensity(v);
    void setSetting("library_density", v);
  }

  // 排序写穿（菜单三处 setter 共用这一条通道，含恢复后回写）；恢复完成前跳过（见 settingsHydratedRef）
  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    void setSetting("library_sort", JSON.stringify({ key: sortKey, asc: sortAsc }));
  }, [sortKey, sortAsc]);

  // K-2 文件夹排序写穿（同法持久化）
  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    void setSetting("folder_sort", folderSort);
  }, [folderSort]);

  // H-1：Ctrl+F 聚焦搜索框（AppShell 顶栏 .wr-search-input；阅读器书内搜索路由隔离不受影响）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".wr-search-input")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 状态过滤写穿（"all" 不落盘，等于默认态）；恢复完成前跳过
  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    if (statusFilter !== "all") void setSetting("library_status", statusFilter);
    else void setSetting("library_status", "");
  }, [statusFilter]);

  // 批次18：打开书时记下来源书架，阅读页返回按钮据此回到该 ?shelf= 视图
  const openBook = useCallback(
    (id: string) => {
      navigate(`/read/${id}`, { state: { fromShelf: currentShelfId } });
    },
    [navigate, currentShelfId],
  );

  // 元数据自愈批处理：一轮只发起修复并收集结果，全部完成后 refresh 一次
  // （此前每修一本 await refresh() 全量重拉，N 本待修 = N 次整页重渲）
  useEffect(() => {
    const targets = books.filter(
      (b) => !attemptedRef.current.has(b.id) && !repairingRef.current.has(b.id) && needsMetadataRepair(b),
    );
    if (targets.length === 0) return;
    let cancelled = false;
    for (const b of targets) {
      repairingRef.current.add(b.id);
      attemptedRef.current.add(b.id);
    }
    void (async () => {
      try {
        await Promise.all(
          targets.map((b) =>
            repairBookMetadata(b.id).catch((e) => logFrontend(`meta: repair failed ${b.id} ${String(e)}`)),
          ),
        );
        if (!cancelled) await refresh();
      } finally {
        for (const b of targets) repairingRef.current.delete(b.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [books, refresh]);

  // menu keyboard semantics: open moves focus in, arrows cycle, close returns focus to the trigger
  function openMenu(next: MenuState, trigger: EventTarget | null) {
    menuTriggerRef.current = trigger instanceof HTMLElement ? trigger : null;
    setMenu(next);
  }

  function closeMenu() {
    setMenu(null);
    menuTriggerRef.current?.focus?.();
    menuTriggerRef.current = null;
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
      if (items.length === 0) return;
      const cur = items.indexOf(document.activeElement as HTMLElement);
      const next =
        cur < 0
          ? e.key === "ArrowDown"
            ? items[0]
            : items[items.length - 1]
          : e.key === "ArrowDown"
            ? items[(cur + 1) % items.length]
            : items[(cur - 1 + items.length) % items.length];
      next.focus();
    } else if (e.key === "Tab") {
      closeMenu();
    }
  }

  // close the popup menu on outside pointerdown / Escape
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // clamp menu into the viewport before paint, then focus the first item (ARIA menu pattern); resize re-clamps
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current;
    const clamp = () => {
      el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - el.offsetWidth - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - el.offsetHeight - 8))}px`;
    };
    clamp();
    el.querySelector<HTMLElement>("button")?.focus();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [menu]);

  function submitPrompt() {
    const p = prompt;
    if (!p) return;
    const v = p.value.trim();
    if (!v && !p.allowEmpty) return;
    setPrompt(null);
    p.onConfirm(v);
  }

  // 导入统一走 importRunner：逐本进度（壳顶进度条）+ 查重 + 四类结果汇总；刷新由 BOOKS_CHANGED_EVENT 监听兜底
  async function onImport() {
    if (loading) return;
    setLoading(true);
    setImporting("books");
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "EPUB / TXT / CBZ / PDF", extensions: ["epub", "txt", "cbz", "pdf"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;
      await runImports(paths, { targetShelfId: currentShelfId });
    } finally {
      setLoading(false);
      setImporting(null);
    }
  }

  async function onImportImages() {
    if (loading) return;
    setLoading(true);
    setImporting("images");
    try {
      const dir = await open({ directory: true, multiple: false, title: "选择漫画文件夹" });
      if (!dir || Array.isArray(dir)) return;
      // 批次16：单本漫画也走 importRunner（查重交互 + BOOKS_CHANGED_EVENT 自动刷新书卡，不再手动刷新才出现）
      const res = await importSingle(dir, { targetShelfId: currentShelfId });
      if (res.kind !== "failed") return;
      const msg = res.error ?? "";
      logFrontend(`ui: import image folder failed ${dir} ${msg}`);
      // 实测根因：把“每本一个子文件夹”的父目录当单本导入——直接子项全是子文件夹 → 无图。
      // 此时若子文件夹里有漫画，引导走批量导入而不是报错退出
      const subdirs = msg.includes("未找到图片") ? await listImageSubdirs(dir).catch(() => [] as string[]) : [];
      if (subdirs.length > 0) {
        const batch = await showConfirm(
          "改为批量导入？",
          `该文件夹内没有直接图片，但包含 ${subdirs.length} 个图片子文件夹。\n按每个子文件夹一本批量导入。`,
          { confirmText: "批量导入" },
        );
        if (batch) await runImports(subdirs, { targetShelfId: currentShelfId });
      } else {
        await showAlert("导入失败", msg);
      }
    } finally {
      setLoading(false);
      setImporting(null);
    }
  }

  // 批量导入：选父目录 → 每个一级子文件夹各导入一本漫画（空/无图目录服务端已过滤）
  async function onBatchImportImages() {
    if (loading) return;
    const parent = await open({ directory: true, multiple: false, title: "选择漫画父目录（每个一级子文件夹导入一本）" });
    if (!parent || Array.isArray(parent)) return;
    setLoading(true);
    setImporting("images");
    try {
      const dirs = await listImageSubdirs(parent);
      if (dirs.length === 0) {
        await showAlert("批量导入", "父目录下没有包含图片的一级子文件夹");
        return;
      }
      await runImports(dirs, { targetShelfId: currentShelfId });
    } catch (e) {
      await showAlert("批量导入失败", String(e));
    } finally {
      setLoading(false);
      setImporting(null);
    }
  }

  // 全局背景：链路复用阅读器（saveReaderBackground→resetBackgroundCache→写 settings），应用即预览
  async function applyGlobalBackground(bg: ReaderBackground) {
    try {
      await setSetting("reader_bg", JSON.stringify(bg));
      resetBackgroundCache();
      notifyBackgroundChanged();
    } catch (e) {
      await showAlert("设置背景失败", String(e));
    }
  }

  async function onSetGlobalBackground() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const path = await saveReaderBackground(picked);
      await applyGlobalBackground({ type: "image", path });
    } catch (e) {
      await showAlert("设置背景失败", String(e));
    }
  }

  function onResetGlobalBackground() {
    void applyGlobalBackground({ type: "preset" });
  }

  // 自定义封面：无封面书同样可用（Rust 端 UPDATE 即插即用）；repair 只补缺失不会覆盖
  async function onSetCover(book: Book) {
    const picked = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const newPath = await setBookCover(book.id, picked);
      if (book.cover_path) invalidateCoverUrl(book.cover_path);
      // 同路径替换时 wantedKey 不变，hook 不会自发重取，显式重取新封面；priority 插队（用户刚选的图不等批量队列）
      requestCoverUrl(newPath, { priority: true });
      await refresh();
    } catch (e) {
      await showAlert("设置封面失败", String(e));
    }
  }

  // 删除=软删入回收站，可恢复（彻底删除只在回收站页提供）
  async function onDeleteBook(book: Book) {
    if (loading) return;
    const isFolderComic = book.format === "images" && !book.library_path.toLowerCase().endsWith(".cbz");
    const ok = await showConfirm(
      "移入回收站",
      `确定删除《${formatTitle(book)}》吗？将移入回收站，可在回收站恢复。` +
        (isFolderComic ? "\n源文件夹不会被改动，仅移除本书记录与封面。" : ""),
      { danger: true, confirmText: "删除" },
    );
    if (!ok) return;

    setLoading(true);
    try {
      await deleteBooks([book.id]);
      await refresh();
    } catch (e) {
      await showAlert("删除失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  const runUpdates = useCallback(
    async (reqs: UpdateBookMetadataRequest[]) => {
      setLoading(true);
      try {
        for (const req of reqs) await updateBookMetadata(req);
        await refresh();
      } catch (e) {
        await showAlert("操作失败", String(e));
      } finally {
        setLoading(false);
      }
    },
    [refresh],
  );

  const onChipUpdate = useCallback(
    (req: UpdateBookMetadataRequest) => {
      if (loading) return;
      void runUpdates([req]);
    },
    [loading, runUpdates],
  );

  function onRenameBook(book: Book) {
    setPrompt({
      title: "重命名书籍",
      value: formatTitle(book),
      allowEmpty: false,
      onConfirm: (v) => {
        if (v !== formatTitle(book)) onChipUpdate({ book_id: book.id, title: v });
      },
    });
  }

  function onNote(book: Book) {
    setPrompt({
      title: "备注（留空清除）",
      value: book.note ?? "",
      allowEmpty: true,
      onConfirm: (v) => onChipUpdate({ book_id: book.id, note: v }),
    });
  }

  function onToggleFavorite(book: Book) {
    if (loading) return;
    setLoading(true);
    setBookFavorite(book.id, !book.is_favorite)
      .then(() => refresh())
      .finally(() => setLoading(false));
  }

  // S-4 手动阅读状态：null=恢复自动推导（过滤与统计随即走 effectiveStatus 合并口径）
  async function onSetManualStatus(book: Book, status: ManualStatus | null) {
    if (loading) return;
    setLoading(true);
    try {
      await setBookManualStatus(book.id, status);
      await refresh();
    } catch (e) {
      await showAlert("设置状态失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  // ---- 书架操作 ----

  function onNewShelf() {
    setPrompt({
      title: currentShelfId == null ? "新书架名称" : `在“${path[path.length - 1]?.name ?? ""}”内新建书架`,
      value: "",
      allowEmpty: false,
      onConfirm: (name) => {
        void (async () => {
          try {
            await createShelf(name, currentShelfId);
            await refresh();
          } catch (e) {
            await showAlert("新建书架失败", String(e));
          }
        })();
      },
    });
  }

  function onRenameShelf(shelf: Shelf) {
    setPrompt({
      title: "书架名称",
      value: shelf.name,
      allowEmpty: false,
      onConfirm: (name) => {
        if (name === shelf.name) return;
        void (async () => {
          try {
            await renameShelf(shelf.id, name);
            await refresh();
          } catch (e) {
            await showAlert("重命名失败", String(e));
          }
        })();
      },
    });
  }

  async function onDeleteShelf(shelf: Shelf) {
    const ok = await showConfirm(
      "删除书架",
      `删除书架“${shelf.name}”？其中的书移到上级书架，子书架一并删除。`,
      { danger: true, confirmText: "删除" },
    );
    if (!ok) return;
    setLoading(true);
    try {
      await deleteShelf(shelf.id);
      // 删的是当前书架或其祖先 → 回根
      if (path.some((s) => s.id === shelf.id)) navigate("/", { replace: true });
      await refresh();
    } catch (e) {
      await showAlert("删除书架失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  // 树选择对话框确认：targetId null = 根
  async function onMoveDialogPick(targetId: number | null) {
    const d = moveDialog;
    if (!d) return;
    setMoveDialog(null);
    try {
      if (d.kind === "books") {
        await moveBooksToShelf(d.bookIds, targetId);
        if (d.bookIds.some((id) => selected.has(id))) setSelected(new Set());
        showToast(`已移动 ${d.bookIds.length} 本`); // H-3
      } else {
        await moveShelf(d.shelfId, targetId);
      }
      await refresh();
    } catch (e) {
      await showAlert("移动失败", String(e));
    }
  }

  // ---- 拖拽 ----

  // drop 后目标卡弹入动画（180ms，reduced-motion 下由全局回退关闭）
  const [popKey, setPopKey] = useState<string | null>(null);
  const popTimer = useRef<number>(0);
  function popCard(key: string) {
    window.clearTimeout(popTimer.current);
    setPopKey(key);
    popTimer.current = window.setTimeout(() => setPopKey(null), 220);
  }

  async function moveDroppedBook(bookId: string, shelfId: number | null) {
    try {
      await moveBooksToShelf([bookId], shelfId);
      await refresh();
    } catch (e) {
      await showAlert("移动失败", String(e));
    }
  }

  // custom 模式下拖到目标卡前，整列顺序落库
  async function persistOrder<T>(ids: T[], write: (ids: T[]) => Promise<void>) {
    try {
      await write(ids);
      await refresh();
    } catch (e) {
      await showAlert("排序失败", String(e));
    }
  }

  // 拖拽载荷：书卡或书架卡（pointer 实现，见 startCardDrag）
  type CardDrag =
    | { kind: "book"; id: string; label: string; cover?: string }
    | { kind: "shelf"; id: number; label: string };

  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; label: string; cover?: string; shelf: boolean } | null>(null);
  // ghost 位置直写 DOM：pointermove 每帧只改 left/top，不触发整页重渲
  const dragGhostRef = useRef<HTMLDivElement | null>(null);

  // 拖动过的这次按压不能让 click 透传（同卡上按下-拖动-松开会触发 onClick 进阅读器）
  function suppressNextClick() {
    const stop = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      window.removeEventListener("click", stop, true);
    };
    window.addEventListener("click", stop, true);
  }

  function dropOnShelf(drag: CardDrag, shelfId: number | null) {
    if (drag.kind === "book") {
      void moveDroppedBook(drag.id, shelfId);
      if (shelfId != null) popCard(`shelf:${shelfId}`);
    } else if (shelfId !== drag.id) {
      // 书架拖放：书架卡=移入其内；面包屑=移到该层（“全部”=根）。no-op 父级已在 canDropOn 过滤
      void (async () => {
        try {
          await moveShelf(drag.id, shelfId);
          await refresh();
        } catch (e) {
          await showAlert("移动失败", String(e));
        }
      })();
    }
  }

  // 批次16：书卡拖到"新建书架"虚线卡 = 命名（复用 wr-prompt）→ 新建于当前层 → 移入该书；取消=不建不移动
  function dropOnNewShelf(bookId: string) {
    setPrompt({
      title: currentShelfId == null ? "新书架名称" : `在“${path[path.length - 1]?.name ?? ""}”内新建书架`,
      value: "",
      allowEmpty: false,
      onConfirm: (name) => {
        void (async () => {
          try {
            const shelf = await createShelf(name, currentShelfId);
            await moveBooksToShelf([bookId], shelf.id);
            popCard(`shelf:${shelf.id}`);
            await refresh();
          } catch (e) {
            await showAlert("新建书架失败", String(e));
          }
        })();
      },
    });
  }

  // 批次17：拖书架卡到侧栏“回收站”= 删除书架（与右键删除同链路；广播同步其他窗口）
  async function dropOnTrashShelf(shelfId: number) {
    const shelf = shelves.find((s) => s.id === shelfId);
    if (!shelf) return;
    const ok = await showConfirm(
      "删除书架",
      `删除书架《${shelf.name}》？其内书籍将移到上一级，子书架一并删除（与右键删除一致）。`,
      { danger: true, confirmText: "删除" },
    );
    if (!ok) return;
    setLoading(true);
    try {
      await deleteShelf(shelfId);
      // 删的是当前书架/祖先 → 现有 effect（shelves 更新后 currentShelfId 悬空）自动回根
      await refresh();
      window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
    } catch (e) {
      await showAlert("删除书架失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  // 拖书卡到侧栏“回收站”导航项 = 软删入回收站（确认后与 onDeleteBook 同链路；广播同步其他窗口）
  async function dropOnTrash(bookId: string) {
    const ok = await showConfirm("移入回收站", "将 1 本书移入回收站？可在回收站恢复。", {
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    setLoading(true);
    try {
      await deleteBooks([bookId]);
      await refresh();
      window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
    } catch (e) {
      await showAlert("删除失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  function dropOnBook(bookId: string, target: Book) {
    if (sortKey !== "custom" || bookId === target.id) return;
    const rest = booksFiltered.map((b) => b.id).filter((id) => id !== bookId);
    const to = rest.indexOf(target.id);
    rest.splice(to < 0 ? rest.length : to, 0, bookId);
    popCard(`book:${bookId}`);
    void persistOrder(rest, setBooksOrder);
  }

  function canDropOn(target: HTMLElement, drag: CardDrag): boolean {
    const mode = target.dataset.drop;
    if (drag.kind === "book") {
      // 批次16：拖到"新建书架"虚线卡 = 命名新建并放入该书（书架卡不开放此目标）
      if (mode === "new-shelf") return true;
      if (mode === "shelf") return true;
      // 侧栏“回收站”项：拖入=软删；回收站视图内无拖拽源，这里再挡一层防自删困惑
      if (mode === "trash") return !trashView;
      return mode === "book" && sortKey === "custom" && drag.id !== target.dataset.bookId;
    }
    // 拖书架：目标=书架卡（移入其内）或面包屑（移到该层，""=根）或侧栏“回收站”（=删除书架）
    // 批次17：回收站视图内无拖拽源，仍挡一层防自删困惑（同书卡分支）
    if (mode === "trash") return !trashView;
    if (mode !== "shelf") return false;
    const sid = target.dataset.shelfId;
    const n = sid && sid !== "" ? Number(sid) : null;
    if (n == null || !Number.isFinite(n) || n === drag.id) return false;
    // 目标即当前父级（含根）是无操作，不亮
    const parent = shelves.find((s) => s.id === drag.id)?.parent_id ?? null;
    return n !== parent;
  }

  // Tauri2 默认接管 webview 拖放（OS 文件拖入要靠它拿绝对路径），Windows 上 HTML5 DnD 全程红圈；
  // 内部拖拽改走 Pointer Events：>5px 视为拖起，elementFromPoint 命中 [data-drop] 目标，自绘 ghost
  function startCardDrag(e: ReactPointerEvent<HTMLElement>, drag: CardDrag) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, select")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    let over: HTMLElement | null = null;

    function setOver(next: HTMLElement | null) {
      if (next === over) return;
      over?.classList.remove("drop-target");
      next?.classList.add("drop-target");
      over = next;
    }

    function cleanup() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("keydown", onKey);
      setOver(null);
      document.body.classList.remove("wr-card-dragging");
      setDragGhost(null);
      setDragBookId(null);
      setDragShelfId(null);
    }

    function onMove(ev: PointerEvent) {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        started = true;
        if (drag.kind === "book") setDragBookId(drag.id);
        else setDragShelfId(drag.id);
        document.body.classList.add("wr-card-dragging");
        setDragGhost({
          x: ev.clientX,
          y: ev.clientY,
          label: drag.label,
          cover: drag.kind === "book" ? drag.cover : undefined,
          shelf: drag.kind === "shelf",
        });
      }
      const g = dragGhostRef.current;
      if (g) {
        g.style.left = `${ev.clientX + 14}px`;
        g.style.top = `${ev.clientY + 10}px`;
      }
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const t = hit instanceof HTMLElement ? hit.closest<HTMLElement>("[data-drop]") : null;
      setOver(t && canDropOn(t, drag) ? t : null);
    }

    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      if (started) suppressNextClick(); // 按住中取消，松开时仍可能落在源卡上触发 click
      cleanup();
    }

    function onUp() {
      const target = over;
      const was = started;
      if (was) suppressNextClick();
      cleanup();
      if (!was || !target) return;
      const sid = target.dataset.shelfId;
      const shelfId = sid && sid !== "" ? Number(sid) : null;
      if (drag.kind === "book") {
        if (target.dataset.drop === "shelf") dropOnShelf(drag, shelfId);
        else if (target.dataset.drop === "new-shelf") dropOnNewShelf(drag.id);
        else if (target.dataset.drop === "trash") void dropOnTrash(drag.id);
        else {
          const targetBook = booksFiltered.find((b) => b.id === target.dataset.bookId);
          if (targetBook) dropOnBook(drag.id, targetBook);
        }
      } else if (target.dataset.drop === "trash") {
        void dropOnTrashShelf(drag.id);
      } else {
        dropOnShelf(drag, shelfId);
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("keydown", onKey);
  }

  // ---- 批量选择 ----

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
  }

  // 全选口径 = 当前视图的过滤集（主视图 booksFiltered / 回收站 trashFiltered），T-4
  const selectAllList = trashView ? trashFiltered : booksFiltered;
  const allSelected = selectAllList.length > 0 && selectAllList.every((b) => selected.has(b.id));

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(selectAllList.map((b) => b.id)));
  }

  async function onBatchDelete() {
    const ids = [...selected];
    if (ids.length === 0 || loading) return;
    const ok = await showConfirm(
      "移入回收站",
      `确定删除选中的 ${ids.length} 本书吗？将移入回收站，可在回收站恢复。`,
      { danger: true, confirmText: "删除" },
    );
    if (!ok) return;
    setLoading(true);
    try {
      await deleteBooks(ids);
      setSelected(new Set());
      await refresh();
    } catch (e) {
      await showAlert("删除失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onBatchFavorite() {
    const ids = [...selected].filter((id) => !books.find((b) => b.id === id)?.is_favorite);
    if (ids.length === 0) return;
    setLoading(true);
    try {
      for (const id of ids) await setBookFavorite(id, true);
      setSelected(new Set());
      await refresh();
    } catch (e) {
      await showAlert("收藏失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  // ---- 回收站 ----

  async function onRestore(book: Book) {
    setLoading(true);
    try {
      await restoreBooks([book.id]);
      await Promise.all([refresh(), refreshTrash()]);
    } catch (e) {
      await showAlert("恢复失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  // T-2 批量三动作：各一次确认（文案带 N），后端命令本就是数组签名
  async function onBatchRestore() {
    const ids = [...selected];
    if (ids.length === 0 || loading) return;
    setLoading(true);
    try {
      await restoreBooks(ids);
      setSelected(new Set());
      await Promise.all([refresh(), refreshTrash()]);
      showToast(`已恢复 ${ids.length} 本`); // H-3
    } catch (e) {
      await showAlert("恢复失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onBatchPurge() {
    const ids = [...selected];
    if (ids.length === 0 || loading) return;
    const ok = await showConfirm(
      "彻底删除",
      `彻底删除选中的 ${ids.length} 本书？将删除书籍文件与全部阅读记录，不可恢复。`,
      { danger: true, confirmText: "彻底删除" },
    );
    if (!ok) return;
    setLoading(true);
    try {
      await purgeBooks(ids);
      setSelected(new Set());
      await refreshTrash();
    } catch (e) {
      await showAlert("删除失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onBatchDeleteFromDisk() {
    const ids = [...selected];
    if (ids.length === 0 || loading) return;
    const ok = await showConfirm(
      "从电脑删除",
      `把选中的 ${ids.length} 本书的源文件（漫画为整个源文件夹）移入 Windows 回收站，并从书库移除？回收站内可找回。`,
      { danger: true, confirmText: "移入回收站" },
    );
    if (!ok) return;
    setLoading(true);
    try {
      await deleteBooksFromDisk(ids);
      setSelected(new Set());
      await refreshTrash();
      showToast(`已从电脑删除 ${ids.length} 本`); // H-3
    } catch (e) {
      await showAlert("从电脑删除失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  // H-6 回收站键盘：Delete=选中行彻底删除（无选中忽略），Esc=退出选择态；输入框内不劫持
  useEffect(() => {
    if (!trashView) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "Escape" && selectMode) {
        exitSelect();
        return;
      }
      if (e.key === "Delete") void onBatchPurge();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function onPurge(book: Book) {
    const ok = await showConfirm(
      "彻底删除",
      `彻底删除《${formatTitle(book)}》？将删除书籍文件与全部阅读记录，不可恢复。`,
      { danger: true, confirmText: "彻底删除" },
    );
    if (!ok) return;
    setLoading(true);
    try {
      await purgeBooks([book.id]);
      await refreshTrash();
    } catch (e) {
      await showAlert("删除失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  // 真删：源文件/漫画源文件夹移入 Windows 回收站（可从系统回收站找回），并从书库移除；
  // after 区分入口收尾——回收站行刷新回收站清单，⋯ 菜单（P1）刷新书库并退出批量态
  async function onDeleteFromDisk(book: Book, after: () => Promise<void>) {
    const ok = await showConfirm(
      "从电脑删除",
      `把《${formatTitle(book)}》的源文件（漫画为整个源文件夹）移入 Windows 回收站，并从书库移除？回收站内可找回。`,
      { danger: true, confirmText: "移入回收站" },
    );
    if (!ok) return;
    setLoading(true);
    try {
      await deleteBooksFromDisk([book.id]);
      await after();
    } catch (e) {
      await showAlert("从电脑删除失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onEmptyTrash() {
    if (trash.length === 0 || loading) return;
    const ok = await showConfirm(
      "清空回收站",
      `彻底删除回收站中的 ${trash.length} 本书？将删除书籍文件与全部阅读记录，不可恢复。`,
      { danger: true, confirmText: "清空" },
    );
    if (!ok) return;
    setLoading(true);
    try {
      await purgeBooks(trash.map((b) => b.id));
      await refreshTrash();
    } catch (e) {
      await showAlert("清空失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  function onChangeRetention(days: number) {
    setRetentionDays(days);
    void setTrashRetentionDays(days).catch((e) => showAlert("设置保留期失败", String(e)));
  }

  // 移动树选择对话框里要排除的书架（移动书架时不能选自身/后代）
  const moveExclude =
    moveDialog?.kind === "shelf" ? descendantIds(shelves, moveDialog.shelfId) : null;

  // BookCard 事件全部引用恒定：memo 只随可见 props 重渲（任意 state 变化不再全卡片重渲）。
  // startCardDrag 闭包依赖多（排序/拖放目标/书架树），经 ref 转发最新实现
  const startCardDragRef = useRef(startCardDrag);
  startCardDragRef.current = startCardDrag;
  const onCardPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, book: Book, coverUrl?: string) =>
      startCardDragRef.current(e, { kind: "book", id: book.id, label: formatTitle(book), cover: coverUrl }),
    [],
  );
  const onCardMenu = useCallback(
    (book: Book, anchor: HTMLElement | null, pos?: { x: number; y: number }) => {
      // ⋯ 按钮贴按钮右下角；右键（P4）贴光标；两者都缺省退到左上角（由 clamp 兜底）
      const r = anchor?.getBoundingClientRect();
      const x = pos?.x ?? r?.right ?? 8;
      const y = pos?.y ?? (r ? r.bottom + 4 : 8);
      openMenu({ kind: "book", x, y, book }, anchor);
    },
    [],
  );

  // P2：在资源管理器中显示源文件/源目录
  async function onRevealBook(book: Book) {
    try {
      await revealBookLocation(book.id);
    } catch (e) {
      await showAlert("打开所在位置失败", String(e));
    }
  }

  const nowSec = Date.now() / 1000;
  // E3 书卡时长 chip 文案（不足 1 分钟不显示）
  const readingTimeText = (id: string): string | null => {
    const t = formatReadingTime(readingTimes[id] ?? 0);
    return t ? `已读 ${t}` : null;
  };

  // 刊头统计口径：根视图=全库，书架视图=该书架直属书；在读=effectiveStatus 合并口径（S-5）
  const mastheadScope = currentShelfId == null ? books : shelfBooks;
  const mastheadReading = mastheadScope.filter((b) => effectiveStatus(b) === "reading").length;
  const mastheadName = path.length > 0 ? path[path.length - 1].name : "书 架";

  return (
    <AppShell
      active="library"
      title={trashView ? "回收站" : "书架"}
      search={{ value: query, placeholder: trashView ? "搜索书名 / 作者" : "搜索书名 / 作者", onChange: setQuery }}
      quickFilter={trashView ? undefined : { value: statusFilter, onChange: setStatusFilter }}
      sidebarFooter={
        <>
          <button className="wr-small-btn" disabled={loading} onClick={() => void refresh()}>
            <IconRefresh />
            <span>刷新</span>
          </button>
          <button className="wr-small-btn wr-primary" onClick={onImportImages} disabled={loading}>
            <IconImage />
            <span>{importing === "images" ? "导入中…" : "导入漫画"}</span>
          </button>
          <button className="wr-small-btn wr-primary" onClick={onImport} disabled={loading}>
            <IconBook />
            <span>{importing === "books" ? "导入中…" : "导入图书"}</span>
          </button>
        </>
      }
    >
      <div className="wr-masthead">
        <h1 className="wr-masthead-name">{trashView ? "回 收 站" : mastheadName}</h1>
        <div className="wr-masthead-stats">
          {trashView ? `共 ${trash.length} 本` : `藏书 ${mastheadScope.length} · 在读 ${mastheadReading}`}
        </div>
      </div>

      {trashView ? (
        <div className="wr-toolbar-row">
          <button className="wr-btn" onClick={() => navigate("/")}>
            返回书架
          </button>
          {/* T-1 回收站选择模式（与主工具行同款复选图标钮） */}
          <div className="wr-seg" role="group" aria-label="批量选择">
            <button
              type="button"
              className="wr-seg-btn wr-seg-btn--icon wr-seg-btn--solid"
              aria-pressed={selectMode}
              data-active={selectMode}
              aria-label={selectMode ? "退出选择" : "选择"}
              title={selectMode ? "退出选择" : "选择"}
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
            >
              <IconCheckSquare />
            </button>
          </div>
          <label htmlFor="trash-retention" className="wr-muted" style={{ fontSize: 13 }}>
            保留期
          </label>
          <select
            id="trash-retention"
            className="wr-select"
            style={{ padding: "6px 10px" }}
            value={retentionDays}
            aria-label="回收站保留期"
            onChange={(e) => onChangeRetention(Number(e.currentTarget.value))}
          >
            <option value={7}>7 天</option>
            <option value={30}>30 天</option>
            <option value={0}>永不</option>
          </select>
          <button
            className="wr-btn wr-btn-danger"
            style={{ marginLeft: "auto" }}
            onClick={() => void onEmptyTrash()}
            disabled={loading || trash.length === 0}
          >
            <IconTrash />
            <span>清空回收站</span>
          </button>
        </div>
      ) : (
        <div className="wr-toolbar-row">
          <button
            type="button"
            className="wr-btn wr-icon-btn"
            aria-haspopup="menu"
            aria-expanded={menu?.kind === "sort"}
            aria-label={`排序：${SORT_LABELS[sortKey]} · ${sortAsc ? "升序" : "降序"}`}
            title={`排序：${SORT_LABELS[sortKey]} · ${sortAsc ? "升序" : "降序"}`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openMenu({ kind: "sort", x: r.left, y: r.bottom + 4 }, e.currentTarget);
            }}
          >
            <IconSort />
          </button>
          <div className="wr-seg" role="group" aria-label="批量选择">
            <button
              type="button"
              className="wr-seg-btn wr-seg-btn--icon wr-seg-btn--solid"
              aria-pressed={selectMode}
              data-active={selectMode}
              aria-label={selectMode ? "退出选择" : "选择"}
              title={selectMode ? "退出选择" : "选择"}
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
            >
              <IconCheckSquare />
            </button>
          </div>
          <div className="wr-seg" role="group" aria-label="书架密度" style={{ marginLeft: "auto" }}>
            {(Object.keys(DENSITY_PRESETS) as LibraryDensity[]).map((d) => (
              <button
                key={d}
                type="button"
                className="wr-seg-btn wr-seg-btn--icon"
                data-active={density === d}
                aria-pressed={density === d}
                aria-label={DENSITY_PRESETS[d].label}
                title={DENSITY_PRESETS[d].label}
                onClick={() => changeDensity(d)}
              >
                <IconDensity bars={d === "standard" ? 2 : d === "large" ? 3 : 4} />
              </button>
            ))}
          </div>
        </div>
      )}

      {!trashView ? (
        <div className="wr-filter-row" role="group" aria-label="筛选">
          <TagFilterMenu tags={tags} selected={tagFilter} onChange={setTagFilter} />
          <StatusFilterMenu value={statusFilter} onChange={setStatusFilter} />
          <button className="wr-btn" onClick={() => setManageTagsOpen(true)}>
            管理标签
          </button>
        </div>
      ) : null}

      {!trashView ? (
        <div className="wr-group-row" role="group" aria-label="书架路径">
          <button
            className="wr-group-chip"
            data-drop="shelf"
            data-shelf-id=""
            data-active={currentShelfId == null}
            aria-current={currentShelfId == null ? "page" : undefined}
            onClick={() => navigate("/")}
          >
            全部
          </button>
          {path.map((s, i) => (
            <button
              key={s.id}
              className="wr-group-chip"
              data-drop="shelf"
              data-shelf-id={s.id}
              data-active={i === path.length - 1}
              aria-current={i === path.length - 1 ? "page" : undefined}
              onClick={() => navigate(`/?shelf=${s.id}`)}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}

      {trashView ? (
        <div className="wr-trash-list">
          {trashFiltered.map((b) => {
            const remaining = trashRemainingDays(b.deleted_at ?? 0, retentionDays, nowSec);
            return (
              <div
                key={b.id}
                className="wr-trash-row"
                tabIndex={0} // H-6 行可聚焦，上下键在行间移动
                data-selected={selectMode && selected.has(b.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const rows = Array.from(document.querySelectorAll<HTMLElement>(".wr-trash-row"));
                  const i = rows.indexOf(e.currentTarget);
                  rows[i + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
                }}
              >
                {selectMode ? (
                  <button
                    className="wr-select-check"
                    role="checkbox"
                    aria-checked={selected.has(b.id)}
                    aria-label={`选择《${formatTitle(b)}》`}
                    onClick={() => toggleSelected(b.id)}
                  >
                    {selected.has(b.id) ? "✓" : ""}
                  </button>
                ) : null}
                <div className="wr-trash-cover" aria-hidden="true">
                  {b.cover_path && trashCoverUrls[b.cover_path] ? (
                    <img src={trashCoverUrls[b.cover_path]} alt="" loading="lazy" decoding="async" />
                  ) : null}
                  {!b.cover_path || !trashCoverUrls[b.cover_path] ? <IconBook width={18} height={18} /> : null}
                </div>
                <div className="wr-trash-info">
                  <div className="wr-trash-title" title={formatTitle(b)}>{formatTitle(b)}</div>
                  <div className="wr-trash-meta">
                    {new Date((b.deleted_at ?? 0) * 1000).toLocaleString()} ·{" "}
                    {remaining == null ? "永久保留" : `剩余 ${remaining} 天`}
                  </div>
                </div>
                <div className="wr-trash-actions">
                  <button className="wr-btn" onClick={() => void onRestore(b)} disabled={loading}>
                    恢复
                  </button>
                  <button className="wr-btn wr-btn-danger" onClick={() => void onPurge(b)} disabled={loading}>
                    彻底删除
                  </button>
                  <button
                    className="wr-btn wr-btn-danger"
                    onClick={() => void onDeleteFromDisk(b, refreshTrash)}
                    disabled={loading}
                  >
                    从电脑删除
                  </button>
                </div>
              </div>
            );
          })}

          {trash.length === 0 ? (
            <div className="wr-state">
              <span className="wr-state-icon" aria-hidden="true">
                <IconTrash />
              </span>
              <div className="wr-state-title">回收站是空的</div>
              <div className="wr-state-sub">删除的书会在这里保留一段时间，可随时恢复</div>
            </div>
          ) : null}
        </div>
      ) : (
        <div
          className={density === "standard" ? "wr-book-grid" : `wr-book-grid wr-book-grid--${density}`}
          style={{ gridTemplateColumns: DENSITY_PRESETS[density].grid }}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest(".wr-book-card")) return;
            e.preventDefault();
            openMenu({ kind: "grid", x: e.clientX, y: e.clientY }, e.currentTarget);
          }}
        >
          {/* K-1 置顶=无视分组的真最顶：置顶书 → 新建卡 → 书架组 → 普通书 */}
          {pinnedBooks.map((b) => (
            <BookCard
              key={b.id}
              book={b}
              coverUrl={b.cover_path ? coverUrls[b.cover_path] : undefined}
              readingTimeText={readingTimeText(b.id)}
              shelfPathText={searching ? shelfPath(shelves, b.shelf_id).map((s) => s.name).join(" / ") : undefined}
              selectMode={selectMode}
              selected={selected.has(b.id)}
              dragging={dragBookId === b.id}
              pop={popKey === `book:${b.id}`}
              loading={loading}
              onCardPointerDown={onCardPointerDown}
              onCardActivate={openBook}
              onCardSelectToggle={toggleSelected}
              onCardMenu={onCardMenu}
            />
          ))}

          {/* 常驻"新建书架"虚线卡：网格第一格，空书架也显示；拖书入内 = 新建并放入（data-drop）。
              W-3 搜索态隐藏（找书模式非整理模式） */}
          {!searching ? (
            <div
              className="wr-book-card wr-shelf-create"
              role="button"
              tabIndex={0}
              aria-label="新建书架"
              data-drop="new-shelf"
              onClick={onNewShelf}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onNewShelf();
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onNewShelf();
              }}
            >
              <IconFolder width={22} height={22} />
              <span>新建书架</span>
            </div>
          ) : null}

          {folderEntries.map(({ shelf: s, hits }) => {
            const direct = counts.get(s.id) ?? 0;
            const deep = deepCounts.get(s.id) ?? 0;
            return (
            <div
              key={s.id}
              className="wr-book-card wr-shelf-card"
              role="button"
              tabIndex={0}
              aria-label={`书架 ${s.name}，${deep} 本`}
              data-drop="shelf"
              data-shelf-id={s.id}
              data-hits={searching && hits > 0 ? hits : undefined}
              data-dragging={dragShelfId === s.id}
              data-pop={popKey === `shelf:${s.id}`}
              onPointerDown={(e) => startCardDrag(e, { kind: "shelf", id: s.id, label: s.name })}
              onClick={() => navigate(`/?shelf=${s.id}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(`/?shelf=${s.id}`);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu({ kind: "shelf", x: e.clientX, y: e.clientY, shelf: s }, e.currentTarget);
              }}
            >
              <div className="wr-cover" aria-hidden="true">
                <div className="wr-shelf-grid">
                  {(topBooksByShelf.get(s.id) ?? []).map((b) => {
                    if (!b.cover_path) return null;
                    const url = coverUrls[b.cover_path];
                    return url ? (
                      <img key={b.id} src={url} alt="" loading="lazy" decoding="async" />
                    ) : (
                      <div key={b.id} className="wr-shelf-skeleton" />
                    );
                  })}
                </div>
                {direct > 4 ? <span className="wr-shelf-badge">+{direct - 4}</span> : null}
              </div>
              <div className="wr-meta">
                <div className="wr-title" title={s.name}>{s.name}</div>
                {/* K-3 卡面=含子孙总数；title 补直属/子书架拆分 */}
                <div className="wr-author" title={`直属 ${direct} 本 · 含子书架 ${deep - direct} 本`}>{deep} 本</div>
              </div>
            </div>
            );
          })}

          {unpinnedBooks.map((b) => (
            <BookCard
              key={b.id}
              book={b}
              coverUrl={b.cover_path ? coverUrls[b.cover_path] : undefined}
              readingTimeText={readingTimeText(b.id)}
              shelfPathText={searching ? shelfPath(shelves, b.shelf_id).map((s) => s.name).join(" / ") : undefined}
              selectMode={selectMode}
              selected={selected.has(b.id)}
              dragging={dragBookId === b.id}
              pop={popKey === `book:${b.id}`}
              loading={loading}
              onCardPointerDown={onCardPointerDown}
              onCardActivate={openBook}
              onCardSelectToggle={toggleSelected}
              onCardMenu={onCardMenu}
            />
          ))}

          {booksFiltered.length === 0 && folderEntries.length === 0 ? (
            <div className="wr-state" style={{ gridColumn: "1 / -1" }}>
              <span className="wr-state-icon" aria-hidden="true">
                <IconShelf width={40} height={40} />
              </span>
              {query.trim() ? (
                <>
                  <div className="wr-state-title">全库未找到「{query.trim()}」</div>
                  <div className="wr-state-sub">换个书名或作者试试</div>
                </>
              ) : currentShelfId != null ? (
                <>
                  <div className="wr-state-title">该书架暂无书籍</div>
                  <div className="wr-state-sub">拖动书籍到左侧书架，或在空白处右键新建子书架</div>
                </>
              ) : (
                <>
                  <div className="wr-state-title">书架还是空的</div>
                  <div className="wr-state-sub">从左下角导入第一本书，或在空白处右键</div>
                </>
              )}
            </div>
          ) : null}
        </div>
      )}

      {selectMode && !trashView ? (
        <div className="wr-batch-bar" role="toolbar" aria-label="批量操作">
          <span className="wr-batch-count">已选 {selected.size}</span>
          <button className="wr-btn" onClick={() => setMoveDialog({ kind: "books", bookIds: [...selected] })} disabled={selected.size === 0}>
            移动到书架
          </button>
          <button className="wr-btn" onClick={() => void onBatchFavorite()} disabled={selected.size === 0}>
            收藏
          </button>
          <button className="wr-btn" onClick={() => setBatchTags(true)} disabled={selected.size === 0}>
            打标签
          </button>
          <button className="wr-btn wr-btn-danger" onClick={() => void onBatchDelete()} disabled={selected.size === 0}>
            删除
          </button>
          <button className="wr-btn" onClick={toggleSelectAll} disabled={booksFiltered.length === 0}>
            {allSelected ? "取消全选" : "全选"}
          </button>
          <button className="wr-btn" onClick={exitSelect}>
            取消
          </button>
        </div>
      ) : null}

      {/* T-2 回收站批量条变体：恢复/彻底删除/从电脑删除/全选（过滤集）/取消 */}
      {selectMode && trashView ? (
        <div className="wr-batch-bar" role="toolbar" aria-label="回收站批量操作">
          <span className="wr-batch-count">已选 {selected.size}</span>
          <button className="wr-btn" onClick={() => void onBatchRestore()} disabled={selected.size === 0}>
            恢复
          </button>
          <button className="wr-btn wr-btn-danger" onClick={() => void onBatchPurge()} disabled={selected.size === 0}>
            彻底删除
          </button>
          <button className="wr-btn wr-btn-danger" onClick={() => void onBatchDeleteFromDisk()} disabled={selected.size === 0}>
            从电脑删除
          </button>
          <button className="wr-btn" onClick={toggleSelectAll} disabled={trashFiltered.length === 0}>
            {allSelected ? "取消全选" : "全选"}
          </button>
          <button className="wr-btn" onClick={exitSelect}>
            取消
          </button>
        </div>
      ) : null}

      {dragGhost ? (
        <div
          ref={dragGhostRef}
          className="wr-drag-ghost"
          style={{ left: dragGhost.x + 14, top: dragGhost.y + 10 }}
          aria-hidden="true"
        >
          {dragGhost.cover ? (
            <img src={dragGhost.cover} alt="" loading="lazy" decoding="async" draggable={false} />
          ) : dragGhost.shelf ? (
            <IconFolder width={20} height={20} />
          ) : (
            <IconBook width={20} height={20} />
          )}
          <span>{dragGhost.label}</span>
        </div>
      ) : null}

      {menu ? (
        <div ref={menuRef} className="wr-menu" role="menu" style={{ left: menu.x, top: menu.y }} onKeyDown={onMenuKeyDown}>
          {menu.kind === "sort" ? (
            <>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <button
                  key={k}
                  className="wr-menu-item"
                  role="menuitemradio"
                  aria-checked={sortKey === k}
                  data-checked={sortKey === k}
                  title={k === "custom" ? "拖动卡片调整顺序" : undefined}
                  onClick={() => {
                    closeMenu();
                    setSortKey(k);
                  }}
                >
                  {SORT_LABELS[k]}
                </button>
              ))}
              <button
                className="wr-menu-item"
                role="menuitemradio"
                aria-checked={sortAsc}
                data-checked={sortAsc}
                onClick={() => {
                  closeMenu();
                  setSortAsc(true);
                }}
              >
                升序
              </button>
              <button
                className="wr-menu-item"
                role="menuitemradio"
                aria-checked={!sortAsc}
                data-checked={!sortAsc}
                onClick={() => {
                  closeMenu();
                  setSortAsc(false);
                }}
              >
                降序
              </button>
              {/* K-2 文件夹排序段：含子书架的视图才出现 */}
              {subShelves.length > 0 ? (
                <>
                  <div className="wr-menu-label" role="presentation" style={{ padding: "6px 10px 2px", fontSize: 12, color: "var(--wr-muted)", fontWeight: 600 }}>
                    文件夹
                  </div>
                  {(Object.keys(FOLDER_SORT_LABELS) as FolderSortKey[]).map((k) => (
                    <button
                      key={k}
                      className="wr-menu-item"
                      role="menuitemradio"
                      aria-checked={folderSort === k}
                      data-checked={folderSort === k}
                      onClick={() => {
                        closeMenu();
                        setFolderSort(k);
                      }}
                    >
                      {FOLDER_SORT_LABELS[k]}
                    </button>
                  ))}
                </>
              ) : null}
            </>
          ) : menu.kind === "grid" ? (
            <>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); onNewShelf(); }}>
                新建书架
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); void onImport(); }}>
                导入图书
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); void onImportImages(); }}>
                导入漫画
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); void onBatchImportImages(); }}>
                批量导入漫画
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); void onSetGlobalBackground(); }}>
                设置全局背景
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); onResetGlobalBackground(); }}>
                恢复默认背景
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); setSortAsc((v) => !v); }}>
                {sortAsc ? "切换为降序" : "切换为升序"}
              </button>
            </>
          ) : menu.kind === "book" ? (
            <>
              <button
                className="wr-menu-item"
                role="menuitem"
                onClick={() => { closeMenu(); onChipUpdate({ book_id: menu.book.id, pinned: !menu.book.pinned_at }); }}
              >
                {menu.book.pinned_at ? "取消置顶" : "置顶"}
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); setDetailsBook(menu.book); }}>
                详情
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); onRenameBook(menu.book); }}>
                重命名
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                onClick={() => { closeMenu(); setMoveDialog({ kind: "books", bookIds: [menu.book.id] }); }}
              >
                移动到书架…
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); onNote(menu.book); }}>
                备注
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); void onSetCover(menu.book); }}>
                设置封面
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                onClick={() => { closeMenu(); void onToggleFavorite(menu.book); }}
              >
                {menu.book.is_favorite ? "取消收藏" : "收藏"}
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                onClick={() => { closeMenu(); void onRevealBook(menu.book); }}
              >
                <IconReveal width={16} height={16} />
                打开所在位置
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                data-danger="true"
                onClick={() => { closeMenu(); void onDeleteBook(menu.book); }}
              >
                删除
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                data-danger="true"
                onClick={() => {
                  closeMenu();
                  void onDeleteFromDisk(menu.book, async () => {
                    await refresh();
                    exitSelect();
                  });
                }}
              >
                <IconTrash width={16} height={16} />
                从电脑删除
              </button>
              {/* S-4 手动状态段：三档手动 + 恢复自动；勾选=当前合并口径（effectiveStatus）。
                  “恢复自动”在无覆盖时置灰——本就处于自动，无可恢复 */}
              <div className="wr-menu-label" role="presentation" style={{ padding: "6px 10px 2px", fontSize: 12, color: "var(--wr-muted)", fontWeight: 600 }}>
                状态
              </div>
              {MANUAL_STATUS_OPTIONS.map((opt) => {
                const cur = effectiveStatus(menu.book);
                return (
                  <button
                    key={opt.label}
                    className="wr-menu-item"
                    role="menuitemradio"
                    aria-checked={opt.value != null && cur === opt.value}
                    data-checked={opt.value != null && cur === opt.value}
                    disabled={opt.value == null && menu.book.manual_status == null}
                    title={opt.value == null ? "清除手动覆盖，回到按打开记录与进度推导" : undefined}
                    onClick={() => {
                      closeMenu();
                      void onSetManualStatus(menu.book, opt.value);
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </>
          ) : (
            <>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); onRenameShelf(menu.shelf); }}>
                重命名书架
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                onClick={() => { closeMenu(); setMoveDialog({ kind: "shelf", shelfId: menu.shelf.id }); }}
              >
                移动到…
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                data-danger="true"
                onClick={() => { closeMenu(); void onDeleteShelf(menu.shelf); }}
              >
                删除书架
              </button>
            </>
          )}
        </div>
      ) : null}

      {moveDialog ? (
        <div
          className="wr-prompt-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMoveDialog(null);
          }}
        >
          <div
            className="wr-panel wr-prompt wr-move-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="移动到书架"
            onKeyDown={(e) => {
              if (e.key === "Escape") setMoveDialog(null);
            }}
          >
            <div style={{ fontWeight: 700 }}>移动到书架</div>
            <div className="wr-shelf-tree" role="listbox" aria-label="选择目标书架">
              <button onClick={() => void onMoveDialogPick(null)}>全部（根）</button>
              {shelfTreeRows(shelves)
                .filter((row) => !moveExclude?.has(row.id))
                .map((row) => (
                  <button
                    key={row.id}
                    style={{ paddingLeft: 12 + row.depth * 14 }}
                    onClick={() => void onMoveDialogPick(row.id)}
                  >
                    {row.name}
                  </button>
                ))}
            </div>
          </div>
        </div>
      ) : null}

      {prompt ? (
        <div
          className="wr-prompt-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPrompt(null);
          }}
        >
          <div
            className="wr-panel wr-prompt"
            role="dialog"
            aria-modal="true"
            aria-label={prompt.title}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPrompt(null);
            }}
          >
            <div style={{ fontWeight: 700 }}>{prompt.title}</div>
            <input
              className="wr-input"
              autoFocus
              aria-label={prompt.title}
              value={prompt.value}
              onChange={(e) => { const v = e.currentTarget.value; setPrompt((prev) => (prev ? { ...prev, value: v } : prev)); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitPrompt();
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="wr-btn" onClick={() => setPrompt(null)}>
                取消
              </button>
              <button
                className="wr-btn wr-btn-primary"
                onClick={submitPrompt}
                disabled={!prompt.allowEmpty && !prompt.value.trim()}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {detailsBook ? (
        <BookDetailsDialog
          book={detailsBook}
          tags={tags}
          shelves={shelves}
          onClose={() => setDetailsBook(null)}
          onChanged={() => void refresh()}
        />
      ) : null}

      {batchTags ? (
        <BatchTagDialog
          tags={tags}
          bookCount={selected.size}
          onClose={() => setBatchTags(false)}
          onConfirm={(ids) => {
            setBatchTags(false);
            void (async () => {
              try {
                await addTagsToBooks([...selected], ids);
                showToast(`已为 ${selected.size} 本打标签`); // H-3
                await refresh();
              } catch (e) {
                await showAlert("打标签失败", String(e));
              }
            })();
          }}
        />
      ) : null}

      {manageTagsOpen ? (
        <ManageTagsDialog tags={tags} onClose={() => setManageTagsOpen(false)} onChanged={() => void refresh()} />
      ) : null}
    </AppShell>
  );
}
