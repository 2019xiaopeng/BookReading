import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import type { Book, DuplicateGroup, LibraryHealth, MissingSource, Shelf, Tag } from "../tauri/invoke";
import { deleteBooks, deleteBooksFromDisk, listBooks, listShelves, listTags, scanLibraryHealth } from "../tauri/invoke";
// 重链接复用阅读器的失链恢复命令（后端校验目录含图后改写 library_path）
import { relinkImageBook } from "../reader/image/api";
import { BOOKS_CHANGED_EVENT } from "./importRunner";
import { formatTitle } from "./bookFormat";
import { formatFileSize } from "./tags";
import { shelfPath } from "./shelves";
import { showAlert, showConfirm } from "../ui/dialog";
import { Modal } from "../ui/radix";
import { IconAlert, IconBook, IconFolder, IconImage, IconLibraryAll, IconRefresh } from "../ui/icons";
import BookDetailsDialog from "./BookDetailsDialog";

/** 失链分类文案：folder=文件夹漫画源目录没了；library=库内文件缺失 */
export function missingSourceLabel(kind: MissingSource["kind"]): string {
  return kind === "folder" ? "源目录已移动" : "库内文件缺失";
}

export type MissingRow = { title: string; kindLabel: string; canRelink: boolean };

/** 失链行展示与动作判定：重链接只对“源目录被移动的文件夹漫画”开放（库内文件缺失无从指路） */
export function missingSourceRow(m: MissingSource, book: Book | undefined): MissingRow {
  return {
    title: book?.title?.trim() || m.title?.trim() || m.bookId,
    kindLabel: missingSourceLabel(m.kind),
    canRelink: m.kind === "folder" && book?.format === "images",
  };
}

/** 一本书的存放位置文案：原地引用 / 外部目录显示原路径；库内副本标明"书库内"并给库内相对路径 */
export function bookLocationLabel(libraryPath: string): string {
  return /^[a-zA-Z]:[\\/]/.test(libraryPath) ? libraryPath : `书库内 · ${libraryPath}`;
}

export type DuplicateCopy = {
  bookId: string;
  title: string;
  location: string;
  shelf: string;
  size: string | null;
  addedAt: number | null;
};

/**
 * 重复组展开成逐份副本（按导入时间升序，先导入的排前），每份带位置与所在书架——
 * 用户据此判断"重复导到了哪个目录"、决定保留哪一份。库里已无记录的副本如实标注。
 */
export function duplicateCopies(g: DuplicateGroup, books: Book[], shelves: Shelf[]): DuplicateCopy[] {
  const byId = new Map(books.map((b) => [b.id, b]));
  return [...g.bookIds]
    .map((id): DuplicateCopy => {
      const b = byId.get(id);
      const shelf = shelfPath(shelves, b?.shelf_id ?? null)
        .map((s) => s.name)
        .join(" / ");
      return {
        bookId: id,
        title: b ? formatTitle(b) : id,
        location: b ? bookLocationLabel(b.library_path) : "书库中已无记录",
        shelf: shelf || "未归书架",
        size: b?.file_size ? formatFileSize(b.file_size) : null,
        addedAt: b?.added_at ?? null,
      };
    })
    .sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
}

export type SelectionSplit = { missingIds: string[]; dupIds: string[]; dupGroupsFullySelected: number };

/** 勾选集按处理方式拆开：失链走"从电脑删除"，重复项走"移入书库回收站"（两种语义不同，各用一个批量钮、各确认一次） */
export function selectionSplit(selected: Set<string>, health: LibraryHealth): SelectionSplit {
  const missingIds = health.missingSources.map((m) => m.bookId).filter((id) => selected.has(id));
  const dupIds = health.duplicates.flatMap((g) => g.bookIds).filter((id) => selected.has(id));
  const dupGroupsFullySelected = health.duplicates.filter(
    (g) => g.bookIds.length > 0 && g.bookIds.every((id) => selected.has(id)),
  ).length;
  return { missingIds, dupIds, dupGroupsFullySelected };
}

/** 确认框里的条目清单：最多列 8 条，其余以"等 N 项"收尾 */
function confirmList(items: string[]): string {
  const shown = items.slice(0, 8).map((t) => `· ${t}`).join("\n");
  return items.length > 8 ? `${shown}\n…等共 ${items.length} 项` : shown;
}

/**
 * 书库体检：挂载即扫描，重复导入 / 失链 / 悬空封面三组列表。
 * v3.2（用户 2026-11-25）：弹窗放大且行内不横向溢出；失链与重复项可勾选，底部一次确认批量处理；
 * 重复导入按份列出位置 / 书架。"定位 / 详情"= 打开该书详情弹窗；失链可重链接（文件夹漫画）或从电脑删除。
 */
export default function HealthScanDialog({ onClose }: { onClose: () => void }) {
  const [health, setHealth] = useState<LibraryHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Book | null>(null);
  const busy = busyId !== null || batchBusy;

  async function scan() {
    setError(null);
    setHealth(null);
    try {
      const [h, list, shelfList, tagList] = await Promise.all([
        scanLibraryHealth(),
        listBooks(),
        listShelves(),
        listTags(),
      ]);
      setHealth(h);
      setBooks(list);
      setShelves(shelfList);
      setTags(tagList);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void scan();
  }, []);

  // 重新扫描后丢掉已不在问题清单里的勾选（处理掉的、或别处已修好的）
  useEffect(() => {
    if (!health) return;
    const alive = new Set<string>([
      ...health.missingSources.map((m) => m.bookId),
      ...health.duplicates.flatMap((g) => g.bookIds),
    ]);
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [health]);

  const byId = new Map(books.map((b) => [b.id, b]));
  const split = health
    ? selectionSplit(selected, health)
    : { missingIds: [], dupIds: [], dupGroupsFullySelected: 0 };
  const missingIds = health ? health.missingSources.map((m) => m.bookId) : [];
  const dupIds = health ? health.duplicates.flatMap((g) => g.bookIds) : [];

  const nameOf = (id: string) =>
    byId.get(id)?.title?.trim() || health?.missingSources.find((m) => m.bookId === id)?.title?.trim() || id;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(ids: string[]) {
    const all = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function locate(id: string) {
    const b = byId.get(id);
    if (b) setDetails(b);
  }

  async function onRelink(m: MissingSource) {
    const picked = await open({ directory: true, multiple: false, title: "重新选择漫画源文件夹" });
    if (!picked || Array.isArray(picked)) return;
    setBusyId(m.bookId);
    try {
      await relinkImageBook(m.bookId, picked);
      window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
      await scan();
    } catch (e) {
      await showAlert("重链接失败", String(e));
    } finally {
      setBusyId(null);
    }
  }

  // 源已缺失时等价彻底删除：deleteBooksFromDisk 对不存在路径安全跳过，DB 记录与缓存照清
  async function onDelete(m: MissingSource) {
    const title = byId.get(m.bookId)?.title?.trim() || m.title?.trim() || m.bookId;
    const ok = await showConfirm(
      "从电脑删除",
      `把《${title}》的源文件（漫画为整个源文件夹）移入 Windows 回收站，并从书库移除？回收站内可找回。`,
      { danger: true, confirmText: "移入回收站" },
    );
    if (!ok) return;
    setBusyId(m.bookId);
    try {
      await deleteBooksFromDisk([m.bookId]);
      window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
      await scan();
    } catch (e) {
      await showAlert("从电脑删除失败", String(e));
    } finally {
      setBusyId(null);
    }
  }

  // 批量：勾选的失链一次删完，只确认一次（语义同单条"从电脑删除"）
  async function batchDeleteMissing(ids: string[]) {
    if (ids.length === 0 || busy) return;
    const ok = await showConfirm(
      `从电脑删除所选的 ${ids.length} 本失链书籍`,
      `源文件（漫画为整个源文件夹）如仍存在将移入 Windows 回收站，并从书库移除；已不存在的不受影响。\n\n${confirmList(ids.map(nameOf))}`,
      { danger: true, confirmText: `移入回收站并移除 ${ids.length} 本` },
    );
    if (!ok) return;
    setBatchBusy(true);
    try {
      await deleteBooksFromDisk(ids);
      window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
      await scan();
    } catch (e) {
      await showAlert("从电脑删除失败", String(e));
    } finally {
      setBatchBusy(false);
    }
  }

  // 批量：勾选的重复份一次移入书库回收站（软删，可恢复），只确认一次
  async function batchTrashDuplicates(ids: string[]) {
    if (ids.length === 0 || busy) return;
    const whole = split.dupGroupsFullySelected;
    const ok = await showConfirm(
      `把所选的 ${ids.length} 份重复书籍移入回收站`,
      `移入书库回收站，回收站内可恢复或彻底删除。${
        whole ? `\n\n注意：其中 ${whole} 组的全部副本都被选中了——移入后这些书将不在任何书架上。` : ""
      }\n\n${confirmList(ids.map(nameOf))}`,
      { danger: whole > 0, confirmText: `移入回收站 ${ids.length} 份` },
    );
    if (!ok) return;
    setBatchBusy(true);
    try {
      await deleteBooks(ids);
      window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
      await scan();
    } catch (e) {
      await showAlert("移入回收站失败", String(e));
    } finally {
      setBatchBusy(false);
    }
  }

  const selectedCount = split.missingIds.length + split.dupIds.length;

  return (
    <Modal label="书库体检" onClose={() => { if (!busy) onClose(); }} panelClassName="wr-panel wr-prompt wr-dialog wr-health-dialog">
      <div className="wr-health-frame">
        <div className="wr-health-top">
          <div className="wr-prompt-title">书库体检</div>
          <div className="wr-health-top-sub">勾选条目后可在底部一次处理，只确认一次</div>
        </div>

        <div className="wr-health-scroll">
          {error ? (
            <div className="wr-state">
              <span className="wr-state-icon" aria-hidden="true">
                <IconAlert />
              </span>
              <div className="wr-state-title">扫描失败</div>
              <div className="wr-state-sub" style={{ overflowWrap: "anywhere" }}>
                {error}
              </div>
              <button className="wr-btn" onClick={() => void scan()}>
                <IconRefresh />
                重试
              </button>
            </div>
          ) : !health ? (
            <div className="wr-state">
              <span className="wr-state-icon" aria-hidden="true">
                <IconRefresh />
              </span>
              <div className="wr-state-title">扫描中…</div>
              <div className="wr-state-sub">检查重复导入、失链与悬空封面</div>
            </div>
          ) : (
            <>
              <div className="wr-health-sec">
                <div className="wr-settings-group">重复导入（{health.duplicates.length} 组）</div>
                {dupIds.length > 0 ? (
                  <button type="button" className="wr-health-sel" disabled={busy} onClick={() => toggleAll(dupIds)}>
                    {dupIds.every((id) => selected.has(id)) ? "取消全选" : "全选重复项"}
                  </button>
                ) : null}
              </div>
              <div className="wr-health-list">
                {health.duplicates.length === 0 ? (
                  <span className="wr-health-ok">✔ 无</span>
                ) : (
                  health.duplicates.map((g) => {
                    const copies = duplicateCopies(g, books, shelves);
                    return (
                      <div key={g.label} className="wr-health-group">
                        <div className="wr-health-group-head">
                          <span className="wr-health-icon" aria-hidden="true">
                            <IconBook width={16} height={16} />
                          </span>
                          <div className="wr-health-info">
                            <div className="wr-health-title" title={g.label}>
                              {g.label}
                            </div>
                            <div className="wr-health-meta">
                              {copies.length} 份内容相同 · 对照位置留一份，勾选其余的移入回收站
                            </div>
                          </div>
                        </div>
                        {copies.map((c) => (
                          <div key={c.bookId} className="wr-health-copy">
                            <input
                              type="checkbox"
                              className="wr-health-check"
                              aria-label={`选择重复项（${c.location}）`}
                              checked={selected.has(c.bookId)}
                              disabled={busy}
                              onChange={() => toggle(c.bookId)}
                            />
                            <div className="wr-health-info">
                              <div className="wr-health-meta">位置 · {c.location}</div>
                              <div className="wr-health-meta">
                                {c.title !== g.label ? `标题 · ${c.title} · ` : ""}书架 · {c.shelf}
                                {c.size ? ` · 大小 · ${c.size}` : ""}
                                {c.addedAt ? ` · 导入于 ${new Date(c.addedAt * 1000).toLocaleDateString()}` : ""}
                              </div>
                            </div>
                            <button type="button" className="wr-btn" disabled={busy} onClick={() => locate(c.bookId)}>
                              详情
                            </button>
                          </div>
                        ))}
                      </div>
                    );
                  })
                )}
              </div>

              <div className="wr-health-sec">
                <div className="wr-settings-group">失链（{health.missingSources.length} 本）</div>
                {missingIds.length > 0 ? (
                  <button type="button" className="wr-health-sel" disabled={busy} onClick={() => toggleAll(missingIds)}>
                    {missingIds.every((id) => selected.has(id)) ? "取消全选" : "全选失链"}
                  </button>
                ) : null}
              </div>
              <div className="wr-health-list">
                {health.missingSources.length === 0 ? (
                  <span className="wr-health-ok">✔ 无</span>
                ) : (
                  health.missingSources.map((m) => {
                    const row = missingSourceRow(m, byId.get(m.bookId));
                    return (
                      <div key={m.bookId} className="wr-health-row">
                        <input
                          type="checkbox"
                          className="wr-health-check"
                          aria-label={`选择《${row.title}》`}
                          checked={selected.has(m.bookId)}
                          disabled={busy}
                          onChange={() => toggle(m.bookId)}
                        />
                        <span className="wr-health-icon" aria-hidden="true">
                          {m.kind === "folder" ? (
                            <IconFolder width={16} height={16} />
                          ) : (
                            <IconLibraryAll width={16} height={16} />
                          )}
                        </span>
                        <div className="wr-health-info">
                          <div className="wr-health-title">{row.title}</div>
                          <div className="wr-health-meta" title={m.path}>
                            {row.kindLabel} · {m.path}
                          </div>
                        </div>
                        <div className="wr-health-actions">
                          {row.canRelink ? (
                            <button className="wr-btn" disabled={busy} onClick={() => void onRelink(m)}>
                              重新链接
                            </button>
                          ) : null}
                          <button className="wr-btn wr-btn-danger" disabled={busy} onClick={() => void onDelete(m)}>
                            从电脑删除
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="wr-settings-group">悬空封面（{health.missingCovers.length} 本）</div>
              <div className="wr-health-list">
                {health.missingCovers.length === 0 ? (
                  <span className="wr-health-ok">✔ 无</span>
                ) : (
                  health.missingCovers.map((c) => (
                    <div key={c.bookId} className="wr-health-row">
                      {/* 与上面两组对齐：占住勾选框的位置（封面缺失没有批量动作） */}
                      <span className="wr-health-check" aria-hidden="true" />
                      <span className="wr-health-icon" aria-hidden="true">
                        <IconImage width={16} height={16} />
                      </span>
                      <div className="wr-health-info">
                        <div className="wr-health-title">
                          {c.title?.trim() || byId.get(c.bookId)?.title?.trim() || c.bookId}
                        </div>
                        <div className="wr-health-meta" title={c.coverPath}>
                          封面文件缺失 · 可在详情中更换封面修复
                        </div>
                      </div>
                      <div className="wr-health-actions">
                        <button className="wr-btn" onClick={() => locate(c.bookId)}>
                          定位
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        <div className="wr-health-foot">
          <span className="wr-health-foot-count">
            {selectedCount > 0
              ? `已选 ${selectedCount} 项（失链 ${split.missingIds.length} · 重复项 ${split.dupIds.length}）`
              : "勾选条目后可批量处理"}
          </span>
          {split.missingIds.length > 0 ? (
            <button
              type="button"
              className="wr-btn wr-btn-danger"
              disabled={busy}
              onClick={() => void batchDeleteMissing(split.missingIds)}
            >
              删除所选失链 {split.missingIds.length} 本
            </button>
          ) : null}
          {split.dupIds.length > 0 ? (
            <button
              type="button"
              className="wr-btn wr-btn-danger"
              disabled={busy}
              onClick={() => void batchTrashDuplicates(split.dupIds)}
            >
              重复项移入回收站 {split.dupIds.length} 份
            </button>
          ) : null}
          <button className="wr-btn" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      {details ? (
        <BookDetailsDialog
          book={details}
          tags={tags}
          shelves={shelves}
          onClose={() => setDetails(null)}
          onChanged={() => void scan()}
        />
      ) : null}
    </Modal>
  );
}
