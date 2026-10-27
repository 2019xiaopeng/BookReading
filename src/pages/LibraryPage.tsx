import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";

import type { Book, Shelf, Tag, UpdateBookMetadataRequest } from "../tauri/invoke";
import {
  addTagsToBooks,
  createShelf,
  deleteBooks,
  deleteShelf,
  getSettings,
  importBook,
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
  setShelfOrder,
  setTrashRetentionDays,
  updateBookMetadata,
} from "../tauri/invoke";
import { importImageFolder } from "../reader/image/api";
import { needsMetadataRepair } from "../library/metadataRepair";
import { readingStatus, READING_STATUS_LABELS, type ReadingStatus } from "../library/readingStatus";
import BookDetailsDialog from "../library/BookDetailsDialog";
import { BatchTagDialog, ManageTagsDialog, TagFilterMenu } from "../library/TagDialogs";
import {
  countByShelf,
  descendantIds,
  shelfPath,
  shelfTreeRows,
  sortShelves,
  trashRemainingDays,
} from "../library/shelves";
import { DENSITY_PRESETS, normalizeLibraryDensity, type LibraryDensity } from "../library/density";
import { invalidateCoverUrl, requestCoverUrl, useCoverUrls } from "../library/useCoverUrls";
import { notifyBackgroundChanged, resetBackgroundCache } from "../ui/appBackground";
import type { ReaderBackground } from "../reader/settings/types";
import { logFrontend } from "../tauri/frontendLog";
import AppShell from "../ui/AppShell";
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
  const [shelves, setShelves] = useState<Shelf[]>([]);
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
    setShelves(shelfList);
    setTags(tagList);
  }

  async function refreshTrash() {
    setTrash(await listTrash());
  }

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

  async function onImport() {
    if (loading) return;
    setLoading(true);
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "EPUB / TXT / CBZ", extensions: ["epub", "txt", "cbz"] }],
      });
      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      const failed: string[] = [];
      for (const path of paths) {
        try {
          if (path.toLowerCase().endsWith(".cbz")) {
            await importImageFolder(path, null);
          } else {
            await importBook({
              source_path: path,
              title: null,
              author: null,
              cover_bytes_base64: null,
              cover_ext: null,
            });
          }
        } catch (e) {
          failed.push(path);
          logFrontend(`ui: import failed ${path} ${String(e)}`);
        }
      }

      if (failed.length) {
        await showAlert(
          "部分文件导入失败",
          `${failed.length} 个文件未导入：\n${failed.join("\n")}\n仅支持 EPUB、TXT（UTF-8/GBK）与 CBZ 漫画`,
        );
      }

      await refresh();
    } finally {
      setLoading(false);
    }
  }

  // 逐本导入子目录（批量入口与误选父目录的兜底共用）：单项失败不中断，汇总 成功 N / 失败 M + 失败清单
  async function importImageDirs(dirs: string[]) {
    const failed: string[] = [];
    for (const dir of dirs) {
      try {
        await importImageFolder(dir, null); // title=null → 取子目录名
      } catch (e) {
        failed.push(String(e)); // 错误串已含目录绝对路径与原因
        logFrontend(`ui: batch import failed ${dir} ${String(e)}`);
      }
    }
    await showAlert(
      "批量导入",
      failed.length === 0
        ? `成功导入 ${dirs.length} 本`
        : `成功 ${dirs.length - failed.length} 本，失败 ${failed.length} 个：\n${failed.join("\n")}`,
    );
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
          if (batch) await importImageDirs(subdirs);
        } else {
          await showAlert("导入失败", msg);
        }
      }
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  // 批量导入：选父目录 → 每个一级子文件夹各导入一本漫画（空/无图目录服务端已过滤），失败逐个记日志不中断
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
      await importImageDirs(dirs);
      await refresh();
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

  function dropOnShelf(e: DragEvent<HTMLElement>, shelfId: number | null) {
    e.currentTarget.classList.remove("drop-target");
    e.preventDefault();
    if (dragBookId) {
      void moveDroppedBook(dragBookId, shelfId);
    } else if (
      dragShelfId != null &&
      sortKey === "custom" &&
      shelfId != null &&
      dragShelfId !== shelfId &&
      subShelves.some((s) => s.id === shelfId)
    ) {
      const ids = subShelves.map((s) => s.id);
      const rest = ids.filter((id) => id !== dragShelfId);
      const to = rest.indexOf(shelfId);
      rest.splice(to < 0 ? rest.length : to, 0, dragShelfId);
      void persistOrder(rest, setShelfOrder);
    }
    setDragBookId(null);
    setDragShelfId(null);
  }

  function dropOnBook(e: DragEvent<HTMLElement>, target: Book) {
    e.currentTarget.classList.remove("drop-target");
    if (sortKey !== "custom" || !dragBookId || dragBookId === target.id) return;
    e.preventDefault();
    const rest = booksFiltered.map((b) => b.id).filter((id) => id !== dragBookId);
    const to = rest.indexOf(target.id);
    rest.splice(to < 0 ? rest.length : to, 0, dragBookId);
    void persistOrder(rest, setBooksOrder);
    setDragBookId(null);
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
          <button className="wr-small-btn" onClick={onImportImages} disabled={loading}>
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
        <div style={{ display: "flex", gap: 8, padding: "16px 18px 0", alignItems: "center" }}>
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
        <div style={{ display: "flex", gap: 8, padding: "16px 18px 0", alignItems: "center" }}>
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
          <select
            className="wr-select"
            style={{ padding: "7px 10px" }}
            value={statusFilter}
            aria-label="阅读状态"
            onChange={(e) => setStatusFilter(e.currentTarget.value as "all" | ReadingStatus)}
          >
            <option value="all">全部状态</option>
            <option value="unread">{READING_STATUS_LABELS.unread}</option>
            <option value="reading">{READING_STATUS_LABELS.reading}</option>
            <option value="finished">{READING_STATUS_LABELS.finished}</option>
          </select>
          <button className="wr-btn" onClick={() => setManageTagsOpen(true)}>
            管理标签
          </button>
        </div>
      ) : null}

      {!trashView ? (
        <div className="wr-group-row" role="group" aria-label="书架路径">
          <button
            className="wr-group-chip"
            data-active={currentShelfId == null}
            aria-current={currentShelfId == null ? "page" : undefined}
            onClick={() => navigate("/")}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDragEnter={(e) => e.currentTarget.classList.add("drop-target")}
            onDragLeave={(e) => e.currentTarget.classList.remove("drop-target")}
            onDrop={(e) => dropOnShelf(e, null)}
          >
            全部
          </button>
          {path.map((s, i) => (
            <button
              key={s.id}
              className="wr-group-chip"
              data-active={i === path.length - 1}
              aria-current={i === path.length - 1 ? "page" : undefined}
              onClick={() => navigate(`/?shelf=${s.id}`)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDragEnter={(e) => e.currentTarget.classList.add("drop-target")}
              onDragLeave={(e) => e.currentTarget.classList.remove("drop-target")}
              onDrop={(e) => dropOnShelf(e, s.id)}
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
          {subShelves.map((s) => (
            <div
              key={s.id}
              className="wr-book-card wr-shelf-card"
              role="button"
              tabIndex={0}
              aria-label={`书架 ${s.name}，${counts.get(s.id) ?? 0} 本`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                setDragShelfId(s.id);
                setDragBookId(null);
              }}
              onDragEnd={() => {
                setDragShelfId(null);
                setDragBookId(null);
              }}
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
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDragEnter={(e) => e.currentTarget.classList.add("drop-target")}
              onDragLeave={(e) => e.currentTarget.classList.remove("drop-target")}
              onDrop={(e) => dropOnShelf(e, s.id)}
            >
              <div className="wr-cover" aria-hidden="true">
                <IconFolder className="wr-shelf-icon" width={30} height={30} />
              </div>
              <div className="wr-meta">
                <div className="wr-title" title={s.name}>{s.name}</div>
                <div className="wr-author">{counts.get(s.id) ?? 0} 本</div>
              </div>
            </div>
          ))}

          {booksFiltered.map((b) => (
            <div
              key={b.id}
              className="wr-book-card"
              role="button"
              tabIndex={0}
              data-selected={selectMode && selected.has(b.id)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/book-id", b.id);
                e.dataTransfer.effectAllowed = "move";
                setDragBookId(b.id);
                setDragShelfId(null);
              }}
              onDragEnd={() => {
                setDragBookId(null);
                setDragShelfId(null);
              }}
              onDragOver={(e) => {
                if (sortKey === "custom" && dragBookId && dragBookId !== b.id) {
                  e.preventDefault();
                  e.currentTarget.classList.add("drop-target");
                }
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove("drop-target")}
              onDrop={(e) => dropOnBook(e, b)}
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
