import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";

import type { Book, UpdateBookMetadataRequest } from "../tauri/invoke";
import {
  deleteBook,
  getSettings,
  importBook,
  listBooks,
  listImageSubdirs,
  repairBookMetadata,
  saveReaderBackground,
  setBookCover,
  setBookFavorite,
  setSetting,
  updateBookMetadata,
} from "../tauri/invoke";
import { importImageFolder } from "../reader/image/api";
import { needsMetadataRepair } from "../library/metadataRepair";
import { DENSITY_PRESETS, normalizeLibraryDensity, type LibraryDensity } from "../library/density";
import { invalidateCoverUrl, requestCoverUrl, useCoverUrls } from "../library/useCoverUrls";
import { notifyBackgroundChanged, resetBackgroundCache } from "../ui/appBackground";
import type { ReaderBackground } from "../reader/settings/types";
import { logFrontend } from "../tauri/frontendLog";
import AppShell from "../ui/AppShell";
import { IconBook, IconImage, IconMore, IconPin, IconRefresh } from "../ui/icons";

function formatTitle(book: Book): string {
  return book.title?.trim() || "未命名";
}

function formatAuthor(book: Book): string {
  return book.author?.trim() || "未知作者";
}

function progressText(book: Book): string {
  return typeof book.reading_percent === "number" ? `读到 ${Math.round(book.reading_percent * 100)}%` : "未读";
}

type SortKey = "recent" | "title" | "added";

type MenuState =
  | { kind: "grid"; x: number; y: number }
  | { kind: "book"; x: number; y: number; book: Book }
  | { kind: "group"; x: number; y: number; group: string };

type PromptState = {
  title: string;
  value: string;
  /** true = 空提交合法（分组/备注留空即清除） */
  allowEmpty: boolean;
  onConfirm: (value: string) => void;
};

export default function LibraryPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("全部");
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [sortAsc, setSortAsc] = useState(false);
  const [density, setDensity] = useState<LibraryDensity>("standard");
  // session-only groups created via 新建分组 but not yet holding any book (groups otherwise derive from books)
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const repairingRef = useRef<Set<string>>(new Set());
  const attemptedRef = useRef<Set<string>>(new Set());
  const coverUrls = useCoverUrls(books);

  const groups = useMemo(
    () =>
      [...new Set([...extraGroups, ...books.map((b) => b.group_name).filter((g): g is string => !!g)])].sort((a, b) =>
        a.localeCompare(b, "zh"),
      ),
    [books, extraGroups],
  );

  const booksFiltered = useMemo(() => {
    let list = books;
    if (groupFilter === "未分组") list = list.filter((b) => !b.group_name);
    else if (groupFilter !== "全部") list = list.filter((b) => b.group_name === groupFilter);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((b) => `${formatTitle(b)} ${formatAuthor(b)}`.toLowerCase().includes(q));
    }
    const dir = sortAsc ? 1 : -1;
    return [...list].sort((a, b) => {
      const pinned = Number(!!b.pinned_at) - Number(!!a.pinned_at);
      if (pinned !== 0) return pinned;
      if (sortKey === "title") return dir * formatTitle(a).localeCompare(formatTitle(b), "zh");
      if (sortKey === "added") return dir * (a.added_at - b.added_at);
      return dir * ((a.last_opened_at ?? a.added_at) - (b.last_opened_at ?? b.added_at));
    });
  }, [books, query, groupFilter, sortKey, sortAsc]);

  async function refresh() {
    const list = await listBooks();
    setBooks(list);
  }

  useEffect(() => {
    refresh();
    getSettings()
      .then((m) => setDensity(normalizeLibraryDensity(m.library_density)))
      .catch(() => {});
  }, []);

  // 侧栏分组导航写 URL（/?group=…），与 AppShell 同源；chips 点击仍是本地态不写 URL
  useEffect(() => {
    setGroupFilter(searchParams.get("group") ?? "全部");
  }, [searchParams]);

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
        window.alert(`部分文件导入失败（${failed.length} 个）：\n${failed.join("\n")}\n仅支持 EPUB、TXT（UTF-8/GBK）与 CBZ 漫画`);
      }

      await refresh();
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
        window.alert(`导入失败：${String(e)}`);
        logFrontend(`ui: import image folder failed ${dir} ${String(e)}`);
      }
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  // 批量导入：选父目录 → 每个一级子文件夹各导入一本漫画（空/无图目录服务端已过滤），失败逐个记日志不中断
  async function onBatchImportImages() {
    if (loading) return;
    const parent = await open({ directory: true, multiple: false, title: "选择漫画父目录（每个一级子文件夹导入一本）" });
    if (!parent || Array.isArray(parent)) return;
    setLoading(true);
    try {
      const dirs = await listImageSubdirs(parent);
      if (dirs.length === 0) {
        window.alert("该目录下没有包含图片的一级子文件夹");
        return;
      }
      const failed: string[] = [];
      for (const dir of dirs) {
        try {
          await importImageFolder(dir, null); // title=null → 取子目录名
        } catch (e) {
          failed.push(dir);
          logFrontend(`ui: batch import failed ${dir} ${String(e)}`);
        }
      }
      window.alert(`导入 ${dirs.length - failed.length} 本，失败 ${failed.length} 个`);
      await refresh();
    } catch (e) {
      window.alert(`批量导入失败：${String(e)}`);
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
      window.alert(`设置背景失败：${String(e)}`);
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
      window.alert(`设置背景失败：${String(e)}`);
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
      window.alert(`设置封面失败：${String(e)}`);
    }
  }

  async function onDelete(book: Book) {
    if (loading) return;
    const isFolderComic = book.format === "images" && !book.library_path.toLowerCase().endsWith(".cbz");
    const ok = window.confirm(
      `确定删除《${formatTitle(book)}》吗？阅读进度、书签与标注将一并删除，且不可恢复。` +
        (isFolderComic ? "源文件夹不会被改动，仅移除本书记录与封面。" : ""),
    );
    if (!ok) return;

    setLoading(true);
    try {
      await deleteBook(book.id);
      await refresh();
    } catch (e) {
      window.alert(String(e));
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
      window.alert(String(e));
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

  function onSetGroup(book: Book) {
    setPrompt({
      title: "分组名称（留空清除）",
      value: book.group_name ?? "",
      allowEmpty: true,
      onConfirm: (v) => onChipUpdate({ book_id: book.id, group_name: v }),
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

  function onNewGroup() {
    setPrompt({
      title: "新分组名称",
      value: "",
      allowEmpty: false,
      onConfirm: (name) => {
        setExtraGroups((prev) => (prev.includes(name) ? prev : [...prev, name]));
        setGroupFilter(name);
      },
    });
  }

  function onRenameGroup(group: string) {
    setPrompt({
      title: "分组名称",
      value: group,
      allowEmpty: false,
      onConfirm: (name) => {
        if (name === group) return;
        setExtraGroups((prev) => prev.map((g) => (g === group ? name : g)));
        if (groupFilter === group) setGroupFilter(name);
        void runUpdates(
          books.filter((b) => b.group_name === group).map((b) => ({ book_id: b.id, group_name: name })),
        );
      },
    });
  }

  function onDeleteGroup(group: string) {
    if (!window.confirm(`删除分组“${group}”？组内书籍保留，归入“未分组”。`)) return;
    setExtraGroups((prev) => prev.filter((g) => g !== group));
    if (groupFilter === group) setGroupFilter("全部");
    void runUpdates(
      books.filter((b) => b.group_name === group).map((b) => ({ book_id: b.id, group_name: "" })),
    );
  }

  function onDropToGroup(e: DragEvent<HTMLButtonElement>, chip: string) {
    e.preventDefault();
    e.currentTarget.classList.remove("drop-target");
    if (chip === "全部") return;
    const id = e.dataTransfer.getData("text/book-id");
    if (!id) return;
    void runUpdates([{ book_id: id, group_name: chip === "未分组" ? "" : chip }]);
  }

  return (
    <AppShell
      active="library"
      title="书架"
      search={{ value: query, placeholder: "搜索书名 / 作者", onChange: setQuery }}
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
            aria-pressed={sortAsc}
            aria-label={`排序方向：${sortAsc ? "升序" : "降序"}`}
            title={`排序方向：${sortAsc ? "升序" : "降序"}`}
            onClick={() => setSortAsc((v) => !v)}
          >
            {sortAsc ? "↑ 升序" : "↓ 降序"}
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

      {groups.length > 0 ? (
        <div className="wr-group-row" role="group" aria-label="分组筛选">
          {["全部", "未分组", ...groups].map((chip) => (
            <button
              key={chip}
              className="wr-group-chip"
              data-active={groupFilter === chip}
              aria-pressed={groupFilter === chip}
              onClick={() => setGroupFilter(chip)}
              onContextMenu={(e) => {
                if (!groups.includes(chip)) return;
                e.preventDefault();
                openMenu({ kind: "group", x: e.clientX, y: e.clientY, group: chip }, e.currentTarget);
              }}
              onDragOver={(e) => {
                if (chip === "全部") return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDragEnter={(e) => {
                if (chip !== "全部") e.currentTarget.classList.add("drop-target");
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove("drop-target")}
              onDrop={(e) => onDropToGroup(e, chip)}
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className={density === "standard" ? "wr-book-grid" : `wr-book-grid wr-book-grid--${density}`}
        style={{ gridTemplateColumns: DENSITY_PRESETS[density].grid }}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest(".wr-book-card")) return;
          e.preventDefault();
          openMenu({ kind: "grid", x: e.clientX, y: e.clientY }, e.currentTarget);
        }}
      >
        {booksFiltered.map((b) => (
          <div
            key={b.id}
            className="wr-book-card"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/book-id", b.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; navigate(`/read/${b.id}`); }}
          >
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
                    <span className="wr-chip-dot" />
                    <span>读到 {Math.round(b.reading_percent * 100)}%</span>
                  </div>
                </div>
              ) : null}
            </div>

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
          </div>
        ))}

        {booksFiltered.length === 0 ? (
          <div className="wr-muted" style={{ padding: 16, gridColumn: "1 / -1" }}>
            {query.trim()
              ? "没有匹配的书籍"
              : groupFilter !== "全部"
                ? "该分组暂无书籍"
                : "书架还是空的，从左下角导入第一本书，或在空白处右键"}
          </div>
        ) : null}
      </div>

      {menu ? (
        <div ref={menuRef} className="wr-menu" role="menu" style={{ left: menu.x, top: menu.y }} onKeyDown={onMenuKeyDown}>
          {menu.kind === "grid" ? (
            <>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); onNewGroup(); }}>
                新建分组
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
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu();setSortAsc((v) => !v); }}>
                {sortAsc ? "切换为降序" : "切换为升序"}
              </button>
            </>
          ) : menu.kind === "book" ? (
            <>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); onRenameBook(menu.book); }}>
                重命名
              </button>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); onSetGroup(menu.book); }}>
                设置分组
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
                onClick={() => { closeMenu(); void onDelete(menu.book); }}
              >
                删除
              </button>
            </>
          ) : (
            <>
              <button className="wr-menu-item" role="menuitem" onClick={() => { closeMenu(); onRenameGroup(menu.group); }}>
                重命名分组
              </button>
              <button
                className="wr-menu-item"
                role="menuitem"
                data-danger="true"
                onClick={() => { closeMenu(); onDeleteGroup(menu.group); }}
              >
                删除分组
              </button>
            </>
          )}
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
    </AppShell>
  );
}
