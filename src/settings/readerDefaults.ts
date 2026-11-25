import { defaultSettings } from "../reader/settings/defaults";
import { normalizeLayoutMode } from "../reader/settings/layoutMode";
import {
  normalizeFontFamily,
  normalizeFontWeight,
  normalizeLetterSpacing,
  normalizeLineHeight,
  normalizePageAnimation,
  normalizePageMargin,
  normalizeParagraphSpacing,
  normalizeReaderBackground,
  normalizeReaderFont,
  normalizeReadingMode,
  normalizeTextIndent,
  normalizeTurnSpeedMs,
} from "../reader/settings/normalize";
import type { ReaderSettings } from "../reader/settings/types";
import { normalizeImageReaderSettings, type ImageReaderSettings } from "../reader/image/layout";

/**
 * 全局阅读默认 ↔ settings 表键（设置大页面「阅读」分区用）。
 *
 * ⚠ 与 ReaderPage.tsx 的开书回填 / persistSettings 是同一批键、同一口径，但各写一份：
 *   为了让设置页的改动零触碰阅读器代码。改这里的键名或钳位时，必须去 ReaderPage.tsx 对照同步。
 */

/** settings 表 → 全局默认（缺键/坏值回默认档，钳位走 reader 侧 normalizer） */
export function readerSettingsFromMap(map: Record<string, string>): ReaderSettings {
  const fontSizePercent = Number(map.fontSizePercent ?? defaultSettings.fontSizePercent);
  return {
    fontSizePercent: Number.isFinite(fontSizePercent)
      ? Math.min(200, Math.max(80, fontSizePercent))
      : defaultSettings.fontSizePercent,
    pageAnimation: normalizePageAnimation(map.pageAnimation),
    turnSpeedMs: normalizeTurnSpeedMs(map.turnSpeedMs),
    layoutMode: normalizeLayoutMode(map.layoutMode),
    lineHeight: normalizeLineHeight(map.lineHeight),
    fontFamily: normalizeFontFamily(map.fontFamily),
    fontWeight: normalizeFontWeight(map.fontWeight),
    letterSpacing: normalizeLetterSpacing(map.letterSpacing),
    paragraphSpacing: normalizeParagraphSpacing(map.paragraphSpacing),
    textIndent: normalizeTextIndent(map.textIndent),
    pageMargin: normalizePageMargin(map.pageMargin),
    justify: map.justify === "true",
    readingMode: normalizeReadingMode(map.readingMode),
    reader_bg: normalizeReaderBackground(map.reader_bg),
    reader_font: normalizeReaderFont(map.reader_font),
  };
}

/** 全局默认 → settings 表键值（整批写；与 ReaderPage.persistSettings 同一组键） */
export function readerSettingsToMap(next: ReaderSettings): Record<string, string> {
  return {
    fontSizePercent: String(next.fontSizePercent),
    pageAnimation: next.pageAnimation,
    turnSpeedMs: String(next.turnSpeedMs),
    layoutMode: next.layoutMode,
    lineHeight: String(next.lineHeight),
    fontFamily: next.fontFamily,
    fontWeight: String(next.fontWeight),
    letterSpacing: String(next.letterSpacing),
    paragraphSpacing: String(next.paragraphSpacing),
    textIndent: String(next.textIndent),
    pageMargin: String(next.pageMargin),
    justify: String(next.justify),
    readingMode: next.readingMode,
    reader_bg: JSON.stringify(next.reader_bg),
    reader_font: JSON.stringify(next.reader_font),
  };
}

/**
 * 漫画 / PDF 全局默认。PDF 键缺失时继承漫画键（批次16 旧数据迁移，与 ReaderPage 开书回填同口径）。
 * key='pdf_reader_settings' 时读合并值，写回仍落 PDF 自己的键。
 */
export function visualSettingsFromMap(
  map: Record<string, string>,
  key: "image_reader_settings" | "pdf_reader_settings",
): ImageReaderSettings {
  const raw = key === "pdf_reader_settings" ? (map.pdf_reader_settings ?? map.image_reader_settings) : map.image_reader_settings;
  return normalizeImageReaderSettings(raw);
}
