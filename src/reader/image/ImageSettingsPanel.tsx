import type { Theme } from "../settings/types";
import type { ImageFit, ImagePageLayout, ImageReadMode, ImageReaderSettings } from "./layout";

type Props = {
    /** dropped in batch4 B1: comic reader follows the global six-theme tokens; A5 removes the call-site props */
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
  value: ImageReaderSettings;
  onChange: (next: ImageReaderSettings) => void;
};

type SegOption<T extends string> = { value: T; text: string; disabled?: boolean };

function Seg<T extends string>(props: { label: string; value: T; options: SegOption<T>[]; onPick: (v: T) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="wr-muted">{props.label}</div>
      <div className="wr-seg" role="group" aria-label={props.label}>
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="wr-seg-btn"
            data-active={props.value === o.value}
            aria-pressed={props.value === o.value}
            disabled={o.disabled}
            onClick={() => props.onPick(o.value)}
          >
            {o.text}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ImageSettingsPanel({ value, onChange }: Props) {
  const webtoon = value.mode === "webtoon";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 600 }}>漫画设置</div>


      <Seg
        label="阅读模式"
        value={value.mode}
        options={[
          { value: "paged", text: "翻页" },
          { value: "webtoon", text: "条漫" },
        ]}
        onPick={(mode: ImageReadMode) => onChange({ ...value, mode })}
      />
      {webtoon ? (
        <div className="wr-muted" style={{ fontSize: 12 }}>
          条漫模式按页宽连续滚动，方向键滚动一屏
        </div>
      ) : null}

      <Seg
        label="适配"
        value={value.fit}
        options={[
          { value: "height", text: "适高", disabled: webtoon },
          { value: "width", text: "适宽", disabled: webtoon },
          { value: "original", text: "原始", disabled: webtoon },
        ]}
        onPick={(fit: ImageFit) => onChange({ ...value, fit })}
      />

      <Seg
        label="单双页"
        value={value.layout}
        options={[
          { value: "single", text: "单页", disabled: webtoon },
          { value: "double", text: "双页", disabled: webtoon },
        ]}
        onPick={(layout: ImagePageLayout) => onChange({ ...value, layout })}
      />

      <Seg
        label="阅读方向"
        value={value.rtl ? "rtl" : "ltr"}
        options={[
          { value: "ltr", text: "从左到右", disabled: webtoon },
          { value: "rtl", text: "从右到左", disabled: webtoon },
        ]}
        onPick={(d) => onChange({ ...value, rtl: d === "rtl" })}
      />
    </div>
  );
}
