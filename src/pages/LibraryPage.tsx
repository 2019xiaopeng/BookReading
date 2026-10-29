import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";

import type { Book, Shelf, Tag, UpdateBookMetadataRequest } from "../tauri/invoke";
import {
  addTagsToBooks,
  createShelf,
  deleteBooks,
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
  saveReaderBackground,
  setBookCover,
  setBookFavorite,
  setBooksOrder,
  setSetting,
  setTrashRetentionDays,
  updateBookMetadata,
} from "../tauri/invoke";
import { needsMetadataRepair } from "../library/metadataRepair";
import { readingStatus, type ReadingStatus } from "../library/readingStatus";
import { formatReadingTime } from "../library/readingTime";
import { formatAuthor, formatTitle } from "../library/bookFormat";
import BookDetailsDialog from "../library/BookDetailsDialog";
import BookCard from "../library/BookCard";
import { BatchTagDialog, ManageTagsDialog, TagFilterMenu } from "../library/TagDialogs";
import StatusFilterMenu from "../library/StatusFilterMenu";
import {
  countByShelf,
  descendantIds,
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
import { IconBook, IconCheckSquare, IconDensity, IconFolder, IconImage, IconRefresh, IconSort, IconTrash } from "../ui/icons";

type SortKey = "recent" | "title" | "added" | "custom";

const SORT_LABELS: Record<SortKey, string> = {
  recent: "最近阅读",
  title: "书名",
  added: "导入时间",
  custom: "自定义",
};

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
  const shelfBooks = useMemo(
    () => books.filter((b) => (b.shelf_id ?? null) === currentShelfId),
    [books, currentShelfId],
  );
  // 书架卡四宫格：固定每架前 4 本（与封面加载状态无关，不随到达顺序洗牌）；未就绪格显示骨架
  const topBooksByShelf = useMemo(() => firstBooksByShelf(books), [books]);

  const booksFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // E6 全局搜索：有搜索词时源改全库 books（跨书架命中直接以书卡列出，点击正常打开）；无搜索词仍按当前书架
    let list = q ? books : shelfBooks;
    if (q) {
      // 搜索匹配：书名 + 作者 + 文件名（library_path basename）
      list = list.filter((b) => {
        const file = b.library_path.split(/[\\/]/).pop() ?? "";
        return `${formatTitle(b)} ${formatAuthor(b)} ${file}`.toLowerCase().includes(q);
      });
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
      list = list.filter((b) => readingStatus(b.reading_percent) === statusFilter);
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

  // 封面请求集 = 当前过滤视图 + 子书架卡固定前 4 本（书架卡也要封面）；不再对全库/回收站急加载
  const coverItems = useMemo(() => {
    const items: { id: string; cover_path: string | null }[] = [];
    for (const s of subShelves) {
      for (const b of topBooksByShelf.get(s.id) ?? []) items.push(b);
    }
    for (const b of booksFiltered) items.push(b);
    return items;
  }, [subShelves, topBooksByShelf, booksFiltered]);
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
        const r = Number(m.trash_retention_days);
        if (Number.isFinite(r) && r >= 0) setRetentionDays(r);
      })
      .catch(() => {});
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

  function changeDensity(v: LibraryDensity) {
    setDensity(v);
    void setSetting("library_density", v);
  }

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

  const allSelected = booksFiltered.length > 0 && booksFiltered.every((b) => selected.has(b.id));

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(booksFiltered.map((b) => b.id)));
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
  const onCardPin = useCallback(
    (book: Book, pinned: boolean) => onChipUpdate({ book_id: book.id, pinned }),
    [onChipUpdate],
  );
  const onCardMenu = useCallback((book: Book, anchor: HTMLElement) => {
    const r = anchor.getBoundingClientRect();
    openMenu({ kind: "book", x: r.right, y: r.bottom + 4, book }, anchor);
  }, []);

  const nowSec = Date.now() / 1000;
  // E3 书卡时长 chip 文案（不足 1 分钟不显示）
  const readingTimeText = (id: string): string | null => {
    const t = formatReadingTime(readingTimes[id] ?? 0);
    return t ? `已读 ${t}` : null;
  };

  return (
    <AppShell
      active="library"
      title={trashView ? "回收站" : "书架"}
      search={{ value: query, placeholder: trashView ? "搜索书名 / 作者" : "搜索书名 / 作者", onChange: setQuery }}
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
      {trashView ? (
        <div className="wr-toolbar-row">
          <button className="wr-btn" onClick={() => navigate("/")}>
            返回书架
          </button>
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
          {trash
            .filter((b) => {
              const q = query.trim().toLowerCase();
              return !q || `${formatTitle(b)} ${formatAuthor(b)}`.toLowerCase().includes(q);
            })
            .map((b) => {
              const remaining = trashRemainingDays(b.deleted_at ?? 0, retentionDays, nowSec);
              return (
                <div key={b.id} className="wr-trash-row">
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
          {/* 常驻"新建书架"虚线卡：网格第一格，空书架也显示；拖书入内 = 新建并放入（data-drop） */}
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

          {subShelves.map((s) => {
            const count = counts.get(s.id) ?? 0;
            return (
            <div
              key={s.id}
              className="wr-book-card wr-shelf-card"
              role="button"
              tabIndex={0}
              aria-label={`书架 ${s.name}，${count} 本`}
              data-drop="shelf"
              data-shelf-id={s.id}
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
                {count > 4 ? <span className="wr-shelf-badge">+{count - 4}</span> : null}
              </div>
              <div className="wr-meta">
                <div className="wr-title" title={s.name}>{s.name}</div>
                <div className="wr-author">{count} 本</div>
              </div>
            </div>
            );
          })}

          {booksFiltered.map((b) => (
            <BookCard
              key={b.id}
              book={b}
              coverUrl={b.cover_path ? coverUrls[b.cover_path] : undefined}
              readingTimeText={readingTimeText(b.id)}
              selectMode={selectMode}
              selected={selected.has(b.id)}
              dragging={dragBookId === b.id}
              pop={popKey === `book:${b.id}`}
              loading={loading}
              onCardPointerDown={onCardPointerDown}
              onCardActivate={openBook}
              onCardSelectToggle={toggleSelected}
              onCardPin={onCardPin}
              onCardMenu={onCardMenu}
            />
          ))}

          {booksFiltered.length === 0 && subShelves.length === 0 ? (
            <div className="wr-state" style={{ gridColumn: "1 / -1" }}>
              <span className="wr-state-icon" aria-hidden="true">
                <IconBook />
              </span>
              {query.trim() ? (
                <>
                  <div className="wr-state-title">没有匹配的书籍</div>
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
                onClick={() => { closeMenu(); onToggleFavorite(menu.book); }}
              >
                {menu.book.is_favorite ? "取消收藏" : "收藏"}
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                data-danger="true"
                onClick={() => { closeMenu(); void onDeleteBook(menu.book); }}
              >
                删除
              </button>
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
