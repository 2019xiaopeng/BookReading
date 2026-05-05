import type { RefObject } from "react";

export default function SearchPanel(props: {
  query: string;
  onQueryChange: (q: string) => void;
  onSearch: () => void;
  loading: boolean;
  results: { cfi: string; excerpt: string }[];
  onOpen: (cfi: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 600 }}>搜索</div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          ref={props.inputRef}
          value={props.query}
          onChange={(e) => props.onQueryChange(e.currentTarget.value)}
          placeholder="输入关键词"
          className="wr-input"
          style={{ flex: 1 }}
        />
        <button className="wr-btn wr-btn-primary" onClick={props.onSearch} disabled={props.loading}>
          搜索
        </button>
      </div>

      {props.loading ? <div className="wr-muted">搜索中…</div> : null}

      {props.results.length === 0 && !props.loading ? (
        <div className="wr-muted">暂无结果</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {props.results.map((r) => (
            <button
              key={r.cfi}
              onClick={() => props.onOpen(r.cfi)}
              className="wr-card"
              style={{ textAlign: "left", cursor: "pointer" }}
            >
              <div style={{ color: "var(--wr-ink)" }}>{r.excerpt}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
