// V-1 翻页动画（对标 Wenku8_Flutter：平移 / 覆盖 / 渐隐 / 纸页翻动）。
// 机制 = View Transitions 快照双叶：翻页瞬间浏览器对「叶片」（正文 + 页码徽标）拍新旧两张合成器级快照，
// 效果 = 对两张快照（及叶片内的遮罩条）施加的 WAAPI 关键帧；进度线性（对标其点击翻页 curve: Curves.linear），
// 阴影 / 折页的强弱走包络 e=sin(πt)（中段最大、两端归零）。原理与实测边界见 docs/开发计划-v3.2.md V-1「方案改定」。
import type { PageAnimation } from "../settings/types";

/**
 * 翻页动画矩阵总开关（v3.1.9 曾关闭；v3.2 改为快照双叶并逐帧验收后打开）。关闭时走 v3.1.8 路径、
 * 选项恢复「无 / 淡入淡出 / 滑动」——线上出问题时的退路。
 */
export const TURN_FX_ENABLED = true;

const MATRIX_OPTIONS: { value: PageAnimation; label: string }[] = [
  { value: "none", label: "无" },
  { value: "slide", label: "平移" },
  { value: "cover", label: "覆盖" },
  { value: "fade", label: "渐隐" },
  { value: "paper", label: "纸页翻动" },
];

/** v3.1.8 的选项与文案（矩阵关闭时原样恢复） */
const LEGACY_OPTIONS: { value: PageAnimation; label: string }[] = [
  { value: "none", label: "无" },
  { value: "fade", label: "淡入淡出" },
  { value: "slide", label: "滑动" },
];

/** 当前开关下设置面板应显示的翻页动画选项（阅读页抽屉与设置浮窗共用同一份） */
export function visiblePageAnimations(): { value: PageAnimation; label: string }[] {
  return TURN_FX_ENABLED ? MATRIX_OPTIONS : LEGACY_OPTIONS;
}

/** 存储值在当前开关下的生效值：矩阵关闭时 cover / paper 按 fade 处理，保证下拉显示与实际翻页一致 */
export function effectivePageAnimation(stored: PageAnimation): PageAnimation {
  if (TURN_FX_ENABLED) return stored;
  return stored === "cover" || stored === "paper" ? "fade" : stored;
}

export type TurnEffect = "slide" | "cover" | "fade" | "paper";

/** 各效果基准时长（ms，× turnSpeedMs/260 缩放；fade 短促、纸页略慢） */
export const TURN_EFFECT_MS: Record<TurnEffect, number> = { slide: 260, cover: 260, fade: 180, paper: 320 };

// ═══ 画法（纯函数）═══

export type TurnBand = { name: string; css: string; frames: Keyframe[] };
export type TurnKeys = { old: Keyframe[]; new: Keyframe[]; bands: TurnBand[] };

/** 叶片内的遮罩条（叶子节点的 view-transition-name）：0=阴影，1=折页 */
const BAND = ["wr-band-0", "wr-band-1"];

const SAMPLES = 16;
const px = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const path = (d: string) => `path("${d}")`;

/** 随包络 e 变化的量按进度等距采样成关键帧（帧间线性插值） */
function sampled(fn: (t: number, e: number) => Keyframe): Keyframe[] {
  return Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const t = i / SAMPLES;
    return { offset: t, ...fn(t, Math.sin(Math.PI * t)) };
  });
}

function bandCss(left: number, width: number, extra: string): string {
  return `position:absolute;top:0;bottom:0;left:${px(left)}px;width:${px(width)}px;pointer-events:none;${extra}`;
}

function parseColor(c: string): [number, number, number] | null {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((x) => parseFloat(x));
    return [p[0] || 0, p[1] || 0, p[2] || 0];
  }
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)];
  }
  return null;
}

/** 折页高光三段渐变：自折痕向外 暗 → 亮 → 纸色 → 透明（暗纸加深与提亮幅度都更小，对标源码 luminance 分支） */
function foldGradient(paper: string, dark: boolean, to: "left" | "right"): string {
  const p = parseColor(paper);
  if (!p) return "";
  const mix = (target: number, k: number) => p.map((v) => Math.round(v + (target - v) * k));
  const rgba = (rgb: number[], a = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
  return `linear-gradient(to ${to},${rgba(mix(0, dark ? 0.08 : 0.15))} 0%,${rgba(mix(255, dark ? 0.14 : 0.3))} 55%,${rgba(p)} 92%,${rgba(p, 0)} 100%)`;
}

/**
 * 各效果的关键帧（纯函数）：dir=1 新页自右入，-1 自左入；w/h = 叶片尺寸。
 * old / new 施加于叶片的新旧两张快照；bands 是叠在叶片内的遮罩条（覆盖的前缘阴影、纸页的折痕阴影与折页）。
 */
export function turnKeyframes(
  effect: TurnEffect,
  dir: 1 | -1,
  w: number,
  h: number,
  o: { dark: boolean; paperColor: string | null },
): TurnKeys {
  const slideIn: Keyframe[] = [{ transform: `translateX(${px(dir * w)}px)` }, { transform: "translateX(0px)" }];
  if (effect === "slide") {
    // 新旧两页连成一条整幅平移
    return { new: slideIn, old: [{ transform: "translateX(0px)" }, { transform: `translateX(${px(-dir * w)}px)` }], bands: [] };
  }
  if (effect === "cover") {
    // 旧页留在原处；被新页压住的部分同步裁掉（叶片底色半透明，不裁会透出新页文字）
    const band = Math.min(22, w * 0.055);
    return {
      new: slideIn,
      old: [{ clipPath: "inset(0px)" }, { clipPath: dir > 0 ? "inset(0px 100% 0px 0px)" : "inset(0px 0px 0px 100%)" }],
      bands: [
        {
          name: BAND[0],
          css: bandCss(dir > 0 ? w - band : 0, band, `background:linear-gradient(to ${dir > 0 ? "right" : "left"},rgba(0,0,0,0),rgba(0,0,0,0.16));`),
          frames: sampled((t, e) => ({ transform: `translateX(${px(-dir * w * t)}px)`, opacity: e })),
        },
      ],
    };
  }
  if (effect === "fade") {
    return { new: [{ opacity: 0 }, { opacity: 1 }], old: [{ opacity: 1 }, { opacity: 0 }], bands: [] };
  }
  // paper：旧页自运动侧的边缘掀起、折痕扫过整页，新页从掀开处露出；两段裁剪沿折痕互补（不重叠即不透叠）
  const crease = (t: number) => (dir > 0 ? w * (1 - t) : w * t);
  const bendMax = Math.min(24, w * 0.045);
  const foldMax = Math.min(28, w * 0.065);
  const spread = Math.min(26, w * 0.07);
  const y1 = px(h * 0.25);
  const y2 = px(h * 0.75);
  const yh = px(h);
  // 折痕 = 自上而下、向运动反方向鼓起的三次贝塞尔（鼓起量乘 e：两端平直、中段弯曲）
  const curve = (c: number, b: number) => `C ${px(c + b)} ${y1}, ${px(c + b)} ${y2}, ${px(c)} ${yh}`;
  const clips = sampled((t, e) => {
    const c = px(crease(t));
    const edge = curve(crease(t), bendMax * e * dir);
    return dir > 0
      ? {
          // 旧页在折痕左侧，新页在右侧（含鼓出部分）
          oldClip: path(`M 0 0 L ${c} 0 ${edge} L 0 ${yh} Z`),
          newClip: path(`M ${c} 0 ${edge} L ${px(w)} ${yh} L ${px(w)} 0 Z`),
        }
      : {
          oldClip: path(`M ${c} 0 ${edge} L ${px(w)} ${yh} L ${px(w)} 0 Z`),
          newClip: path(`M 0 0 L ${c} 0 ${edge} L 0 ${yh} Z`),
        };
  });
  const pick = (key: "oldClip" | "newClip"): Keyframe[] =>
    clips.map((f) => ({ offset: f.offset, clipPath: f[key] as string }));
  // 折痕阴影：投在新页上、紧贴折痕；裁剪边界沿用同一条折痕，不会压到旧页鼓出的边
  const shadowA = o.dark ? 0.3 : 0.2;
  const shadow = sampled((t, e) => {
    const b = bendMax * e * dir;
    const c = px(crease(t));
    return dir > 0
      ? { transform: `translateX(${c}px)`, clipPath: path(`M 0 0 ${curve(0, b)} L ${px(spread)} ${yh} L ${px(spread)} 0 Z`), opacity: e }
      : {
          transform: `translateX(${px(crease(t) - w)}px)`,
          clipPath: path(`M ${px(spread)} 0 ${curve(spread, b)} L 0 ${yh} L 0 0 Z`),
          opacity: e,
        };
  });
  const bands: TurnBand[] = [
    {
      name: BAND[0],
      css: bandCss(dir > 0 ? 0 : w - spread, spread, `background:linear-gradient(to ${dir > 0 ? "right" : "left"},rgba(0,0,0,${shadowA}),rgba(0,0,0,0));`),
      frames: shadow,
    },
  ];
  // 折页条：以折痕为轴横向缩放（宽 ∝ e，鼓起量随之 ∝ e）；取不到纸面实色（自定义背景图）时不画
  if (o.paperColor) {
    const foldEdge = dir > 0 ? path(`M 0 0 L ${px(foldMax)} 0 ${curve(foldMax, bendMax)} L 0 ${yh} Z`) : path(`M ${px(foldMax)} 0 L 0 0 ${curve(0, -bendMax)} L ${px(foldMax)} ${yh} Z`);
    bands.push({
      name: BAND[1],
      css: bandCss(dir > 0 ? -foldMax : w, foldMax, `transform-origin:${dir > 0 ? "100%" : "0"} 0;clip-path:${foldEdge};background:${foldGradient(o.paperColor, o.dark, dir > 0 ? "left" : "right")};`),
      // opacity 显式写 1：起始姿态（CSS）是 0，关键帧不带它的话整段动画都不可见
      frames: sampled((t, e) => ({ transform: `translateX(${px(crease(t) - (dir > 0 ? 0 : w))}px) scaleX(${Math.max(e, 0.001).toFixed(3)})`, opacity: 1 })),
    });
  }
  return { old: pick("oldClip"), new: pick("newClip"), bands };
}

// ═══ 执行 ═══

const LEAF_OLD = "::view-transition-old(wr-leaf)";
const LEAF_NEW = "::view-transition-new(wr-leaf)";

/** 能否走快照翻页：需要 View Transitions（Chromium 111+），且文档可见——隐藏时浏览器不产帧，过渡不会推进 */
export function viewTurnSupported(): boolean {
  return typeof document !== "undefined" && typeof document.startViewTransition === "function" && document.visibilityState === "visible";
}

/** 纸页效果的折页要用纸面实色：取 iframe body 的不透明底（深色四档），否则取壳的 --wr-paper（浅色四档为不透明 hex）；都没有 → null */
export function turnPaperColor(root: Element | null, body: Element | null): string | null {
  const opaque = (c: string) => !!c && c !== "transparent" && !/^rgba\(.+,\s*0\)$/.test(c);
  if (body) {
    const bg = getComputedStyle(body).backgroundColor;
    if (opaque(bg)) return bg;
  }
  const v = root ? getComputedStyle(root).getPropertyValue("--wr-paper").trim() : "";
  return opaque(v) ? v : null;
}

/** 提交结果：dir = 新页进入的一侧（RTL 书与滚动方向相反时由提交方换算）；changed=false 表示已到书的首尾、页面没变；
 *  axis=vertical 是竖排书（纵向分页）——这里只有横向画法，竖排只翻不播 */
export type TurnCommit = { dir: 1 | -1; changed: boolean; axis?: "horizontal" | "vertical" };

export type TurnHandle = { done: Promise<void>; interrupt: () => void };

/**
 * 快照翻页：浏览器先拍旧态 → 调 commit 改 DOM → 拍新态 → 播关键帧。
 * commit 运行在浏览器的「DOM 更新回调」里——期间不产帧、requestAnimationFrame 冻结，旧页快照全程盖着
 * （跨章重建 iframe 的空窗因此不露白）；animate=false 时只当遮罩用，新态就绪即换。
 * interrupt()：新态捕获之前调用不会立即生效（那时打断会把未就绪的页面暴露出来），但会记下来——
 * 新态一捕获就跳过动画。跨章渲染期间按下的一次翻页因此不会被迫看完随后那段动画。
 */
export function runViewTurn(p: {
  effect: TurnEffect | "none";
  animate: boolean;
  duration: number;
  leaf: HTMLElement;
  dark: boolean;
  paperColor: string | null;
  commit: () => Promise<TurnCommit>;
}): TurnHandle {
  const html = document.documentElement;
  const bands: HTMLElement[] = [];
  let anims: Animation[] = [];
  let armed = false;
  let skipWanted = false;
  const skip = () =>
    anims.forEach((a) => {
      try {
        a.cancel();
      } catch {
        // 动画已结束
      }
    });
  // 关键帧在更新回调里定（提交后才知道新页进哪一侧）；装在对象里，免得控制流把外层变量收窄成 null
  const state: { plan: TurnKeys | null } = { plan: null };
  let vt: ViewTransition;
  const cleanup = () => {
    delete html.dataset.wrTurn;
    html.style.removeProperty("--wr-turn-from");
    while (bands.length) bands.pop()!.remove();
    skip();
    anims = [];
  };
  try {
    html.dataset.wrTurn = p.animate ? p.effect : "none";
    vt = document.startViewTransition(async () => {
      const r: TurnCommit = await p.commit().catch(() => ({ dir: 1, changed: false }));
      if (!p.animate || !r.changed || r.axis === "vertical") return;
      const w = p.leaf.clientWidth;
      const h = p.leaf.clientHeight;
      if (w < 40 || h < 40) return;
      state.plan = turnKeyframes(p.effect as TurnEffect, r.dir, w, h, { dark: p.dark, paperColor: p.paperColor });
      html.style.setProperty("--wr-turn-from", r.dir > 0 ? "100%" : "-100%");
      for (const b of state.plan.bands) {
        const el = document.createElement("div");
        el.style.cssText = b.css;
        el.style.setProperty("view-transition-name", b.name);
        p.leaf.appendChild(el);
        bands.push(el);
      }
    });
  } catch {
    // 浏览器拒绝发起过渡：退化为直接提交
    void p.commit().catch(() => {});
    cleanup();
    return { done: Promise.resolve(), interrupt: () => {} };
  }
  const done = (async () => {
    try {
      await vt.ready;
    } catch {
      // 过渡没走起来（更新阶段被打断 / 页面隐藏 / 提交超时）：只保证提交完成，不播动画
      await Promise.race([vt.updateCallbackDone.catch(() => {}), new Promise((r) => window.setTimeout(r, 5000))]);
      cleanup();
      return;
    }
    const { plan } = state;
    if (plan) {
      const play = (frames: Keyframe[], pseudoElement: string) => {
        try {
          anims.push(html.animate(frames, { duration: p.duration, easing: "linear", fill: "both", pseudoElement }));
        } catch {
          // 单条动画起不来不影响翻页
        }
      };
      play(plan.old, LEAF_OLD);
      play(plan.new, LEAF_NEW);
      plan.bands.forEach((b) => play(b.frames, `::view-transition-new(${b.name})`));
    }
    // 先订阅 finished、再允许取消：动画一旦 cancel()，它的 finished 就换成一个新的、永不 settle 的待定 Promise
    // （Web Animations 规范），之后再订阅就永远等不到——整个翻页队列会就此卡死
    const settled = anims.map((a) => a.finished.catch(() => {}));
    armed = true;
    if (skipWanted) skip();
    if (p.duration > 0) await Promise.all(settled);
    // 先撤叶片里的遮罩条再撤快照：否则实况露出的那一帧会看到停着的遮罩条
    cleanup();
    vt.skipTransition();
  })();
  return {
    done,
    interrupt: () => {
      if (armed) skip();
      else skipWanted = true;
    },
  };
}

/**
 * 翻页队列：每次请求恰好一页。忙碌中再来请求 → 先交给 interrupt()（当前页让不让路由它决定）；
 * 队里有积压时后续各页快进（run 的 fast=true），队尾那次才播动画。某一页出错不卡死队列。
 */
export function createTurnQueue(run: (dir: 1 | -1, fast: boolean) => Promise<void>, interrupt: () => void) {
  const queue: (1 | -1)[] = [];
  let busy = false;
  const drain = async () => {
    busy = true;
    try {
      for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
        try {
          await run(dir, queue.length > 0);
        } catch {
          // 这一页失败不影响后面的请求
        }
      }
    } finally {
      busy = false;
    }
  };
  return (dir: 1 | -1) => {
    const wasBusy = busy;
    queue.push(dir);
    if (wasBusy) interrupt();
    else void drain();
  };
}
