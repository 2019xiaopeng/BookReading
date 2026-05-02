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
        <div style={{ color: "rgba(0,0,0,0.7)" }}>主题</div>
        <select value={v.theme} onChange={(e) => props.onChange({ ...v, theme: e.currentTarget.value as any })}>
          <option value="light">浅色</option>
          <option value="sepia">护眼</option>
          <option value="dark">夜间</option>
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ color: "rgba(0,0,0,0.7)" }}>字号</div>
          <div style={{ marginLeft: "auto", color: "rgba(0,0,0,0.6)", fontVariantNumeric: "tabular-nums" }}>
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
        <div style={{ color: "rgba(0,0,0,0.7)" }}>翻页动画</div>
        <select
          value={v.pageAnimation}
          onChange={(e) => props.onChange({ ...v, pageAnimation: e.currentTarget.value as any })}
        >
          <option value="none">无</option>
          <option value="fade">淡入淡出</option>
          <option value="slide">滑动</option>
        </select>
      </div>
    </div>
  );
}

