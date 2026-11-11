// #5 TTS 朗读一期：window.speechSynthesis，按段落切 utterance 顺序播（超长单条 utterance 会被
// 引擎截断，每段一条规避）。无跟随高亮——一期明确不做（需 CFI↔段落映射与实时重排，成本高）。
// WebView2 无 speechSynthesis 时调用方用 ttsSupported() 判定隐藏入口。

export type TtsStatus = "idle" | "speaking";

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** 按空行/换行切段（iframe body.innerText 的段落边界即块级元素分行），空白段丢弃 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** voices 里挑中文声音：zh-CN 优先，其次任意 zh；无中文回 null（用系统默认声音） */
export function pickChineseVoice<T extends { lang?: string }>(voices: T[]): T | null {
  const zh = voices.filter((v) => typeof v.lang === "string" && v.lang.toLowerCase().startsWith("zh"));
  if (zh.length === 0) return null;
  return zh.find((v) => /zh[-_]cn/i.test(v.lang as string)) ?? zh[0];
}

let status: TtsStatus = "idle";
let generation = 0;
let rate = 1;
let cachedVoice: SpeechSynthesisVoice | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function setStatus(s: TtsStatus): void {
  if (status === s) return;
  status = s;
  notify();
}

function currentVoice(): SpeechSynthesisVoice | null {
  if (!ttsSupported()) return null;
  cachedVoice ??= pickChineseVoice(window.speechSynthesis.getVoices());
  return cachedVoice;
}

// getVoices 异步补齐：voiceschanged 后刷新缓存（设置面板显示的声音名随之更新）
if (ttsSupported()) {
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    cachedVoice = pickChineseVoice(window.speechSynthesis.getVoices());
    notify();
  });
}

/** 设置面板"当前声音"显示名 */
export function ttsVoiceLabel(): string {
  return currentVoice()?.name || "系统默认";
}

export function ttsSpeaking(): boolean {
  return status === "speaking";
}

export function subscribeTts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 从 text 起朗读（段落队列顺序播）；再次调用前先 stop 旧队列。rate 在起始时生效（朗读中改动下次起效）。 */
export function speak(text: string, opts: { rate?: number; voice?: SpeechSynthesisVoice | null } = {}): void {
  if (!ttsSupported()) return;
  stop();
  const parts = splitParagraphs(text);
  if (parts.length === 0) return;
  const myGen = ++generation;
  rate = opts.rate ?? rate;
  let i = 0;
  const speakNext = () => {
    // cancel() 也会触发当前 utterance 的 onend/onerror：代际号不符即旧队列，直接弃
    if (myGen !== generation) return;
    if (i >= parts.length) {
      setStatus("idle");
      return;
    }
    const u = new SpeechSynthesisUtterance(parts[i++]);
    u.rate = rate;
    const v = opts.voice ?? currentVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.onend = () => speakNext();
    u.onerror = () => {
      if (myGen === generation) setStatus("idle");
    };
    window.speechSynthesis.speak(u);
  };
  setStatus("speaking");
  speakNext();
}

export function stop(): void {
  if (!ttsSupported()) return;
  generation += 1;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // 引擎异常时不阻塞调用方
  }
  setStatus("idle");
}
