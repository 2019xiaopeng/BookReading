// V-1 翻页动画矩阵（对标 Wenku8_Flutter lib/reader_sheet_motion.dart，2026-11-25 源码拆解）：
// 单一 progress 纯函数 + 效果=纯画法差异；叶片=宿主容器（对 div 施 transform/clip-path，
// iframe 整体参与 GPU 合成，内部零重排零截图）。数值全为相对页宽，包络 e=sin(πt)（中段最大两端归零）。
import type { PageAnimation } from "../settings/types";

/**
 * 翻页动画矩阵总开关。
 * v3.1.9 发版时关闭（用户 2026-11-25 裁定 B）：GhostView 双容器路径与覆盖 / 纸页两个新效果带已知缺陷
 * （新叶嵌在旧叶里、夜间底色半透明、兜底路径混入——见 docs/开发计划-v3.2.md V-1「已知缺陷」），
 * 关闭后翻页与设置选项完全回到 v3.1.8 的行为。
 * shortcut: 关闭期间已存的 cover / paper 值按渐隐处理且不在选项里显示；动画阶段修完三处根因、逐帧验收后置 true
 */
export const TURN_FX_ENABLED = false;

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

export type TurnShadow = { x: number; width: number; alpha: number; toRight: boolean };
export type TurnFold = { x: number; width: number; flip: boolean };

export type TurnFrame = {
  oldTransform: string;
  newTransform: string;
  oldOpacity: number;
  newOpacity: number;
  /** clip-path path()；"" = 不裁 */
  oldClip: string;
  newClip: string;
  /** 覆盖：压在新叶之下、投在旧叶上的前缘软阴影（渐变朝前缘收紧） */
  underShadow: TurnShadow | null;
  /** 纸页：最上层折痕阴影带（对称 透明→墨→透明） */
  creaseShadow: TurnShadow | null;
  /** 纸页：最上层折页高光条（暗→亮→纸色三段渐变，模拟纸背受光）；null=无（t 两端或无纸色） */
  fold: TurnFold | null;
};

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const px = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

const BASE: TurnFrame = {
  oldTransform: "",
  newTransform: "",
  oldOpacity: 1,
  newOpacity: 1,
  oldClip: "",
  newClip: "",
  underShadow: null,
  creaseShadow: null,
  fold: null,
};

/** 动画帧几何（纯函数）：direction 1=前进（新页自右入），-1=后退 */
export function turnFrame(
  effect: TurnEffect,
  direction: 1 | -1,
  tRaw: number,
  w: number,
  h: number,
  dark = false,
): TurnFrame {
  const t = clamp01(tRaw);
  const e = Math.sin(Math.PI * t);
  if (effect === "slide") {
    return {
      ...BASE,
      oldTransform: `translateX(${px(-direction * w * t)}px)`,
      newTransform: `translateX(${px(direction * w * (1 - t))}px)`,
    };
  }
  if (effect === "cover") {
    const bandW = Math.min(22, w * 0.055) * e;
    const lead = direction > 0 ? w * (1 - t) : w * t;
    return {
      ...BASE,
      newTransform: `translateX(${px(direction * w * (1 - t))}px)`,
      underShadow:
        bandW > 0.5
          ? { x: direction > 0 ? lead - bandW : lead, width: bandW, alpha: 0.16 * e, toRight: direction > 0 }
          : null,
    };
  }
  if (effect === "fade") {
    return { ...BASE, oldOpacity: 1 - t, newOpacity: t };
  }
  // paper —— 纸页翻动：两互补弧形 clip 沿移动折痕分界 + 折痕阴影带 + 折页高光
  const bend = Math.min(24, w * 0.045) * e * direction;
  const fold = Math.min(28, w * 0.065) * e;
  const spread = Math.min(26, w * 0.07);
  const crease = direction > 0 ? w * (1 - t) : w * t;
  const edge = (x: number, b: number) =>
    `C ${px(x + b)} ${px(h * 0.25)}, ${px(x + b)} ${px(h * 0.75)}, ${px(x)} ${px(h)}`;
  const rightClip = (x: number, b: number) => `path("M ${px(x)} 0 ${edge(x, b)} L ${px(w)} ${px(h)} L ${px(w)} 0 Z")`;
  const leftClip = (x: number, b: number) => `path("M 0 0 L ${px(x)} 0 ${edge(x, b)} L 0 ${px(h)} Z")`;
  return {
    ...BASE,
    // 前进：折痕自右缘扫向左缘——旧叶留折痕右侧，新叶露左侧并让出 fold 宽的折页条；后退镜像
    oldClip: direction > 0 ? rightClip(crease, bend) : leftClip(crease, bend),
    newClip: direction > 0 ? leftClip(crease + fold, bend) : rightClip(crease - fold, bend),
    creaseShadow: {
      x: (direction > 0 ? crease : crease - fold) - spread,
      width: fold + spread * 2,
      alpha: (dark ? 0.3 : 0.2) * e,
      toRight: true,
    },
    fold: fold > 0.5 ? { x: Math.min(crease, crease + direction * fold), width: fold, flip: direction < 0 } : null,
  };
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

const lerpC = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);

/** 折页高光三段渐变（纸色→暗→亮→纸色；暗纸加深幅度小、提亮幅度也小，对标源码 luminance 分支） */
function foldColors(paper: string, dark: boolean, flip: boolean): string[] {
  const p = parseColor(paper);
  if (!p) return [paper, paper, paper];
  const kd = dark ? 0.08 : 0.15;
  const kw = dark ? 0.14 : 0.3;
  const colors = [
    `rgb(${lerpC(p[0], 0, kd)}, ${lerpC(p[1], 0, kd)}, ${lerpC(p[2], 0, kd)})`,
    `rgb(${lerpC(p[0], 255, kw)}, ${lerpC(p[1], 255, kw)}, ${lerpC(p[2], 255, kw)})`,
    paper,
  ];
  return flip ? colors.reverse() : colors;
}

/**
 * 双叶翻页动画（rAF 线性驱动——progress 与几何 1:1 映射，对标参考实现的 Curves.linear）。
 * oldLeaf=主视图宿主容器（旧页），newLeaf=GhostView 宿主容器（新页，背景须不透明纸色）；
 * 结束时叶片停在终态（旧叶移出/新叶归位），样式复位与 ghost 销毁由调用方在提交后处理。
 */
export async function runTurnAnimation(p: {
  effect: TurnEffect;
  direction: 1 | -1;
  width: number;
  height: number;
  duration: number;
  oldLeaf: HTMLElement;
  newLeaf: HTMLElement;
  dark: boolean;
  /** 纸色（折页高光渐变端点）；null=跳过高光条（自定义背景下取不到实色） */
  paperColor: string | null;
}): Promise<void> {
  const { oldLeaf, newLeaf, effect, direction, width, height, dark, paperColor, duration } = p;
  const host = newLeaf.parentElement;
  const mkOverlay = () => {
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;top:0;bottom:0;pointer-events:none;";
    return d;
  };
  const under = mkOverlay(); // 覆盖：前缘软阴影（插在两叶之间，投在旧叶上）
  const band = mkOverlay(); // 纸页：折痕阴影带（最上层）
  const foldEl = mkOverlay(); // 纸页：折页高光条（最上层）
  let underIn = false;
  let overIn = false;
  const apply = (t: number) => {
    const f = turnFrame(effect, direction, t, width, height, dark);
    oldLeaf.style.transform = f.oldTransform;
    newLeaf.style.transform = f.newTransform;
    oldLeaf.style.opacity = f.oldOpacity === 1 ? "" : String(f.oldOpacity);
    newLeaf.style.opacity = f.newOpacity === 1 ? "" : String(f.newOpacity);
    oldLeaf.style.clipPath = f.oldClip;
    newLeaf.style.clipPath = f.newClip;
    if (f.underShadow && host) {
      if (!underIn) {
        host.insertBefore(under, newLeaf);
        underIn = true;
      }
      under.style.left = `${f.underShadow.x}px`;
      under.style.width = `${f.underShadow.width}px`;
      under.style.background = `linear-gradient(to ${f.underShadow.toRight ? "right" : "left"}, transparent, rgba(0, 0, 0,${f.underShadow.alpha.toFixed(3)}))`;
    } else if (underIn) {
      under.remove();
      underIn = false;
    }
    if (host && (f.creaseShadow || f.fold)) {
      if (!overIn) {
        host.appendChild(band);
        host.appendChild(foldEl);
        overIn = true;
      }
      if (f.creaseShadow) {
        band.style.left = `${f.creaseShadow.x}px`;
        band.style.width = `${f.creaseShadow.width}px`;
        band.style.background = `linear-gradient(to right, transparent, rgba(0, 0, 0,${f.creaseShadow.alpha.toFixed(3)}), transparent)`;
      }
      if (f.fold && paperColor) {
        foldEl.style.left = `${f.fold.x}px`;
        foldEl.style.width = `${f.fold.width}px`;
        foldEl.style.background = `linear-gradient(to ${f.fold.flip ? "left" : "right"}, ${foldColors(paperColor, dark, f.fold.flip).join(", ")})`;
      }
    } else if (overIn) {
      band.remove();
      foldEl.remove();
      overIn = false;
    }
  };
  const cleanup = () => {
    under.remove();
    band.remove();
    foldEl.remove();
  };
  if (duration <= 0) {
    apply(1);
    cleanup();
    return;
  }
  await new Promise<void>((resolve) => {
    const start = performance.now();
    const tick = () => {
      const t = (performance.now() - start) / duration;
      apply(clamp01(t));
      if (t >= 1) {
        cleanup();
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
