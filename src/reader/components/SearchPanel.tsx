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
          style={{ flex: 1 }}
        />
        <button onClick={props.onSearch} disabled={props.loading}>
          搜索
        </button>
      </div>

      {props.loading ? <div style={{ color: "rgba(0,0,0,0.6)" }}>搜索中…</div> : null}

      {props.results.length === 0 && !props.loading ? (
        <div style={{ color: "rgba(0,0,0,0.6)" }}>暂无结果</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {props.results.map((r) => (
            <button
              key={r.cfi}
              onClick={() => props.onOpen(r.cfi)}
              style={{
                textAlign: "left",
                border: "1px solid rgba(0,0,0,0.12)",
                borderRadius: 10,
                padding: 10,
                background: "white",
              }}
            >
              <div style={{ color: "rgba(0,0,0,0.85)" }}>{r.excerpt}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
