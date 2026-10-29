import type { Highlight } from "../../tauri/invoke";
import { IconHighlight, IconRefresh } from "../../ui/icons";

/** 标注列表：原文（text）+ 笔记（note）双行，空笔记只显原文；颜色沿用 color 列（小圆点展示）。 */
export default function HighlightsPanel(props: {
  items: Highlight[];
  loaded?: boolean;
  onOpen: (cfiRange: string) => void;
  onDelete: (id: string) => void;
  /** E4 标注导出（ReaderPage 提供 save 对话框 + exportAnnotations 链路） */
  onExport?: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>标注</div>
        {props.onExport ? (
          <button className="wr-btn" style={{ marginLeft: "auto" }} onClick={props.onExport}>
            导出
          </button>
        ) : null}
      </div>

      {props.loaded === false ? (
        <div className="wr-state wr-state-loading">
          <span className="wr-state-icon" aria-hidden="true">
            <IconRefresh />
          </span>
          <div className="wr-state-title">加载中</div>
        </div>
      ) : props.items.length === 0 ? (
        <div className="wr-state">
          <span className="wr-state-icon" aria-hidden="true">
            <IconHighlight />
          </span>
          <div className="wr-state-title">还没有标注</div>
          <div className="wr-state-sub">选中正文一段文字试试</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {props.items.map((h) => {
            const text = h.text?.trim() ?? "";
            const note = h.note?.trim() ?? "";
            return (
              <div key={h.id} className="wr-card" style={{ padding: 10 }}>
                {text ? (
                  <div style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>
                    {h.color ? (
                      <span
                        aria-hidden="true"
                        style={{
                          display: "inline-block",
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: h.color,
                          marginRight: 6,
                          verticalAlign: "middle",
                        }}
                      />
                    ) : null}
                    {text}
                  </div>
                ) : null}
                {note ? (
                  <div className="wr-muted" style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>
                    {note}
                  </div>
                ) : null}
                {!text && !note ? <div style={{ marginBottom: 8 }}>高亮</div> : null}
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="wr-btn" onClick={() => props.onOpen(h.cfi_range)}>
                    打开
                  </button>
                  <button className="wr-btn" onClick={() => props.onDelete(h.id)}>
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
