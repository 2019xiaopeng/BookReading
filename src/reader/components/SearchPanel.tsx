import type { RefObject } from "react";

import { IconRefresh, IconSearch } from "../../ui/icons";

export default function SearchPanel(props: {
  query: string;
  onQueryChange: (q: string) => void;
  onSearch: () => void;
  loading: boolean;
  searched?: boolean;
  results: { cfi: string; excerpt: string; chapter: string; percent?: number }[];
  onOpen: (cfi: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 600 }}>搜索</div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          ref={props.inputRef}
          aria-label="搜索关键词"
          value={props.query}
          onChange={(e) => props.onQueryChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onSearch();
          }}
          placeholder="输入关键词"
          className="wr-input"
          style={{ flex: 1 }}
        />
        <button className="wr-btn wr-btn-primary" onClick={props.onSearch} disabled={props.loading}>
          搜索
        </button>
      </div>

      {props.loading ? (
        <div className="wr-state wr-state-loading" role="status">
          <span className="wr-state-icon" aria-hidden="true">
            <IconRefresh />
          </span>
          <div className="wr-state-title">搜索中</div>
        </div>
      ) : null}

      {props.results.length === 0 && !props.loading ? (
        <div className="wr-state" role="status">
          <span className="wr-state-icon" aria-hidden="true">
            <IconSearch />
          </span>
          <div className="wr-state-title">{props.searched ? "没有找到匹配内容" : "输入关键词"}</div>
          <div className="wr-state-sub">{props.searched ? "换个关键词试试" : "回车或点搜索开始"}</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {props.results.map((r) => (
            <button key={r.cfi} onClick={() => props.onOpen(r.cfi)} className="wr-toc-item">
              <div
                className="wr-muted"
                style={{ fontSize: 12, display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 2 }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.chapter}</span>
                {typeof r.percent === "number" ? (
                  <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{Math.round(r.percent * 100)}%</span>
                ) : null}
              </div>
              <div style={{ color: "var(--wr-ink)" }}>{r.excerpt}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
