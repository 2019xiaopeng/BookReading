import type { ReaderSettings } from "./types";
import {
  normalizeLetterSpacing,
  normalizeLineHeight,
  normalizePageMargin,
  normalizeParagraphSpacing,
  normalizeTextIndent,
} from "./normalize";

// ---- #3 排版按书记忆：settings 键 epuset:<bookId> 覆盖全局默认（仿 imgset 机制）----
// 字体族不进书级（保持全局）；键值 JSON，字段可选、按书钉住。

/** 书级排版覆盖键名 */
export function epubSettingsKey(bookId: string): string {
  return `epuset:${bookId}`;
}

export type EpubSettingsOverride = Partial<
  Pick<
    ReaderSettings,
    "fontSizePercent" | "lineHeight" | "fontWeight" | "letterSpacing" | "paragraphSpacing" | "textIndent" | "pageMargin" | "justify"
  >
>;

/** 可被书级钉住的全部署名（面板改动比对用） */
export const EPUSET_FIELDS = [
  "fontSizePercent",
  "lineHeight",
  "fontWeight",
  "letterSpacing",
  "paragraphSpacing",
  "textIndent",
  "pageMargin",
  "justify",
] as const satisfies (keyof EpubSettingsOverride)[];

/** 覆盖键解析：字符串/对象皆可；字段缺失=不覆盖（沿用全局），非法值丢弃（不落到默认值——那是全局的事） */
export function parseEpubSettingsOverride(raw: unknown): EpubSettingsOverride {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (typeof v !== "object" || v === null) return {};
  const o = v as Record<string, unknown>;
  const out: EpubSettingsOverride = {};
  if (typeof o.fontSizePercent === "number" && Number.isFinite(o.fontSizePercent)) {
    out.fontSizePercent = Math.min(200, Math.max(80, Math.round(o.fontSizePercent)));
  }
  if (typeof o.lineHeight === "number" && Number.isFinite(o.lineHeight)) out.lineHeight = normalizeLineHeight(o.lineHeight);
  // 字重是三档枚举：非档位值整键丢弃（仿 imgset doubleOffset 的枚举校验），不落到 400 冒充覆盖
  if (o.fontWeight === 400 || o.fontWeight === 500 || o.fontWeight === 700) out.fontWeight = o.fontWeight;
  if (typeof o.letterSpacing === "number" && Number.isFinite(o.letterSpacing)) out.letterSpacing = normalizeLetterSpacing(o.letterSpacing);
  if (typeof o.paragraphSpacing === "number" && Number.isFinite(o.paragraphSpacing)) out.paragraphSpacing = normalizeParagraphSpacing(o.paragraphSpacing);
  if (typeof o.textIndent === "number" && Number.isFinite(o.textIndent)) out.textIndent = normalizeTextIndent(o.textIndent);
  if (typeof o.pageMargin === "number" && Number.isFinite(o.pageMargin)) out.pageMargin = normalizePageMargin(o.pageMargin);
  if (o.justify === true || o.justify === false) out.justify = o.justify;
  return out;
}

/** 生效排版 = 全局 ReaderSettings ← epuset:<bookId> 书级覆盖（面板显示并改的是生效值） */
export function resolveEpubSettings(global: ReaderSettings, perBook: unknown): ReaderSettings {
  return { ...global, ...parseEpubSettingsOverride(perBook) };
}
