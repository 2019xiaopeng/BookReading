// N-1 前端入口：设置→存储「重新清洗全部标题」——预览 diff 确认后批量应用。
import { useEffect, useState } from "react";

import {
  cleanTitleApply,
  cleanTitlePreview,
  type CleanPreviewItem,
} from "../tauri/invoke";
import { showAlert } from "../ui/dialog";
import { showToast } from "../ui/toast";

export default function CleanTitleDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<CleanPreviewItem[] | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    cleanTitlePreview()
      .then(setItems)
      .catch((e) => {
        void showAlert("扫描失败", String(e));
        onClose();
      });
  }, [onClose]);

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
        showToast(`已清洗 ${items.length} 本`);
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
    <div className="wr-prompt-overlay">
      <div className="wr-panel wr-prompt wr-dialog wr-clean-dialog">
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
                  <div className="wr-clean-old" title={i.titleOld}>{i.titleOld}</div>
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
          {/* D-1：应用即快照原文（original_title 等），单本书随时可还原——还原入口批次3 接 UI */}
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
      </div>
    </div>
  );
}
