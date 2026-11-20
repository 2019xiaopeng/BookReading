import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import { save } from "@tauri-apps/plugin-dialog";

import type { Book, FavoriteQuote, Tag } from "../tauri/invoke";
import {
  deleteBooksFromDisk,
  deleteFavoriteQuote,
  exportAnnotations,
  getSettings,
  listBooks,
  listFavoriteBooks,
  listFavoriteQuotes,
  listReadingTimes,
  listTags,
  moveBooksToShelf,
  revealBookLocation,
  setBookFavorite,
  setSetting,
  updateBookMetadata,
} from "../tauri/invoke";
import { useCoverUrls } from "../library/useCoverUrls";
import BookCard from "../library/BookCard";
import BookDetailsDialog from "../library/BookDetailsDialog";
import { formatAuthor, formatTitle } from "../library/bookFormat";
import { shelfTreeRows } from "../library/shelves";
import { DENSITY_PRESETS, normalizeLibraryDensity, type LibraryDensity } from "../library/density";
import { applyRangeSelect } from "../library/rangeSelect";
import { BOOKS_CHANGED_EVENT } from "../library/importRunner";
import { formatReadingTime } from "../library/readingTime";
import { useShellShelves } from "../ui/AppShell";
import { setPageMeta } from "../ui/pageMeta";
import { subscribeAppRefresh } from "../ui/appActions";
import { showAlert, showConfirm } from "../ui/dialog";
import { showToast } from "../ui/toast";
import { IconBook, IconCheckSquare, IconDensity, IconQuote, IconStar, IconTrash } from "../ui/icons";

// F1-6：tab 会话内记忆（重挂不回到"收藏书籍"）；sessionStorage 够用且不污染跨会话
const FAV_TAB_KEY = "wr-fav-tab";

// F-3 收藏内排序（最近阅读/书名/作者），会话内 state，不落盘
type FavSortKey = "recent" | "title" | "author";

const FAV_SORT_LABELS: Record<FavSortKey, string> = {
  recent: "最近阅读",
  title: "书名",
  author: "作者",
};

// F-1：菜单状态自持（book=书卡 ⋯/右键同款；quote=摘录卡右键三动作）
type MenuState =
  | { kind: "book"; x: number; y: number; book: Book }
  | { kind: "quote"; x: number; y: number; quote: FavoriteQuote };

export default function FavoritesPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"books" | "quotes">(() => {
    try {
      return sessionStorage.getItem(FAV_TAB_KEY) === "quotes" ? "quotes" : "books";
    } catch {
      return "books";
    }
  });

  function changeTab(k: "books" | "quotes") {
    setTab(k);
    try {
      sessionStorage.setItem(FAV_TAB_KEY, k);
    } catch {
      // 私密窗口等场景存储被禁：仅失去记忆，不影响功能
    }
  }
  const [favoriteBooks, setFavoriteBooks] = useState<Book[]>([]);
  const [allBooks, setAllBooks] = useState<Book[]>([]);
  const [quotes, setQuotes] = useState<FavoriteQuote[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filterBookId, setFilterBookId] = useState<string | "all">("all");
  const [sortKey, setSortKey] = useState<FavSortKey>("recent");
  const [density, setDensity] = useState<LibraryDensity>("standard");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // R-2 Shift 范围多选锚点（退出选择即重置）
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [moveBookIds, setMoveBookIds] = useState<string[] | null>(null);
  const [detailsBook, setDetailsBook] = useState<Book | null>(null);
  const [readingTimes, setReadingTimes] = useState<Record<string, number>>({});
  const [dragBookId, setDragBookId] = useState<string | null>(null);
  const shelves = useShellShelves();
  const [tags, setTags] = useState<Tag[]>([]);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; label: string; cover?: string } | null>(null);

  const bookIdToTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of allBooks) {
      map.set(b.id, formatTitle(b));
    }
    return map;
  }, [allBooks]);

  // E10：收藏书 tab 不再全量 listBooks（书名卡片自身就有 title）；allBooks 只服务摘录 tab（筛选下拉/书名映射），由 refreshQuotes 拉取
  async function refreshBooks() {
    setFavoriteBooks(await listFavoriteBooks());
    // 详情弹窗的标签编辑可能新建/改色，顺带刷新（轻量单表）
    listTags().then(setTags).catch(() => {});
  }

  async function refreshQuotes() {
    const all = await listBooks();
    setAllBooks(all);
    const list = await listFavoriteQuotes({
      bookId: filterBookId === "all" ? null : filterBookId,
      query: query.trim() ? query.trim() : null,
    });
    setQuotes(list);
  }

  useEffect(() => {
    setLoading(true);
    refreshBooks().finally(() => setLoading(false));
    // E3 时长 chip（轻量单表）；刊头统计「摘录 N」首拉（进 quotes tab 时 refreshQuotes 会再刷新）
    listReadingTimes().then(setReadingTimes).catch(() => {});
    void listFavoriteQuotes({ bookId: null, query: null }).then(setQuotes).catch(() => {});
    getSettings()
      .then((m) => setDensity(normalizeLibraryDensity(m.library_density)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (tab !== "quotes") return;
    setLoading(true);
    refreshQuotes().finally(() => setLoading(false));
  }, [tab, filterBookId]);

  // silent refresh on window focus: returning to this page keeps data fresh (no manual refresh button)
  useEffect(() => {
    const onFocus = () => {
      if (tab === "books") void refreshBooks();
      else void refreshQuotes();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [tab, filterBookId, query]);

  // P-1 侧栏固定「刷新」钮：本视图订阅（当前 tab 对应的数据源重拉）
  useEffect(() => subscribeAppRefresh(() => {
    if (tab === "books") void refreshBooks();
    else void refreshQuotes();
  }), [tab, filterBookId, query]);

  // F1-7/H-1：Ctrl+F 聚焦搜索框（与书库页同款）
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

  const filteredBooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return favoriteBooks;
    return favoriteBooks.filter((b) => `${formatTitle(b)} ${formatAuthor(b)}`.toLowerCase().includes(q));
  }, [favoriteBooks, query]);

  const sortedBooks = useMemo(() => {
    const list = [...filteredBooks];
    if (sortKey === "title") {
      list.sort((a, b) => formatTitle(a).localeCompare(formatTitle(b), "zh"));
    } else if (sortKey === "author") {
      list.sort((a, b) => formatAuthor(a).localeCompare(formatAuthor(b), "zh") || formatTitle(a).localeCompare(formatTitle(b), "zh"));
    } else {
      list.sort((a, b) => (b.last_opened_at ?? b.added_at) - (a.last_opened_at ?? a.added_at));
    }
    return list;
  }, [filteredBooks, sortKey]);

  const coverUrls = useCoverUrls(sortedBooks, { preferThumb: true });

  function changeDensity(v: LibraryDensity) {
    setDensity(v);
    void setSetting("library_density", v);
  }

  // ---- 菜单（LibraryPage 同款交互语义：外点/Esc 关闭、箭头循环、视口钳制）----

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
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
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

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current;
    const clamp = () => {
      el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - el.offsetWidth - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - el.offsetHeight - 8))}px`;
    };
    clamp();
    el.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [menu]);

  const onCardMenu = (book: Book, anchor: HTMLElement | null, pos?: { x: number; y: number }) => {
    const r = anchor?.getBoundingClientRect();
    const x = pos?.x ?? r?.right ?? 8;
    const y = pos?.y ?? (r ? r.bottom + 4 : 8);
    openMenu({ kind: "book", x, y, book }, anchor);
  };

  // ---- 书操作（与书库 ⋯ 菜单同一后端调用）----

  async function onToggleFavorite(book: Book) {
    if (loading) return;
    setLoading(true);
    try {
      await setBookFavorite(book.id, !book.is_favorite);
      await refreshBooks();
    } catch (e) {
      await showAlert("收藏失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onTogglePinned(book: Book) {
    if (loading) return;
    setLoading(true);
    try {
      await updateBookMetadata({ book_id: book.id, pinned: !book.pinned_at });
      await refreshBooks();
    } catch (e) {
      await showAlert("操作失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onRevealBook(book: Book) {
    try {
      await revealBookLocation(book.id);
    } catch (e) {
      await showAlert("打开所在位置失败", String(e));
    }
  }

  async function onDeleteFromDisk(book: Book) {
    const ok = await showConfirm(
      "从电脑删除",
      `把《${formatTitle(book)}》的源文件（漫画为整个源文件夹）移入 Windows 回收站，并从书库移除？回收站内可找回。`,
      { danger: true, confirmText: "移入回收站" },
    );
    if (!ok) return;
    setLoading(true);
    try {
      await deleteBooksFromDisk([book.id]);
      await refreshBooks();
      window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
    } catch (e) {
      await showAlert("从电脑删除失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onMovePick(targetId: number | null) {
    const ids = moveBookIds;
    if (!ids) return;
    setMoveBookIds(null);
    try {
      await moveBooksToShelf(ids, targetId);
      if (ids.some((id) => selected.has(id))) setSelected(new Set());
      showToast(`已移动 ${ids.length} 本`); // H-3
      await refreshBooks();
      window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
    } catch (e) {
      await showAlert("移动失败", String(e));
    }
  }

  // ---- 批量（F-2：只保留有意义的三个动作）----

  // R-2 Shift 范围多选：范围=当前过滤排序后的可见列表闭区间
  const toggleSelected = (id: string, shift?: boolean) => {
    const r = applyRangeSelect(
      sortedBooks.map((b) => b.id),
      id,
      selected,
      !!shift,
      lastClickedId,
    );
    setSelected(r.selected);
    setLastClickedId(r.lastId);
  };

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
    setLastClickedId(null);
  }

  const allSelected = sortedBooks.length > 0 && sortedBooks.every((b) => selected.has(b.id));

  async function onBatchUnfavorite() {
    const ids = [...selected];
    if (ids.length === 0 || loading) return;
    setLoading(true);
    try {
      for (const id of ids) await setBookFavorite(id, false);
      setSelected(new Set());
      await refreshBooks();
      showToast(`已取消收藏 ${ids.length} 本`); // H-3
    } catch (e) {
      await showAlert("取消收藏失败", String(e));
    } finally {
      setLoading(false);
    }
  }

  // ---- 拖动到侧栏书架（F-1：书卡拖拽=移动归属，drop 目标全局已有）----

  // 拖动过的这次按压不能让 click 透传（同卡上按下-拖动-松开会触发 onClick 进阅读器）
  function suppressNextClick() {
    const stop = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      window.removeEventListener("click", stop, true);
    };
    window.addEventListener("click", stop, true);
  }

  function onCardPointerDown(e: ReactPointerEvent<HTMLElement>, book: Book, coverUrl?: string) {
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
      setOver(null);
      document.body.classList.remove("wr-card-dragging");
      setDragBookId(null);
      setDragGhost(null);
    }

    function onMove(ev: PointerEvent) {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        started = true;
        setDragBookId(book.id);
        document.body.classList.add("wr-card-dragging");
        setDragGhost({ x: ev.clientX, y: ev.clientY, label: formatTitle(book), cover: coverUrl });
      }
      const g = dragGhostRef.current;
      if (g) {
        g.style.left = `${ev.clientX + 14}px`;
        g.style.top = `${ev.clientY + 10}px`;
      }
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const t = hit instanceof HTMLElement ? hit.closest<HTMLElement>("[data-drop]") : null;
      setOver(t?.dataset.drop === "shelf" ? t : null);
    }

    function onUp() {
      const target = over;
      const was = started;
      if (was) suppressNextClick();
      cleanup();
      if (!was || !target) return;
      const sid = target.dataset.shelfId;
      const shelfId = sid && sid !== "" ? Number(sid) : null;
      void (async () => {
        try {
          await moveBooksToShelf([book.id], shelfId);
          showToast("已移动 1 本");
          await refreshBooks();
          window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
        } catch (e) {
          await showAlert("移动失败", String(e));
        }
      })();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cleanup);
  }

  // ---- 摘录（F-4：右键=菜单）----

  async function onCopyQuote(q: FavoriteQuote) {
    try {
      await navigator.clipboard.writeText(q.text);
      showToast("已复制");
    } catch (e) {
      await showAlert("复制失败", String(e));
    }
  }

  async function onDeleteQuote(q: FavoriteQuote) {
    const ok = await showConfirm("删除收藏", "确定删除这条收藏吗？", { danger: true, confirmText: "删除" });
    if (!ok) return;
    setLoading(true);
    try {
      await deleteFavoriteQuote(q.id);
      await refreshQuotes();
    } finally {
      setLoading(false);
    }
  }

  const readingTimeText = (id: string): string | null => {
    const t = formatReadingTime(readingTimes[id] ?? 0);
    return t ? `已读 ${t}` : null;
  };

  // 批次8：壳常驻，本页元信息布局期写入 pageMeta store（切页零闪烁）
  useLayoutEffect(() => {
    setPageMeta({
      active: "favorites",
      title: "收藏",
      search: {
        value: query,
        placeholder: tab === "books" ? "搜索书名 / 作者" : "搜索收藏句子",
        onChange: setQuery,
        onSubmit:
          tab === "quotes"
            ? () => {
                setLoading(true);
                refreshQuotes().finally(() => setLoading(false));
              }
            : undefined,
      },
      seg: {
        items: [
          { key: "books", label: "收藏书籍" },
          { key: "quotes", label: "收藏句子" },
        ],
        active: tab,
        onChange: (k) => {
          if (k === "books" || k === "quotes") changeTab(k);
        },
      },
      contextRow: (
        <span className="wr-quick-context">
          收藏 {favoriteBooks.length} 本 · 句子 {quotes.length} 条
        </span>
      ),
    });
  }, [tab, query, filterBookId, favoriteBooks.length, quotes.length]);

  return (
    <>
      {/* 批次12 U-1：刊头回归书库同款大版——四视图标题同字号同结构 */}
      <div className="wr-masthead">
        <h1 className="wr-masthead-name">收 藏</h1>
        <div className="wr-masthead-stats">
          收藏 {favoriteBooks.length} · 摘录 {quotes.length}
        </div>
      </div>

      {tab === "books" ? (
        <>
          <div className="wr-toolbar-row">
            <select
              className="wr-select"
              style={{ padding: "6px 10px" }}
              aria-label="排序"
              value={sortKey}
              onChange={(e) => setSortKey(e.currentTarget.value as FavSortKey)}
            >
              {(Object.keys(FAV_SORT_LABELS) as FavSortKey[]).map((k) => (
                <option key={k} value={k}>
                  {FAV_SORT_LABELS[k]}
                </option>
              ))}
            </select>
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

          <div
            className={density === "standard" ? "wr-book-grid" : `wr-book-grid wr-book-grid--${density}`}
            style={{ gridTemplateColumns: DENSITY_PRESETS[density].grid }}
          >
            {sortedBooks.map((b) => (
              <BookCard
                key={b.id}
                book={b}
                coverUrl={b.cover_path ? coverUrls[b.cover_path] : undefined}
                readingTimeText={readingTimeText(b.id)}
                favoriteQuickToggle={(book) => void onToggleFavorite(book)}
                selectMode={selectMode}
                selected={selected.has(b.id)}
                dragging={dragBookId === b.id}
                pop={false}
                loading={loading}
                onCardPointerDown={onCardPointerDown}
                onCardActivate={(id) => navigate(`/read/${id}`)}
                onCardSelectToggle={toggleSelected}
                onCardMenu={onCardMenu}
              />
            ))}

            {sortedBooks.length === 0 ? (
              <div className="wr-state" style={{ gridColumn: "1 / -1" }}>
                <span className="wr-state-icon" aria-hidden="true">
                  <IconStar />
                </span>
                {query.trim() ? (
                  <>
                    <div className="wr-state-title">没有匹配的收藏</div>
                    <div className="wr-state-sub">换个书名或作者试试</div>
                  </>
                ) : (
                  <>
                    <div className="wr-state-title">还没有收藏书籍</div>
                    <div className="wr-state-sub">去书架点一本书的“收藏”试试</div>
                  </>
                )}
              </div>
            ) : null}
          </div>

          {selectMode ? (
            <div className="wr-batch-bar" role="toolbar" aria-label="收藏批量操作">
              <span className="wr-batch-count">已选 {selected.size}</span>
              <button className="wr-btn" onClick={() => void onBatchUnfavorite()} disabled={selected.size === 0}>
                取消收藏
              </button>
              <button
                className="wr-btn"
                onClick={() => setMoveBookIds([...selected])}
                disabled={selected.size === 0}
              >
                移动到书架
              </button>
              <button className="wr-btn" onClick={() => setSelected(allSelected ? new Set() : new Set(sortedBooks.map((b) => b.id)))} disabled={sortedBooks.length === 0}>
                {allSelected ? "取消全选" : "全选"}
              </button>
              <button className="wr-btn" onClick={exitSelect}>
                取消
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "quotes" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 18 }}>
          <div className="wr-toolbar-row" style={{ padding: 0 }}>
            <select
              aria-label="按书籍筛选"
              className="wr-select"
              value={filterBookId}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setFilterBookId(v === "all" ? "all" : v);
              }}
            >
              <option value="all">全部书籍</option>
              {allBooks.map((b) => (
                <option key={b.id} value={b.id}>
                  {formatTitle(b)}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                setLoading(true);
                refreshQuotes().finally(() => setLoading(false));
              }}
              disabled={loading}
              className="wr-btn wr-btn-primary"
            >
              搜索
            </button>
            {/* E4 导出全部标注/收藏（bookId=null 全书库） */}
            <button
              onClick={() => {
                void (async () => {
                  const dest = await save({
                    defaultPath: "收藏摘录.md",
                    filters: [{ name: "Markdown", extensions: ["md"] }],
                  });
                  if (typeof dest !== "string") return;
                  try {
                    const written = await exportAnnotations(null, dest);
                    await showAlert("导出成功", written);
                  } catch (e) {
                    await showAlert("导出失败", String(e));
                  }
                })();
              }}
              disabled={loading}
              className="wr-btn"
            >
              导出全部
            </button>
          </div>

          {quotes.length === 0 ? (
            <div className="wr-state">
              <span className="wr-state-icon" aria-hidden="true">
                <IconQuote />
              </span>
              {query.trim() || filterBookId !== "all" ? (
                <>
                  <div className="wr-state-title">没有匹配的收藏句子</div>
                  <div className="wr-state-sub">调整筛选或搜索词再试</div>
                </>
              ) : (
                <>
                  <div className="wr-state-title">还没有收藏句子</div>
                  <div className="wr-state-sub">阅读时选中一段文字试试</div>
                </>
              )}
            </div>
          ) : (
            <div className="wr-quote-list">
              {quotes.map((q) => {
                const src = bookIdToTitle.get(q.book_id) ?? q.book_id;
                return (
                  <div
                    key={q.id}
                    className="wr-card wr-quote-card"
                    onContextMenu={(e) => {
                      // F-4：右键句子卡 = 菜单（复制/定位/删除）
                      e.preventDefault();
                      openMenu({ kind: "quote", x: e.clientX, y: e.clientY, quote: q }, e.currentTarget);
                    }}
                  >
                    <div className="wr-quote-text" title={q.text}>{q.text}</div>
                    {q.note ? <div className="wr-quote-note wr-muted" title={q.note}>{q.note}</div> : null}
                    <div className="wr-quote-foot">
                      <span className="wr-quote-src" title={src}>{src}</span>
                      <button
                        className="wr-mini-btn"
                        aria-label="打开定位"
                        title="打开定位"
                        onClick={() => navigate(`/read/${q.book_id}?cfi=${encodeURIComponent(q.cfi_range)}`)}
                      >
                        <IconBook width={16} height={16} />
                      </button>
                      <button
                        className="wr-mini-btn"
                        data-danger="true"
                        aria-label="删除收藏"
                        title="删除收藏"
                        disabled={loading}
                        onClick={() => void onDeleteQuote(q)}
                      >
                        <IconTrash width={16} height={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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
          ) : (
            <IconBook width={20} height={20} />
          )}
          <span>{dragGhost.label}</span>
        </div>
      ) : null}

      {menu ? (
        <div ref={menuRef} className="wr-menu" role="menu" style={{ left: menu.x, top: menu.y }} onKeyDown={onMenuKeyDown}>
          {menu.kind === "book" ? (
            <>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); navigate(`/read/${menu.book.id}`); }}>
                打开
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); setDetailsBook(menu.book); }}>
                详情
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); void onTogglePinned(menu.book); }}>
                {menu.book.pinned_at ? "取消置顶" : "置顶"}
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); void onToggleFavorite(menu.book); }}>
                {menu.book.is_favorite ? "取消收藏" : "收藏"}
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); setMoveBookIds([menu.book.id]); }}>
                移动到书架…
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                onClick={() => { closeMenu(); void onRevealBook(menu.book); }}
              >
                打开所在位置
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                data-danger="true"
                onClick={() => { closeMenu(); void onDeleteFromDisk(menu.book); }}
              >
                <IconTrash width={16} height={16} />
                从电脑删除
              </button>
            </>
          ) : (
            <>
              <button className="wr-menu-item" role="menuitem" onClick={() => { const q = menu.quote; closeMenu(); void onCopyQuote(q); }}>
                复制文本
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                onClick={() => { const q = menu.quote; closeMenu(); navigate(`/read/${q.book_id}?cfi=${encodeURIComponent(q.cfi_range)}`); }}
              >
                定位到原文
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                data-danger="true"
                onClick={() => { const q = menu.quote; closeMenu(); void onDeleteQuote(q); }}
              >
                删除收藏
              </button>
            </>
          )}
        </div>
      ) : null}

      {moveBookIds ? (
        <div
          className="wr-prompt-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMoveBookIds(null);
          }}
        >
          <div
            className="wr-panel wr-prompt wr-move-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="移动到书架"
            onKeyDown={(e) => {
              if (e.key === "Escape") setMoveBookIds(null);
            }}
          >
            <div style={{ fontWeight: 700 }}>移动到书架</div>
            <div className="wr-shelf-tree" role="listbox" aria-label="选择目标书架">
              <button onClick={() => void onMovePick(null)}>全部（根）</button>
              {shelfTreeRows(shelves).map((row) => (
                <button
                  key={row.id}
                  style={{ paddingLeft: 12 + row.depth * 14 }}
                  onClick={() => void onMovePick(row.id)}
                >
                  {row.name}
                </button>
              ))}
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
          onChanged={() => void refreshBooks()}
        />
      ) : null}
    </>
  );
}
