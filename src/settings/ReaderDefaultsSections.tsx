// V-3 设置大页面：「阅读」（EPUB 全局默认）与「漫画增强」（漫画 / PDF 全局默认）两个分区。
// 这里改的是全局默认键；阅读页里按书记住的覆盖（epuset:<bookId> / imgset:<bookId>）不动、仍优先。
import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { deleteReaderFont, saveReaderFont } from "../tauri/invoke";
import { resetFontCache } from "../ui/readerFont";
import { resetIframeFontCache } from "../reader/epub/iframeFont";
import { WrSelect } from "../ui/radix";
import { normalizePageAnimation, normalizeTtsRate } from "../reader/settings/normalize";
import type { FontFamily, ReaderSettings } from "../reader/settings/types";
import type { ImageFit, ImagePageAnimation, ImagePageLayout, ImageReaderSettings } from "../reader/image/layout";
import { readerSettingsFromMap, readerSettingsToMap, visualSettingsFromMap } from "./readerDefaults";
import { effectivePageAnimation, visiblePageAnimations } from "../reader/epub/turnFx";
import { SectionHeader, Seg, type SettingsCtx, SettingsGroup, SettingsRow, Slider } from "./controls";

const LAYOUT_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "single", label: "单栏" },
  { value: "double", label: "双栏" },
];
// 与阅读页设置抽屉同一组字体族名（wr-custom 仅在装了自定义字体后出现）
const FONT_OPTIONS: { value: FontFamily; label: string }[] = [
  { value: "default", label: "悦读（回退宋体）" },
  { value: "songti", label: "宋体" },
  { value: "heiti", label: "黑体" },
  { value: "kaiti", label: "楷体" },
  { value: "fangsong", label: "仿宋" },
];
const SCROLLED_HINT = "上下滚动模式下不可用";

export function ReadingSection({ ctx }: { ctx: SettingsCtx }) {
  const reader = useMemo(() => readerSettingsFromMap(ctx.map), [ctx.map]);
  const ttsRate = normalizeTtsRate(ctx.map.ttsRate);
  const scrolled = reader.readingMode === "scrolled";
  const fontCustom = reader.reader_font.type === "custom";
  const [fontBusy, setFontBusy] = useState(false);
  const [fontError, setFontError] = useState<string | null>(null);

  const update = (patch: Partial<ReaderSettings>) => void ctx.putMany(readerSettingsToMap({ ...reader, ...patch }));

  // B11 自定义正文字体：安装→单槽覆盖并选中 custom；恢复默认→删槽位、回 default（两个 blob 缓存都要作废）
  async function pickFont() {
    if (fontBusy) return;
    setFontError(null);
    setFontBusy(true);
    try {
      const picked = await open({ filters: [{ name: "Fonts", extensions: ["ttf", "otf", "woff2"] }] });
      if (typeof picked !== "string") return;
      const path = await saveReaderFont(picked);
      resetFontCache();
      resetIframeFontCache();
      update({ reader_font: { type: "custom", path }, fontFamily: "custom" });
    } catch (e) {
      setFontError(String(e));
    } finally {
      setFontBusy(false);
    }
  }

  async function restoreFont() {
    if (fontBusy) return;
    setFontError(null);
    setFontBusy(true);
    try {
      await deleteReaderFont();
      resetFontCache();
      resetIframeFontCache();
      update({ reader_font: { type: "preset" }, fontFamily: "default" });
    } catch (e) {
      setFontError(String(e));
    } finally {
      setFontBusy(false);
    }
  }

  const fontOptions = fontCustom ? [...FONT_OPTIONS, { value: "custom", label: "自定义字体" }] : FONT_OPTIONS;
  // 槽位已删但默认值仍是 custom（存量数据）：显示回落到悦读，不误导
  const fontValue = reader.fontFamily === "custom" && !fontCustom ? "default" : reader.fontFamily;

  return (
    <>
      <SectionHeader id="reading" note="在阅读页的设置抽屉里调过的排版会按书记住，优先于这里的默认值。" />

      <SettingsGroup title="翻页">
        <SettingsRow label="阅读模式">
          <Seg
            label="阅读模式"
            value={reader.readingMode}
            options={[
              { value: "paginated", text: "左右翻页" },
              { value: "scrolled", text: "上下滚动" },
            ]}
            onPick={(readingMode) => update({ readingMode })}
          />
        </SettingsRow>
        <SettingsRow label="翻页动画" hint={scrolled ? SCROLLED_HINT : undefined}>
          <WrSelect
            ariaLabel="翻页动画"
            value={effectivePageAnimation(reader.pageAnimation)}
            disabled={scrolled}
            options={visiblePageAnimations()}
            onChange={(v) => update({ pageAnimation: normalizePageAnimation(v) })}
          />
        </SettingsRow>
        <SettingsRow label="翻页速度" hint={scrolled ? SCROLLED_HINT : undefined}>
          <Slider
            label="翻页速度"
            value={reader.turnSpeedMs}
            min={150}
            max={600}
            step={10}
            format={(n) => `${n}ms`}
            disabled={scrolled}
            onCommit={(turnSpeedMs) => update({ turnSpeedMs })}
          />
        </SettingsRow>
        <SettingsRow label="版式" hint={scrolled ? SCROLLED_HINT : undefined}>
          <WrSelect
            ariaLabel="版式"
            value={reader.layoutMode}
            disabled={scrolled}
            options={LAYOUT_OPTIONS}
            onChange={(v) => {
              if (v === "auto" || v === "single" || v === "double") update({ layoutMode: v });
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="字体与排版">
        <SettingsRow label="字号">
          <Slider
            label="字号"
            value={reader.fontSizePercent}
            min={80}
            max={200}
            step={5}
            format={(n) => `${n}%`}
            onCommit={(fontSizePercent) => update({ fontSizePercent })}
          />
        </SettingsRow>
        <SettingsRow label="正文字体" hint={fontError ?? undefined}>
          <WrSelect
            ariaLabel="正文字体"
            value={fontValue}
            options={fontOptions}
            onChange={(v) => {
              if (v === "default" || v === "songti" || v === "heiti" || v === "kaiti" || v === "fangsong" || (v === "custom" && fontCustom)) {
                update({ fontFamily: v });
              }
            }}
          />
          <button type="button" className="wr-btn" onClick={() => void pickFont()} disabled={fontBusy}>
            从文件安装字体…
          </button>
          {fontCustom ? (
            <button type="button" className="wr-btn" onClick={() => void restoreFont()} disabled={fontBusy}>
              恢复默认
            </button>
          ) : null}
        </SettingsRow>
        <SettingsRow label="字重">
          <Seg
            label="字重"
            value={reader.fontWeight === 500 ? "500" : reader.fontWeight === 700 ? "700" : "400"}
            options={[
              { value: "400", text: "标准" },
              { value: "500", text: "中等" },
              { value: "700", text: "粗体" },
            ]}
            onPick={(w) => update({ fontWeight: Number(w) })}
          />
        </SettingsRow>
        <SettingsRow label="行距">
          <Slider
            label="行距"
            value={reader.lineHeight}
            min={1.5}
            max={2.2}
            step={0.1}
            format={(n) => n.toFixed(1)}
            onCommit={(lineHeight) => update({ lineHeight })}
          />
        </SettingsRow>
        <SettingsRow label="字间距">
          <Slider
            label="字间距"
            value={reader.letterSpacing}
            min={0}
            max={2}
            step={0.1}
            format={(n) => `${n.toFixed(1)}px`}
            onCommit={(letterSpacing) => update({ letterSpacing })}
          />
        </SettingsRow>
        <SettingsRow label="段距" hint="段落之间额外留出的间距">
          <Slider
            label="段距"
            value={reader.paragraphSpacing}
            min={0}
            max={1}
            step={0.05}
            format={(n) => `${n.toFixed(2)}em`}
            onCommit={(paragraphSpacing) => update({ paragraphSpacing })}
          />
        </SettingsRow>
        <SettingsRow label="首行缩进">
          <Slider
            label="首行缩进"
            value={reader.textIndent}
            min={0}
            max={2}
            step={0.1}
            format={(n) => `${n.toFixed(1)}em`}
            onCommit={(textIndent) => update({ textIndent })}
          />
        </SettingsRow>
        <SettingsRow label="页边距" hint="纸面四边留白">
          <Slider
            label="页边距"
            value={reader.pageMargin}
            min={12}
            max={48}
            step={2}
            format={(n) => `${n}px`}
            onCommit={(pageMargin) => update({ pageMargin })}
          />
        </SettingsRow>
        <SettingsRow label="两端对齐">
          <Seg
            label="两端对齐"
            value={reader.justify ? "justify" : "default"}
            options={[
              { value: "default", text: "默认" },
              { value: "justify", text: "两端对齐" },
            ]}
            onPick={(v) => update({ justify: v === "justify" })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="朗读">
        <SettingsRow label="语速">
          <Slider
            label="语速"
            value={ttsRate}
            min={0.5}
            max={2}
            step={0.1}
            format={(n) => `${n.toFixed(1)}x`}
            onCommit={(v) => void ctx.put("ttsRate", String(v))}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

/** 漫画 / PDF 共用一份设置形状（ImageReaderSettings），各存各的全局键 */
function VisualDefaults(props: { ctx: SettingsCtx; storageKey: "image_reader_settings" | "pdf_reader_settings" }) {
  const { ctx, storageKey } = props;
  const pdf = storageKey === "pdf_reader_settings";
  const value = useMemo(() => visualSettingsFromMap(ctx.map, storageKey), [ctx.map, storageKey]);
  const update = (patch: Partial<ImageReaderSettings>) => void ctx.put(storageKey, JSON.stringify({ ...value, ...patch }));

  // 与阅读页漫画设置面板同一套置灰口径：条漫/连续滚动下分页专属项不可用；PDF 另有无实现的项
  const webtoon = value.mode === "webtoon";
  const off = webtoon || pdf;
  const pagedHint = webtoon ? (pdf ? "连续滚动模式下不可用" : "条漫模式下不可用") : undefined;
  const widthLabel = pdf ? "滚动宽度" : "条漫宽度";
  // "fold" 引擎支持但面板不提供选项：存量值如实显示为一项，用户可切走
  const animOptions =
    value.pageAnimation === "fold"
      ? [{ value: "none", label: "无" }, { value: "slide", label: "滑动" }, { value: "fold", label: "折页" }]
      : [{ value: "none", label: "无" }, { value: "slide", label: "滑动" }];

  return (
    <SettingsGroup title={pdf ? "PDF" : "漫画"}>
      <SettingsRow label="阅读模式">
        <Seg
          label={pdf ? "PDF 阅读模式" : "漫画阅读模式"}
          value={value.mode}
          options={[
            { value: "paged", text: "翻页" },
            { value: "webtoon", text: pdf ? "连续滚动" : "条漫" },
          ]}
          onPick={(mode) => update({ mode })}
        />
      </SettingsRow>
      <SettingsRow label="适配" hint={pdf ? undefined : "图片相对窗口的缩放方式"}>
        <Seg
          label={pdf ? "PDF 适配" : "漫画适配"}
          value={value.fit}
          options={[
            { value: "height", text: "适高", disabled: webtoon },
            { value: "width", text: "适宽", disabled: webtoon },
            { value: "original", text: "原始", disabled: webtoon },
          ]}
          onPick={(fit) => update({ fit: fit as ImageFit })}
        />
      </SettingsRow>
      <SettingsRow label="单双页" hint={pagedHint}>
        <Seg
          label={pdf ? "PDF 单双页" : "漫画单双页"}
          value={value.layout}
          options={[
            { value: "single", text: "单页", disabled: off },
            { value: "double", text: "双页", disabled: off },
          ]}
          onPick={(layout) => update({ layout: layout as ImagePageLayout })}
        />
      </SettingsRow>
      {value.layout === "double" && !off ? (
        <SettingsRow label="双页偏移" hint="第 1 页（封面）单独占一屏，从第 2 页起两两配对">
          <Seg
            label={pdf ? "PDF 双页偏移" : "漫画双页偏移"}
            value={value.doubleOffset === 1 ? "1" : "0"}
            options={[
              { value: "0", text: "无" },
              { value: "1", text: "封面独占" },
            ]}
            onPick={(v) => update({ doubleOffset: v === "1" ? 1 : 0 })}
          />
        </SettingsRow>
      ) : null}
      <SettingsRow label="阅读方向" hint={pdf ? undefined : "日漫通常从右到左"}>
        <Seg
          label={pdf ? "PDF 阅读方向" : "漫画阅读方向"}
          value={value.rtl ? "rtl" : "ltr"}
          options={[
            { value: "ltr", text: "从左到右", disabled: off },
            { value: "rtl", text: "从右到左", disabled: off },
          ]}
          onPick={(d) => update({ rtl: d === "rtl" })}
        />
      </SettingsRow>
      <SettingsRow label="翻页动画" hint={pagedHint}>
        <WrSelect
          ariaLabel={pdf ? "PDF 翻页动画" : "漫画翻页动画"}
          value={value.pageAnimation}
          disabled={webtoon}
          options={animOptions}
          onChange={(v) => update({ pageAnimation: v as ImagePageAnimation })}
        />
      </SettingsRow>
      <SettingsRow label={widthLabel} hint={pdf ? "连续滚动时每页内容占窗口的宽度" : "条漫内容占窗口的宽度"}>
        <Slider
          label={widthLabel}
          value={value.webtoonWidth}
          min={40}
          max={100}
          step={1}
          format={(n) => `${n}%`}
          disabled={!webtoon}
          onCommit={(webtoonWidth) => update({ webtoonWidth })}
        />
      </SettingsRow>
      <SettingsRow label="自动滚动速度" hint={pdf ? "连续滚动时按空格开始或暂停" : "条漫模式下按空格开始或暂停"}>
        <Slider
          label={pdf ? "PDF 自动滚动速度" : "漫画自动滚动速度"}
          value={value.autoScrollSpeed}
          min={20}
          max={240}
          step={10}
          format={(n) => `${n}px/s`}
          disabled={!webtoon}
          onCommit={(autoScrollSpeed) => update({ autoScrollSpeed })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

export function MangaSection({ ctx }: { ctx: SettingsCtx }) {
  return (
    <>
      <SectionHeader
        id="manga"
        note="在阅读页的设置抽屉里调过的方向、单双页等会按书记住，优先于这里的默认值。"
      />
      <VisualDefaults ctx={ctx} storageKey="image_reader_settings" />
      <VisualDefaults ctx={ctx} storageKey="pdf_reader_settings" />
    </>
  );
}
