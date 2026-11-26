// V-3 开场：启动画面 + 壳体入场。
// 启动画面是 index.html 里的静态 #wr-splash（图标 + 标题），页面一加载就显示，盖住加载脚本期间的空档；
// 壳第一次挂载并画出第一帧后由 AppLayout 调 dismissSplash() 撤掉（放大淡出），同时壳体开始入场（画法在 weread.css 的
// .wr-shell--intro）。入场只播一次：整个进程里只有 AppLayout 第一次挂载时 pending 还是 true——托盘唤起不重挂壳；
// 从阅读页回到壳会重挂，但那时 pending 已经是 false。
export const introState = { pending: true };

/** 撤掉启动画面：默认放大淡出；instant = 直接连根带走（「减少动态效果」） */
export function dismissSplash(instant = false): void {
  const el = document.getElementById("wr-splash");
  if (!el) return;
  if (instant) {
    el.remove();
    return;
  }
  el.classList.add("is-leaving");
  window.setTimeout(() => el.remove(), 700);
}
