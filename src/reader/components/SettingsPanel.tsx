import type { ReaderSettings } from "../settings/types";

export default function SettingsPanel(props: {
  value: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
}) {
  const v = props.value;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 600 }}>阅读设置</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="wr-muted">主题</div>
        <select
          className="wr-select"
          value={v.theme}
          onChange={(e) => {
            const next = e.currentTarget.value;
            if (next === "light" || next === "sepia" || next === "dark") props.onChange({ ...v, theme: next });
          }}
        >
          <option value="light">浅色</option>
          <option value="sepia">护眼</option>
          <option value="dark">夜间</option>
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="wr-muted">字号</div>
          <div style={{ marginLeft: "auto", color: "var(--wr-muted)", fontVariantNumeric: "tabular-nums" }}>
            {v.fontSizePercent}%
          </div>
        </div>
        <input
          type="range"
          min={80}
          max={200}
          step={5}
          value={v.fontSizePercent}
          onChange={(e) => props.onChange({ ...v, fontSizePercent: Number(e.currentTarget.value) })}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="wr-muted">翻页动画</div>
        <select
          className="wr-select"
          value={v.pageAnimation}
          onChange={(e) => {
            const next = e.currentTarget.value;
            if (next === "none" || next === "fade" || next === "slide") props.onChange({ ...v, pageAnimation: next });
          }}
        >
          <option value="none">无</option>
          <option value="fade">淡入淡出</option>
          <option value="slide">滑动</option>
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="wr-muted">版式</div>
        <select
          className="wr-select"
          value={v.layoutMode}
          onChange={(e) => {
            const next = e.currentTarget.value;
            if (next === "auto" || next === "single" || next === "double") props.onChange({ ...v, layoutMode: next });
          }}
        >
          <option value="auto">自动</option>
          <option value="single">单栏</option>
          <option value="double">双栏</option>
        </select>
      </div>
    </div>
  );
}
