import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { deleteReaderFont, saveReaderBackground, saveReaderFont } from "../../tauri/invoke";
import { resetBackgroundCache } from "../../ui/appBackground";
import { resetFontCache } from "../../ui/readerFont";
import { setTheme, THEME_SWATCHES, useTheme } from "../../ui/theme";
import type { FontFamily, ReaderSettings } from "../settings/types";

export default function SettingsPanel(props: {
  value: ReaderSettings;
  /** 全局背景图 URL（模块级单缓存，面板预览复用，不再自建 objectURL） */
  bgUrl: string | null;
  onChange: (next: ReaderSettings) => void;
}) {
  const v = props.value;
  const theme = useTheme();
  const scrolled = v.readingMode === "scrolled";
  const [bgBusy, setBgBusy] = useState(false);
  const [bgError, setBgError] = useState<string | null>(null);
  const [fontBusy, setFontBusy] = useState(false);
  const [fontError, setFontError] = useState<string | null>(null);
  const fontCustom = v.reader_font.type === "custom";

  async function pickBackground() {
    if (bgBusy) return;
    setBgError(null);
    setBgBusy(true);
    try {
      const picked = await open({
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (typeof picked !== "string") return;
      const path = await saveReaderBackground(picked);
      resetBackgroundCache(); // 后端覆写同一路径，旧 blob 必须作废，onChange 触发的重读才会取到新图
      props.onChange({ ...v, reader_bg: { type: "image", path } });
    } catch (e) {
      setBgError(String(e));
    } finally {
      setBgBusy(false);
    }
  }

  // B11 自定义字体：安装→单槽覆盖并选中 custom；恢复默认→删槽位、回 default
  async function pickFont() {
    if (fontBusy) return;
    setFontError(null);
    setFontBusy(true);
    try {
      const picked = await open({
        filters: [{ name: "Fonts", extensions: ["ttf", "otf", "woff2"] }],
      });
      if (typeof picked !== "string") return;
      const path = await saveReaderFont(picked);
      resetFontCache(); // 同扩展名换字体 path 不变，旧 @font-face blob 必须作废
      props.onChange({ ...v, reader_font: { type: "custom", path }, fontFamily: "custom" });
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
      props.onChange({ ...v, reader_font: { type: "preset" }, fontFamily: "default" });
    } catch (e) {
      setFontError(String(e));
    } finally {
      setFontBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 600 }}>阅读设置</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="wr-muted">阅读模式</div>
        <div className="wr-seg" role="group" aria-label="阅读模式">
          <button
            type="button"
            className="wr-seg-btn"
            data-active={v.readingMode === "paginated"}
            aria-pressed={v.readingMode === "paginated"}
            onClick={() => props.onChange({ ...v, readingMode: "paginated" })}
          >
            左右翻页
          </button>
          <button
            type="button"
            className="wr-seg-btn"
            data-active={v.readingMode === "scrolled"}
            aria-pressed={v.readingMode === "scrolled"}
            onClick={() => props.onChange({ ...v, readingMode: "scrolled" })}
          >
            上下滚动
          </button>
        </div>
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

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="wr-muted">字号</div>
          <div style={{ marginLeft: "auto", color: "var(--wr-muted)", fontVariantNumeric: "tabular-nums" }}>
            {v.fontSizePercent}%
          </div>
        </div>
        <input
          type="range"
          aria-label="字号"
          aria-valuetext={`${v.fontSizePercent}%`}
          min={80}
          max={200}
          step={5}
          value={v.fontSizePercent}
          onChange={(e) => props.onChange({ ...v, fontSizePercent: Number(e.currentTarget.value) })}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="wr-muted">行距</div>
          <div style={{ marginLeft: "auto", color: "var(--wr-muted)", fontVariantNumeric: "tabular-nums" }}>
            {v.lineHeight.toFixed(1)}
          </div>
        </div>
        <input
          type="range"
          aria-label="行距"
          min={1.5}
          max={2.2}
          step={0.1}
          value={v.lineHeight}
          onChange={(e) => props.onChange({ ...v, lineHeight: Number(e.currentTarget.value) })}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="wr-muted">正文字体</div>
        <select
          className="wr-select"
          aria-label="正文字体"
          value={v.fontFamily === "custom" && !fontCustom ? "default" : v.fontFamily}
          onChange={(e) => {
            const next = e.currentTarget.value;
            if (
              next === "default" ||
              next === "songti" ||
              next === "heiti" ||
              next === "kaiti" ||
              next === "fangsong" ||
              (next === "custom" && fontCustom)
            ) {
              props.onChange({ ...v, fontFamily: next as FontFamily });
            }
          }}
        >
          <option value="default">悦读（回退宋体）</option>
          <option value="songti">宋体</option>
          <option value="heiti">黑体</option>
          <option value="kaiti">楷体</option>
          <option value="fangsong">仿宋</option>
          {fontCustom ? <option value="custom">自定义字体</option> : null}
        </select>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" className="wr-btn" onClick={() => void pickFont()} disabled={fontBusy}>
            从文件安装字体…
          </button>
          {fontCustom ? (
            <button type="button" className="wr-btn" onClick={() => void restoreFont()} disabled={fontBusy}>
              恢复默认
            </button>
          ) : null}
        </div>
        {fontError ? (
          <div role="alert" className="wr-muted" style={{ fontSize: 12 }}>
            {fontError}
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="wr-muted">翻页动画</div>
        <select
          className="wr-select"
          aria-label="翻页动画"
          value={v.pageAnimation}
          disabled={scrolled}
          aria-disabled={scrolled}
          title={scrolled ? "滚动模式下不可用" : undefined}
          style={{ opacity: scrolled ? 0.55 : 1, transition: "opacity 180ms ease" }}
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
          aria-label="版式"
          value={v.layoutMode}
          disabled={scrolled}
          aria-disabled={scrolled}
          title={scrolled ? "滚动模式下不可用" : undefined}
          style={{ opacity: scrolled ? 0.55 : 1, transition: "opacity 180ms ease" }}
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

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="wr-muted">全局背景</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" className="wr-btn" onClick={() => void pickBackground()} disabled={bgBusy}>
            选择图片
          </button>
          {v.reader_bg.type === "image" ? (
            <button
              type="button"
              className="wr-btn"
              onClick={() => props.onChange({ ...v, reader_bg: { type: "preset" } })}
            >
              恢复默认
            </button>
          ) : null}
          {props.bgUrl ? (
            <div
              aria-hidden="true"
              style={{
                width: 104,
                height: 32,
                borderRadius: 8,
                border: "1px solid var(--wr-hairline)",
                backgroundImage: `url("${props.bgUrl}")`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }}
            />
          ) : null}
        </div>
        {bgError ? (
          <div role="alert" className="wr-muted" style={{ fontSize: 12 }}>
            {bgError}
          </div>
        ) : null}
      </div>
    </div>
  );
}
