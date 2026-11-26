// V-13 首 / 末页轻提示：到头再翻时屏幕正中弹一个小胶囊（沿用阅读器 .wr-toast 的样子），
// 淡入 → 停留 → 淡出共 1s，不挡交互。直接改 DOM、不走 React state：ReaderPage 是一棵两千多行的树，为一条提示重渲不划算。
// 显示中再触发不重播淡入，只把淡出往后挪——按住方向键时不会一下一下地闪。

const SHOW_MS = 1000;
const FADE_IN_MS = 140;
const FADE_OUT_MS = 220;

let el: HTMLElement | null = null;
let fade: Animation | null = null;
let hideTimer = 0;

const TEXT = {
  page: { prev: "已是第一页", next: "已是最后一页" },
  // 按章翻的入口（滚动模式 / 底栏章钮）说「章」
  chapter: { prev: "已是第一章", next: "已是最后一章" },
} as const;

export function showEdgeHint(host: Element | null, direction: "prev" | "next", kind: keyof typeof TEXT): void {
  if (!host) return;
  let fresh = false;
  if (!el || el.parentElement !== host) {
    el?.remove();
    el = document.createElement("div");
    el.className = "wr-toast wr-toast--center";
    el.setAttribute("role", "status");
    host.appendChild(el);
    fresh = true;
  }
  const node = el;
  node.textContent = TEXT[kind][direction];
  window.clearTimeout(hideTimer);
  // 先读当前透明度再取消：半途淡出时再触发，从原地淡回来而不是跳一下
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const from = reduced ? 1 : fresh ? 0 : Number(getComputedStyle(node).opacity);
  fade?.cancel();
  // 淡入不留 forwards：结束后的自然透明度本就是 1，不留就不会在元素上攒下已结束的动画
  if (from < 1) fade = node.animate([{ opacity: from }, { opacity: 1 }], { duration: FADE_IN_MS });
  // 系统「减少动态效果」：直接出现、直接消失
  hideTimer = window.setTimeout(
    () => {
      if (reduced) node.remove();
      else fade = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_OUT_MS, fill: "forwards" });
    },
    reduced ? SHOW_MS : SHOW_MS - FADE_OUT_MS,
  );
}
