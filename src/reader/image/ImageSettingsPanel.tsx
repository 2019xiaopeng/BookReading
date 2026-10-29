import { setTheme, THEME_SWATCHES, useTheme } from "../../ui/theme";
import type { ImageFit, ImagePageAnimation, ImagePageLayout, ImageReadMode, ImageReaderSettings } from "./layout";

type Props = {
  value: ImageReaderSettings;
  onChange: (next: ImageReaderSettings) => void;
  /** 批次15：PDF 并轨漫画交互——共用本面板与 image_reader_settings；未实现项（单双页/RTL/翻页动画）置灰 */
  pdf?: boolean;
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

export default function ImageSettingsPanel({ value, onChange, pdf = false }: Props) {
  const webtoon = value.mode === "webtoon";
  // 连续滚动（webtoon 枚举）下分页专属项本就置灰；pdf 再叠加 PDF 未实现项
  const off = webtoon || pdf;
  const theme = useTheme();
  const widthLabel = pdf ? "滚动宽度" : "条漫宽度";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 600 }}>{pdf ? "PDF 设置" : "漫画设置"}</div>


      <Seg
        label="阅读模式"
        value={value.mode}
        options={[
          { value: "paged", text: "翻页" },
          { value: "webtoon", text: pdf ? "连续滚动" : "条漫" },
        ]}
        onPick={(mode: ImageReadMode) => onChange({ ...value, mode })}
      />
      {webtoon ? (
        <div className="wr-muted" style={{ fontSize: 12 }}>
          {pdf ? "连续滚动按页宽整页排列，方向键滚动一屏，空格自动滚动" : "条漫模式按页宽连续滚动，方向键滚动一屏"}
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
          { value: "single", text: "单页", disabled: off },
          { value: "double", text: "双页", disabled: off },
        ]}
        onPick={(layout: ImagePageLayout) => onChange({ ...value, layout })}
      />

      {value.layout === "double" && !off ? (
        <Seg
          label="双页偏移"
          value={value.doubleOffset === 1 ? "1" : "0"}
          options={[
            { value: "0", text: "无" },
            { value: "1", text: "封面独占" },
          ]}
          onPick={(v) => onChange({ ...value, doubleOffset: v === "1" ? 1 : 0 })}
        />
      ) : null}

      <Seg
        label="阅读方向"
        value={value.rtl ? "rtl" : "ltr"}
        options={[
          { value: "ltr", text: "从左到右", disabled: off },
          { value: "rtl", text: "从右到左", disabled: off },
        ]}
        onPick={(d) => onChange({ ...value, rtl: d === "rtl" })}
      />

      <Seg
        label="翻页动画"
        value={value.pageAnimation}
        options={[
          { value: "none", text: "无", disabled: off },
          { value: "slide", text: "滑动", disabled: off },
        ]}
        onPick={(pageAnimation: ImagePageAnimation) => onChange({ ...value, pageAnimation })}
      />

      <Seg
        label={widthLabel}
        value={String(value.webtoonWidth)}
        options={[
          { value: "62", text: "A4感", disabled: !webtoon },
          { value: "75", text: "适中", disabled: !webtoon },
          { value: "92", text: "宽", disabled: !webtoon },
        ]}
        onPick={(w) => onChange({ ...value, webtoonWidth: Number(w) })}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="range"
          aria-label={widthLabel}
          aria-valuetext={`${value.webtoonWidth}%`}
          min={40}
          max={100}
          step={1}
          value={value.webtoonWidth}
          disabled={!webtoon}
          onChange={(e) => onChange({ ...value, webtoonWidth: Number(e.currentTarget.value) })}
        />
        <div style={{ color: "var(--wr-muted)", fontVariantNumeric: "tabular-nums" }}>{value.webtoonWidth}%</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="wr-muted">自动滚动速度</div>
          <div style={{ marginLeft: "auto", color: "var(--wr-muted)", fontVariantNumeric: "tabular-nums" }}>
            {value.autoScrollSpeed}px/s
          </div>
        </div>
        <input
          type="range"
          aria-label="自动滚动速度"
          aria-valuetext={`${value.autoScrollSpeed}px/s`}
          min={20}
          max={240}
          step={10}
          value={value.autoScrollSpeed}
          disabled={!webtoon}
          title={webtoon ? undefined : "仅连续滚动模式可用"}
          onChange={(e) => onChange({ ...value, autoScrollSpeed: Number(e.currentTarget.value) })}
        />
      </div>

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
