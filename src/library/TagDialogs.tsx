import { useEffect, useRef, useState } from "react";

import type { Tag } from "../tauri/invoke";
import { deleteTag, mergeTags, recolorTag, renameTag } from "../tauri/invoke";
import { showAlert, showConfirm } from "../ui/dialog";
import { TAG_COLORS, tagDotColor } from "./tags";

function TagDot({ color }: { color: string | null }) {
  return <span className="wr-tag-dot" style={{ background: tagDotColor(color) }} aria-hidden="true" />;
}

export { TagDot };

/** 可勾选标签列表：筛选下拉与批量打标对话框共用 */
export function TagToggleList({
  tags,
  selected,
  onToggle,
}: {
  tags: Tag[];
  selected: Set<number>;
  onToggle: (id: number) => void;
}) {
  if (tags.length === 0) return <div className="wr-muted" style={{ fontSize: 12, padding: "4px 2px" }}>还没有标签</div>;
  return (
    <div className="wr-tag-list" role="group" aria-label="标签列表">
      {tags.map((t) => (
        <button
          key={t.id}
          type="button"
          className="wr-tag-item"
          role="checkbox"
          aria-checked={selected.has(t.id)}
          data-checked={selected.has(t.id)}
          onClick={() => onToggle(t.id)}
        >
          <TagDot color={t.color} />
          <span className="wr-tag-item-name">{t.name}</span>
          <span className="wr-tag-item-count">{t.book_count}</span>
        </button>
      ))}
    </div>
  );
}

/** 筛选行标签下拉（多选，AND 语义） */
export function TagFilterMenu({
  tags,
  selected,
  onChange,
}: {
  tags: Tag[];
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeNames = tags.filter((t) => selected.has(t.id)).map((t) => t.name);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="wr-btn"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        标签{selected.size > 0 ? ` · ${selected.size}` : ""}▾
      </button>
      {open ? (
        <div className="wr-tag-pop" role="dialog" aria-label="按标签筛选">
          <TagToggleList
            tags={tags}
            selected={selected}
            onToggle={(id) => {
              const next = new Set(selected);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              onChange(next);
            }}
          />
          {selected.size > 0 ? (
            <button type="button" className="wr-btn" style={{ width: "100%", fontSize: 12 }} onClick={() => onChange(new Set())}>
              清除标签筛选
            </button>
          ) : null}
        </div>
      ) : null}
      {activeNames.length > 0 ? (
        <span className="wr-muted" style={{ fontSize: 12, marginLeft: 6 }} title={activeNames.join(" + ")}>
          {activeNames.join(" + ")}
        </span>
      ) : null}
    </div>
  );
}

/** 批量打标对话框：多选后确认，只增不减 */
export function BatchTagDialog({
  tags,
  bookCount,
  onConfirm,
  onClose,
}: {
  tags: Tag[];
  bookCount: number;
  onConfirm: (tagIds: number[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  return (
    <div
      className="wr-prompt-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="wr-panel wr-prompt"
        role="dialog"
        aria-modal="true"
        aria-label="批量打标签"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="wr-prompt-title">给选中的 {bookCount} 本书打标签</div>
        <TagToggleList
          tags={tags}
          selected={selected}
          onToggle={(id) => {
            const next = new Set(selected);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            setSelected(next);
          }}
        />
        <div className="wr-prompt-actions">
          <button className="wr-btn" onClick={onClose}>
            取消
          </button>
          <button className="wr-btn wr-btn-primary" disabled={selected.size === 0} onClick={() => onConfirm([...selected])}>
            打标签
          </button>
        </div>
      </div>
    </div>
  );
}

/** 标签管理：改名 / 换色 / 合并 / 删除（仅解除关联） */
export function ManageTagsDialog({ tags, onChanged, onClose }: { tags: Tag[]; onChanged: () => void; onClose: () => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [mergeTo, setMergeTo] = useState<string>("");

  async function run(action: () => Promise<void>) {
    try {
      await action();
      setEditing(null);
      onChanged();
    } catch (e) {
      await showAlert("操作失败", String(e));
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
        aria-label="管理标签"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="wr-prompt-title">管理标签</div>
        {tags.length === 0 ? (
          <div className="wr-muted" style={{ fontSize: 13 }}>
            还没有标签。在书籍详情里输入名字即可创建。
          </div>
        ) : (
          <div className="wr-tag-manage-list">
            {tags.map((t) => (
              <div key={t.id} className="wr-tag-manage-row">
                <div className="wr-tag-manage-head">
                  <TagDot color={t.color} />
                  <span className="wr-tag-item-name">{t.name}</span>
                  <span className="wr-tag-item-count">{t.book_count} 本</span>
                  <button
                    type="button"
                    className="wr-btn"
                    style={{ marginLeft: "auto", fontSize: 12, padding: "4px 10px" }}
                    aria-expanded={editing === t.id}
                    onClick={() => {
                      if (editing === t.id) {
                        setEditing(null);
                        return;
                      }
                      setEditing(t.id);
                      setName(t.name);
                      setMergeTo("");
                    }}
                  >
                    {editing === t.id ? "收起" : "管理"}
                  </button>
                </div>
                {editing === t.id ? (
                  <div className="wr-tag-manage-editor">
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        className="wr-input"
                        value={name}
                        aria-label="标签名称"
                        onChange={(e) => setName(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && name.trim() && name.trim() !== t.name) {
                            void run(() => renameTag(t.id, name.trim()));
                          }
                        }}
                      />
                      <button className="wr-btn" disabled={!name.trim() || name.trim() === t.name} onClick={() => void run(() => renameTag(t.id, name.trim()))}>
                        改名
                      </button>
                    </div>
                    <div className="wr-tag-swatch-row" role="group" aria-label="标签颜色">
                      {TAG_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className="wr-swatch-btn"
                          data-selected={t.color === c}
                          style={{ background: c, width: 24, height: 24 }}
                          aria-label={`颜色 ${c}`}
                          onClick={() => void run(() => recolorTag(t.id, c))}
                        />
                      ))}
                      <button
                        type="button"
                        className="wr-swatch-btn"
                        data-selected={t.color == null}
                        style={{ width: 24, height: 24, fontSize: 11 }}
                        aria-label="默认色"
                        title="默认色"
                        onClick={() => void run(() => recolorTag(t.id, null))}
                      >
                        默认
                      </button>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span className="wr-muted" style={{ fontSize: 12 }}>合并到</span>
                      <select className="wr-select" style={{ padding: "6px 8px" }} value={mergeTo} aria-label="合并目标" onChange={(e) => setMergeTo(e.currentTarget.value)}>
                        <option value="">选择标签…</option>
                        {tags
                          .filter((o) => o.id !== t.id)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                      </select>
                      <button
                        className="wr-btn"
                        disabled={!mergeTo}
                        onClick={() => {
                          const target = tags.find((o) => String(o.id) === mergeTo);
                          if (!target) return;
                          void run(async () => {
                            const ok = await showConfirm(
                              "合并标签",
                              `把“${t.name}”并入“${target.name}”？两本书上重复的关联会去重，“${t.name}”将被删除。`,
                            );
                            if (ok) await mergeTags(t.id, target.id);
                          });
                        }}
                      >
                        合并
                      </button>
                    </div>
                    <div>
                      <button
                        className="wr-btn wr-btn-danger"
                        onClick={() => {
                          void run(async () => {
                            const ok = await showConfirm(
                              "删除标签",
                              `删除“${t.name}”？仅解除与书的关联，不会删除任何书。`,
                              { danger: true, confirmText: "删除" },
                            );
                            if (ok) await deleteTag(t.id);
                          });
                        }}
                      >
                        删除标签
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <div className="wr-prompt-actions">
          <button className="wr-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
