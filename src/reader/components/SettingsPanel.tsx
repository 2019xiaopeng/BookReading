import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { saveReaderBackground } from "../../tauri/invoke";
import { extToMime, readAppDataBlobUrl, revokeObjectUrl } from "../../tauri/appDataPaths";
import type { ReaderSettings, Theme } from "../settings/types";

const THEME_SWATCHES: { value: Theme; label: string; color: string }[] = [
  { value: "light", label: "白色", color: "#ffffff" },
  { value: "sepia", label: "米黄", color: "#fffaf0" },
  { value: "green", label: "护眼", color: "#c8e6c4" },
  { value: "gray", label: "纸灰", color: "#d9d9d6" },
  // dark 的纸面 token 是半透明白，色块用壳底色代表夜间阅读面
  { value: "dark", label: "夜间", color: "#0f1214" },
  { value: "darkcontrast", label: "夜间高对比", color: "#050505" },
];

export default function SettingsPanel(props: {
  value: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
}) {
  const v = props.value;
  const scrolled = v.readingMode === "scrolled";
  const [bgPreview, setBgPreview] = useState<string | null>(null);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgError, setBgError] = useState<string | null>(null);
  const bgPreviewRef = useRef<string | null>(null);

  function swapBgPreview(url: string | null) {
    if (bgPreviewRef.current && bgPreviewRef.current !== url) revokeObjectUrl(bgPreviewRef.current);
    bgPreviewRef.current = url;
    setBgPreview(url);
  }

  useEffect(() => {
    return () => revokeObjectUrl(bgPreviewRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (v.reader_bg.type !== "image") {
      swapBgPreview(null);
      return;
    }
    const ext = v.reader_bg.path.split(".").pop() ?? "";
    readAppDataBlobUrl(v.reader_bg.path, extToMime(ext))
      .then((url) => {
        if (!cancelled) swapBgPreview(url);
        else revokeObjectUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [v.reader_bg]);

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
      props.onChange({ ...v, reader_bg: { type: "image", path } });
    } catch (e) {
      setBgError(String(e));
    } finally {
      setBgBusy(false);
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
            const active = v.theme === s.value;
            return (
              <button
                key={s.value}
                type="button"
                className="wr-btn"
                aria-label={s.label}
                aria-pressed={active}
                title={s.label}
                onClick={() => props.onChange({ ...v, theme: s.value })}
                style={{
                  height: 30,
                  padding: 0,
                  borderRadius: 10,
                  background: s.color,
                  borderColor: active ? "rgba(var(--wr-accent-rgb), 0.65)" : "var(--wr-hairline)",
                  boxShadow: active ? "0 0 0 3px rgba(var(--wr-accent-rgb), 0.2)" : "none",
                  transition: "box-shadow 180ms ease, border-color 180ms ease",
                }}
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
        <div className="wr-muted">背景图</div>
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
          {bgPreview ? (
            <div
              aria-hidden="true"
              style={{
                width: 104,
                height: 32,
                borderRadius: 8,
                border: "1px solid var(--wr-hairline)",
                backgroundImage: `url("${bgPreview}")`,
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
