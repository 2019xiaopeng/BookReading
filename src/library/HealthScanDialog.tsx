import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import type { Book, LibraryHealth, MissingSource, Shelf, Tag } from "../tauri/invoke";
import { deleteBooksFromDisk, listBooks, listShelves, listTags, scanLibraryHealth } from "../tauri/invoke";
// 重链接复用阅读器的失链恢复命令（后端校验目录含图后改写 library_path）
import { relinkImageBook } from "../reader/image/api";
import { BOOKS_CHANGED_EVENT } from "./importRunner";
import { formatTitle } from "./bookFormat";
import { showAlert, showConfirm } from "../ui/dialog";
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

/**
 * 书库体检（P3）：挂载即扫描（150 本毫秒级，无需进度条），重复导入 / 失链 / 悬空封面三组列表；
 * “定位”=打开该书详情弹窗；失链可重链接（文件夹漫画）或从电脑删除；悬空封面给修复指引。
 */
export default function HealthScanDialog({ onClose }: { onClose: () => void }) {
  const [health, setHealth] = useState<LibraryHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [details, setDetails] = useState<Book | null>(null);

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

  const byId = new Map(books.map((b) => [b.id, b]));

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

  return (
    <div
      className="wr-prompt-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="wr-panel wr-prompt wr-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="书库体检"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busyId) onClose();
        }}
      >
        <div className="wr-prompt-title">书库体检</div>

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
            <div className="wr-settings-group">重复导入（{health.duplicates.length} 组）</div>
            <div className="wr-health-list">
              {health.duplicates.length === 0 ? (
                <span className="wr-health-ok">✔ 无</span>
              ) : (
                health.duplicates.map((g) => (
                  <div key={g.label} className="wr-health-row">
                    <span className="wr-health-icon" aria-hidden="true">
                      <IconBook width={16} height={16} />
                    </span>
                    <div className="wr-health-info">
                      <div className="wr-health-title" title={g.label}>
                        {g.label}
                      </div>
                      <div className="wr-health-meta">{g.bookIds.length} 本内容相同</div>
                    </div>
                    <div className="wr-health-actions">
                      {g.bookIds.map((id) => {
                        const b = byId.get(id);
                        return (
                          <button
                            key={id}
                            className="wr-btn"
                            title="打开书详情定位"
                            onClick={() => locate(id)}
                          >
                            {b ? formatTitle(b) : id}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="wr-settings-group">失链（{health.missingSources.length} 本）</div>
            <div className="wr-health-list">
              {health.missingSources.length === 0 ? (
                <span className="wr-health-ok">✔ 无</span>
              ) : (
                health.missingSources.map((m) => {
                  const row = missingSourceRow(m, byId.get(m.bookId));
                  return (
                    <div key={m.bookId} className="wr-health-row">
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
                          <button className="wr-btn" disabled={busyId === m.bookId} onClick={() => void onRelink(m)}>
                            重新链接
                          </button>
                        ) : null}
                        <button
                          className="wr-btn wr-btn-danger"
                          disabled={busyId === m.bookId}
                          onClick={() => void onDelete(m)}
                        >
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

        <div className="wr-prompt-actions">
          <button className="wr-btn wr-btn-primary" disabled={!!busyId} onClick={onClose}>
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
    </div>
  );
}
