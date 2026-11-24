// V-1 纸页折影翻页：纯 CSS 变换 + rAF 角度插值（不用 WebGL）。
// 折痕阴影随角度实时渐变（0° 无 → 90° 最大 → 180° 消失）：强度 = sin(p·π)，与 rotateY 同帧经 --fold-crease 下发 CSS。

/** 翻页折影参数：originX=旋转轴（书脊侧），to=终角（±180°，符号决定翻向） */
export type FoldSpec = { originX: "left" | "center" | "right"; to: number };

/** 视觉方向（RTL 已折算过的“内容前进方向”）→ 轴与终角。双页=中缝为轴（左右两页同翻）；单页=书脊侧为轴。 */
export function foldSpec(direction: "next" | "prev", double: boolean): FoldSpec {
  if (double) return { originX: "center", to: direction === "next" ? -180 : 180 };
  return direction === "next" ? { originX: "left", to: -180 } : { originX: "right", to: 180 };
}

/** smoothstep：起手缓（纸张阻滞感）→ 中段快 → 收尾缓；p=0.5 恰过 90°（折痕峰值） */
export function smoothFold(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** 折痕强度：0°→0、90°→1、180°→0 */
export function foldCrease(p: number): number {
  return Math.sin(Math.PI * Math.min(1, Math.max(0, p)));
}

export type FoldHandle = { finish: () => void; accelerate: () => void; done: Promise<void> };

/** rAF 驱动覆盖层 0→±180° 折页；finish()=立即跳到终态（快速连按中断用），done 在自然结束与中断两种路径都 resolve */
export function playFold(el: HTMLElement, opts: { durationMs: number; spec: FoldSpec }): FoldHandle {
  let raf = 0;
  let finished = false;
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  // V-1 修正：快速连按不再直接跳终态（生硬闪烁），而是加速到 3 倍速完成剩余动画
  // ——保底看到折页动作，同时确保 100ms 内结束不阻塞下一次翻页
  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    el.style.transform = "";
    el.style.removeProperty("--fold-crease");
    resolve();
  };
  el.style.transformOrigin = `${opts.spec.originX} center`;
  el.dataset.foldAxis = opts.spec.originX; // 折痕渐变方向随轴（CSS ::before/::after 按 data-fold-axis 取向）
  const t0 = performance.now();
  let speed = 1;
  const frame = (now: number) => {
    if (finished) return;
    const t = Math.min(1, ((now - t0) * speed) / Math.max(1, opts.durationMs));
    const p = smoothFold(t);
    el.style.transform = `perspective(1800px) rotateY(${(opts.spec.to * p).toFixed(2)}deg)`;
    el.style.setProperty("--fold-crease", foldCrease(p).toFixed(3));
    if (t >= 1) {
      finish();
      return;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  // accelerate=中断时加速而非跳终态（保底折页可见）；finish 仅在清理时用
  const accelerate = () => { speed = 3 };
  return { finish, accelerate, done };
}

/**
 * V-1 双缓冲：把 root 的当前渲染内容定格为顶层覆盖层（挂在 root.parentElement 内，指针事件由 CSS 关掉）。
 * cloneNode 不复制 iframe 文档与 canvas 位图：iframe 走同源 importNode 整文档（挂进 DOM 后 contentDocument 才可用），
 * canvas 走 drawImage 回填，img 保持同 src（blob 已缓存零延迟）。返回元素由调用方在动画后 remove()。
 */
export function createPageSnapshot(root: HTMLElement | null): HTMLElement | null {
  const host = root?.parentElement;
  const source = root?.firstElementChild;
  if (!root || !host || !source) return null;
  const overlay = document.createElement("div");
  overlay.className = "wr-fold-layer";
  overlay.appendChild(source.cloneNode(true));
  const srcCanvases = Array.from(root.querySelectorAll("canvas"));
  const dstCanvases = Array.from(overlay.querySelectorAll("canvas"));
  for (let i = 0; i < srcCanvases.length && i < dstCanvases.length; i++) {
    const s = srcCanvases[i];
    const d = dstCanvases[i];
    d.width = s.width;
    d.height = s.height;
    if (s.width > 0 && s.height > 0) d.getContext("2d")?.drawImage(s, 0, 0);
  }
  host.appendChild(overlay);
  const srcFrames = Array.from(root.querySelectorAll("iframe"));
  const dstFrames = Array.from(overlay.querySelectorAll("iframe"));
  for (let i = 0; i < srcFrames.length && i < dstFrames.length; i++) {
    try {
      const srcDoc = srcFrames[i].contentDocument;
      const dstDoc = dstFrames[i].contentDocument;
      if (!srcDoc?.documentElement || !dstDoc) continue;
      dstDoc.replaceChild(dstDoc.importNode(srcDoc.documentElement, true), dstDoc.documentElement);
    } catch {
      // 文档未就绪等罕见场景：该 iframe 留空，仅失去这一次快照
    }
  }
  return overlay;
}
