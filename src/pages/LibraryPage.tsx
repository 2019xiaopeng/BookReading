import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { importImageFolder } from "../reader/image/api";
import { needsMetadataRepair } from "../library/metadataRepair";
import { readingStatus, type ReadingStatus } from "../library/readingStatus";
import BookDetailsDialog from "../library/BookDetailsDialog";
import { BatchTagDialog, ManageTagsDialog, TagFilterMenu } from "../library/TagDialogs";
import StatusFilterMenu from "../library/StatusFilterMenu";
import {
  countByShelf,
  descendantIds,
  shelfPath,
  shelfTreeRows,
  sortShelves,
  trashRemainingDays,
} from "../library/shelves";
import { DENSITY_PRESETS, normalizeLibraryDensity, type LibraryDensity } from "../library/density";
import { BOOKS_CHANGED_EVENT, runImports } from "../library/importRunner";
import { invalidateCoverUrl, requestCoverUrl, useCoverUrls } from "../library/useCoverUrls";
import { notifyBackgroundChanged, resetBackgroundCache } from "../ui/appBackground";
import type { ReaderBackground } from "../reader/settings/types";
import { logFrontend } from "../tauri/frontendLog";
import AppShell, { setShelvesCache, useShellShelves } from "../ui/AppShell";
import { showAlert, showConfirm } from "../ui/dialog";
import { IconBook, IconFolder, IconImage, IconMore, IconPin, IconRefresh, IconTrash } from "../ui/icons";

function formatTitle(book: Book): string {
  return book.title?.trim() || "未命名";
}

function formatAuthor(book: Book): string {
  return book.author?.trim() || "未知作者";
}

function progressText(book: Book): string {
  return typeof book.reading_percent === "number" ? `读到 ${Math.round(book.reading_percent * 100)}%` : "未读";
}

type SortKey = "recent" | "title" | "added" | "custom";

type MenuState =
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
  // 书架树与侧栏同源（AppShell 模块单例）：本页增删改后 refresh 推写，两侧零闪烁同步
  const shelves = useShellShelves();
  const [tags, setTags] = useState<Tag[]>([]);
  const [trash, setTrash] = useState<Book[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [loading, setLoading] = useState(false);
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
  const coverUrls = useCoverUrls(books);
  const trashCoverUrls = useCoverUrls(trash);

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
  // 书架卡四宫格：每架前 4 张已就绪的封面（无封面/未加载的书跳过，格子由主题渐变占位）
  const coversByShelf = useMemo(() => {
    const m = new Map<number, { id: string; url: string }[]>();
    for (const b of books) {
      const url = b.cover_path ? coverUrls[b.cover_path] : undefined;
      if (!url || b.shelf_id == null) continue;
      const list = m.get(b.shelf_id) ?? [];
      if (list.length < 4) {
        list.push({ id: b.id, url });
        m.set(b.shelf_id, list);
      }
    }
    return m;
  }, [books, coverUrls]);

  const booksFiltered = useMemo(() => {
    let list = shelfBooks;
    const q = query.trim().toLowerCase();
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
  }, [shelfBooks, query, tagFilter, statusFilter, sortKey, sortAsc]);

  async function refresh() {
    const [list, shelfList, tagList] = await Promise.all([listBooks(), listShelves(), listTags()]);
    setBooks(list);
    setShelvesCache(shelfList);
    setTags(tagList);
  }

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

  useEffect(() => {
    const pending: Promise<void>[] = [];
    for (const b of books) {
      if (!needsMetadataRepair(b)) continue;
      if (attemptedRef.current.has(b.id)) continue;
      if (repairingRef.current.has(b.id)) continue;
      repairingRef.current.add(b.id);
      attemptedRef.current.add(b.id);
      pending.push(
        (async () => {
          try {
            await repairBookMetadata(b.id);
            await refresh();
          } catch (e) {
            logFrontend(`meta: repair failed ${b.id} ${String(e)}`);
          } finally {
            repairingRef.current.delete(b.id);
          }
        })(),
      );
    }
    return () => {
      void Promise.allSettled(pending);
    };
  }, [books]);

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
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "EPUB / TXT / CBZ / PDF", extensions: ["epub", "txt", "cbz", "pdf"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;
      await runImports(paths);
    } finally {
      setLoading(false);
    }
  }

  async function onImportImages() {
    if (loading) return;
    setLoading(true);
    try {
      const dir = await open({ directory: true, multiple: false, title: "选择漫画文件夹" });
      if (!dir || Array.isArray(dir)) return;
      try {
        await importImageFolder(dir, null);
      } catch (e) {
        const msg = String(e);
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
          if (batch) await runImports(subdirs);
        } else {
          await showAlert("导入失败", msg);
        }
      }
    } finally {
      setLoading(false);
    }
  }

  // 批量导入：选父目录 → 每个一级子文件夹各导入一本漫画（空/无图目录服务端已过滤）
  async function onBatchImportImages() {
    const parent = await open({ directory: true, multiple: false, title: "选择漫画父目录（每个一级子文件夹导入一本）" });
    if (!parent || Array.isArray(parent)) return;
    setLoading(true);
    try {
      const dirs = await listImageSubdirs(parent);
      if (dirs.length === 0) {
        await showAlert("批量导入", "父目录下没有包含图片的一级子文件夹");
        return;
      }
      await runImports(dirs);
    } catch (e) {
      await showAlert("批量导入失败", String(e));
    } finally {
      setLoading(false);
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
      // 同路径替换时 wantedKey 不变，hook 不会自发重取，显式重取新封面
      requestCoverUrl(newPath);
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

  async function runUpdates(reqs: UpdateBookMetadataRequest[]) {
    setLoading(true);
    try {
      for (const req of reqs) await updateBookMetadata(req);
      await refresh();
    } catch (e) {
      await showAlert("操作失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  function onChipUpdate(req: UpdateBookMetadataRequest) {
    if (loading) return;
    void runUpdates([req]);
  }

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
      if (mode === "shelf") return true;
      return mode === "book" && sortKey === "custom" && drag.id !== target.dataset.bookId;
    }
    // 拖书架：目标=书架卡（移入其内）或面包屑（移到该层，""=根）
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
        else {
          const targetBook = booksFiltered.find((b) => b.id === target.dataset.bookId);
          if (targetBook) dropOnBook(drag.id, targetBook);
        }
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

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  const nowSec = Date.now() / 1000;

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
            <span>导入漫画</span>
          </button>
          <button className="wr-small-btn wr-primary" onClick={onImport} disabled={loading}>
            <IconBook />
            <span>{loading ? "导入中…" : "导入图书"}</span>
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
          <div className="wr-seg" role="group" aria-label="排序">
            <button className="wr-seg-btn" data-active={sortKey === "recent"} onClick={() => setSortKey("recent")}>
              最近阅读
            </button>
            <button className="wr-seg-btn" data-active={sortKey === "title"} onClick={() => setSortKey("title")}>
              书名
            </button>
            <button className="wr-seg-btn" data-active={sortKey === "added"} onClick={() => setSortKey("added")}>
              导入时间
            </button>
            <button
              className="wr-seg-btn"
              data-active={sortKey === "custom"}
              title="拖动卡片调整顺序"
              onClick={() => setSortKey("custom")}
            >
              自定义
            </button>
            <button
              className="wr-seg-btn"
              aria-pressed={sortAsc}
              aria-label={`排序方向：${sortAsc ? "升序" : "降序"}`}
              title={`排序方向：${sortAsc ? "升序" : "降序"}`}
              onClick={() => setSortAsc((v) => !v)}
            >
              {sortAsc ? "↑ 升序" : "↓ 降序"}
            </button>
          </div>
          <div className="wr-seg" role="group" aria-label="批量选择">
            <button
              className="wr-seg-btn"
              aria-pressed={selectMode}
              data-active={selectMode}
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
            >
              选择
            </button>
          </div>
          <div className="wr-seg" role="group" aria-label="书架密度" style={{ marginLeft: "auto" }}>
            {(Object.keys(DENSITY_PRESETS) as LibraryDensity[]).map((d) => (
              <button
                key={d}
                className="wr-seg-btn"
                data-active={density === d}
                aria-pressed={density === d}
                onClick={() => changeDensity(d)}
              >
                {DENSITY_PRESETS[d].label}
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
                    {b.cover_path && trashCoverUrls[b.cover_path] ? <img src={trashCoverUrls[b.cover_path]} alt="" /> : null}
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
          {/* 常驻"新建书架"虚线卡：网格第一格，空书架也显示 */}
          <div
            className="wr-book-card wr-shelf-create"
            role="button"
            tabIndex={0}
            aria-label="新建书架"
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
                  {(coversByShelf.get(s.id) ?? []).map((c) => (
                    <img key={c.id} src={c.url} alt="" />
                  ))}
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
            <div
              key={b.id}
              className="wr-book-card"
              role="button"
              tabIndex={0}
              data-selected={selectMode && selected.has(b.id)}
              data-drop="book"
              data-book-id={b.id}
              data-dragging={dragBookId === b.id}
              data-pop={popKey === `book:${b.id}`}
              onPointerDown={(e) =>
                startCardDrag(e, {
                  kind: "book",
                  id: b.id,
                  label: formatTitle(b),
                  cover: b.cover_path ? coverUrls[b.cover_path] : undefined,
                })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (selectMode) toggleSelected(b.id);
                  else navigate(`/read/${b.id}`);
                }
              }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button")) return;
                if (selectMode) toggleSelected(b.id);
                else navigate(`/read/${b.id}`);
              }}
            >
              {selectMode ? (
                <button
                  className="wr-select-check"
                  role="checkbox"
                  aria-checked={selected.has(b.id)}
                  aria-label={`选择《${formatTitle(b)}》`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSelected(b.id);
                  }}
                >
                  {selected.has(b.id) ? "✓" : ""}
                </button>
              ) : null}

              <div className="wr-cover">
                {b.cover_path && coverUrls[b.cover_path] ? <img src={coverUrls[b.cover_path]} alt="" /> : null}
                {!b.cover_path || !coverUrls[b.cover_path] ? (
                  <div className="wr-cover-text">
                    <div className="wr-cover-title">{formatTitle(b)}</div>
                    <div className="wr-cover-author">{formatAuthor(b)}</div>
                  </div>
                ) : null}
              </div>

              <div className="wr-meta">
                <div className="wr-title" title={formatTitle(b)}>{formatTitle(b)}</div>
                <div className="wr-author" title={`${formatAuthor(b)} · ${progressText(b)}`}>{formatAuthor(b)}</div>
                {typeof b.reading_percent === "number" ? (
                  <div className="wr-chip-row">
                    <div className="wr-chip">
                      <span className="wr-live-dot" aria-hidden="true" />
                      <span>读到 {Math.round(b.reading_percent * 100)}%</span>
                    </div>
                  </div>
                ) : null}
              </div>

              {!selectMode ? (
                <div className="wr-card-tools" data-show={!!b.pinned_at}>
                  <button
                    className="wr-mini-btn"
                    aria-label={b.pinned_at ? "取消置顶" : "置顶"}
                    aria-pressed={!!b.pinned_at}
                    data-pinned={!!b.pinned_at}
                    disabled={loading}
                    onClick={(e) => {
                      e.stopPropagation();
                      onChipUpdate({ book_id: b.id, pinned: !b.pinned_at });
                    }}
                  >
                    <IconPin fill={b.pinned_at ? "currentColor" : "none"} />
                  </button>
                  <button
                    className="wr-mini-btn"
                    aria-label="更多操作"
                    aria-haspopup="menu"
                    disabled={loading}
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      openMenu({ kind: "book", x: r.right, y: r.bottom + 4, book: b }, e.currentTarget);
                    }}
                  >
                    <IconMore />
                  </button>
                </div>
              ) : null}
            </div>
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
            <img src={dragGhost.cover} alt="" draggable={false} />
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
          {menu.kind === "grid" ? (
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
