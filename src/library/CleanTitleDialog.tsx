// N-1 前端入口：设置→存储「重新清洗全部标题」——预览 diff 确认后批量应用。
// D-1.3：每行可还原到上次批量清洗前的快照（original_title 等）。
import { useEffect, useState } from "react";

import {
  cleanTitleApply,
  cleanTitlePreview,
  revertTitle,
  type CleanPreviewItem,
} from "../tauri/invoke";
import { showAlert } from "../ui/dialog";
import { showToast } from "../ui/toast";
import { Modal } from "../ui/radix";

export default function CleanTitleDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<CleanPreviewItem[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [revertingId, setRevertingId] = useState<string | null>(null);

  useEffect(() => {
    cleanTitlePreview()
      .then(setItems)
      .catch((e) => {
        void showAlert("扫描失败", String(e));
        onClose();
      });
  }, [onClose]);

  // 还原单本：无快照（从未批量清洗过）只 toast，不算错误
  const revertOne = (item: CleanPreviewItem) => {
    if (applying || revertingId !== null) return;
    setRevertingId(item.bookId);
    void (async () => {
      try {
        const ok = await revertTitle(item.bookId);
        if (!ok) {
          showToast("无快照，无法还原（此书未经过批量清洗）");
          return;
        }
        showToast("已还原原标题");
        onChanged();
        try {
          setItems(await cleanTitlePreview()); // 标题已变，重扫预览
        } catch {
          onClose();
        }
      } catch (e) {
        await showAlert("还原失败", String(e));
      } finally {
        setRevertingId(null);
      }
    })();
  };

  const apply = () => {
    if (!items || items.length === 0 || applying) return;
    setApplying(true);
    void (async () => {
      try {
        await cleanTitleApply(
          items.map((i) => ({
            bookId: i.bookId,
            title: i.titleNew,
            subtitle: i.subtitle,
            author: i.authorNew,
            sourceTags: i.sourceTags,
          })),
        );
        showToast(`已清洗 ${items.length} 本（重新打开此预览可单本还原）`);
        onChanged();
        onClose();
      } catch (e) {
        await showAlert("应用失败", String(e));
      } finally {
        setApplying(false);
      }
    })();
  };

  return (
    <Modal label="智能清洗标题预览" onClose={onClose} panelClassName="wr-panel wr-prompt wr-dialog wr-clean-dialog">
        <div className="wr-prompt-title">智能清洗标题预览</div>
        <div className="wr-prompt-body">
          {items === null ? (
            <div className="wr-muted">扫描中…</div>
          ) : items.length === 0 ? (
            <div>没有需要清洗的条目（手动改过名字的书自动跳过）。</div>
          ) : (
            <div className="wr-clean-list">
              {items.slice(0, 200).map((i) => (
                <div key={i.bookId} className="wr-clean-row">
                  <div>
                    <div className="wr-clean-old" title={i.titleOld}>{i.titleOld}</div>
                    {/* D-1.3 还原：回到上次批量清洗前快照（无快照点击后 toast 提示） */}
                    <button
                      className="wr-btn"
                      style={{ padding: "2px 10px", fontSize: 12, marginTop: 4 }}
                      disabled={applying || revertingId !== null}
                      aria-label={`还原 ${i.titleNew}`}
                      onClick={() => revertOne(i)}
                    >
                      {revertingId === i.bookId ? "还原中…" : "还原"}
                    </button>
                  </div>
                  <div className="wr-clean-arrow">→</div>
                  <div className="wr-clean-new">
                    <div className="wr-clean-new-title">{i.titleNew}</div>
                    {i.subtitle ? <div className="wr-clean-new-sub">{i.subtitle}</div> : null}
                    {i.authorOld !== i.authorNew && i.authorNew ? (
                      <div className="wr-clean-new-sub">作者：{i.authorNew}</div>
                    ) : null}
                    {i.sourceTags.length > 0 ? (
                      <div className="wr-clean-tags">{i.sourceTags.join(" · ")}</div>
                    ) : null}
                  </div>
                </div>
              ))}
              {items.length > 200 ? (
                <div className="wr-muted">…另有 {items.length - 200} 本未列出（全部一并应用）</div>
              ) : null}
            </div>
          )}
        </div>
        <div className="wr-prompt-actions">
          {/* D-1：应用即快照原文（original_title 等），每行「还原」按钮回到快照 */}
          <span className="wr-muted" style={{ marginRight: "auto", fontSize: 12 }}>
            应用后可单本还原原标题
          </span>
          <button className="wr-btn" disabled={applying} onClick={onClose}>
            取消
          </button>
          <button
            className="wr-btn wr-btn-primary"
            disabled={applying || !items || items.length === 0}
            onClick={apply}
          >
            {applying ? `应用中…` : `应用清洗（${items?.length ?? 0} 本）`}
          </button>
        </div>
    </Modal>
  );
}
