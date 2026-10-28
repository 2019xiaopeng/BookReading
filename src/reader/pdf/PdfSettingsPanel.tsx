import { setTheme, THEME_SWATCHES, useTheme } from "../../ui/theme";
import type { ImageFit } from "../image/layout";
import type { PdfReadMode, PdfReaderSettings } from "./layout";

type Props = {
  value: PdfReaderSettings;
  onChange: (next: PdfReaderSettings) => void;
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

// PDF 精简设置：模式 + 适配（复用漫画面板的 Seg 结构与主题块；单双页/RTL/条漫宽等漫画专属项不适用）
export default function PdfSettingsPanel({ value, onChange }: Props) {
  const paged = value.mode === "paged";
  const theme = useTheme();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 600 }}>PDF 设置</div>

      <Seg
        label="阅读模式"
        value={value.mode}
        options={[
          { value: "paged", text: "翻页" },
          { value: "scroll", text: "连续滚动" },
        ]}
        onPick={(mode: PdfReadMode) => onChange({ ...value, mode })}
      />
      {value.mode === "scroll" ? (
        <div className="wr-muted" style={{ fontSize: 12 }}>
          连续滚动按页宽整页排列，方向键滚动一屏
        </div>
      ) : null}

      <Seg
        label="适配"
        value={value.fit}
        options={[
          { value: "height", text: "适高", disabled: !paged },
          { value: "width", text: "适宽", disabled: !paged },
          { value: "original", text: "原始", disabled: !paged },
        ]}
        onPick={(fit: ImageFit) => onChange({ ...value, fit })}
      />
      {value.mode === "scroll" ? (
        <div className="wr-muted" style={{ fontSize: 12 }}>
          连续滚动模式固定按页宽适配
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="wr-muted">主题</div>
        <div role="group" aria-label="主题" style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
          {THEME_SWATCHES.map((s) => {
            const active = theme === s.value;
            return (
              <button
                key={s.value}
                type="button"
                className="wr-swatch-btn"
                data-selected={active}
                aria-label={s.label}
                aria-pressed={active}
                title={s.label}
                onClick={() => setTheme(s.value)}
                style={{ background: s.color }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
