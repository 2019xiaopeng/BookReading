/**
 * U-14/U-15/U-22 桌面纯化全局监听（E 线）：右键分区接管的第一道兜底 + 图片拖影 +
 * 浏览器残留快捷键的 JS 纵深（WebView2 COM 层已关总开关，此处防回归）。
 * AppShell 与 ReaderPage 挂载时各调一次（幂等）——两条路由树之外没有别的常驻面。
 * 只 preventDefault 不 stopPropagation：各区域自绘菜单（React onContextMenu）照常收到事件。
 */
let installed = false;

/** 纯：本次按键是否属于"无编辑语义、应全拦"的浏览器残留键（输入框内也拦） */
export function isBrowserResidueKey(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): boolean {
  if (e.key === "F5") return true;
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    return k === "r" || k === "p" || k === "s" || k === "u";
  }
  return false;
}

/** 纯：右键目标是否编辑语义元素（放行原生，输入需要） */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el?.closest?.("input, textarea, [contenteditable]");
}

export function installDesktopChrome(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // 全局右键拦截：自绘菜单区域由 React 分区接管（preventDefault 不挡它们），空白区不出任何菜单
  window.addEventListener(
    "contextmenu",
    (e) => {
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
    },
    { capture: true },
  );
  // 图片原生拖拽（浏览器拖影）全局禁用；自家书卡归架是 Pointer Events 自绘 ghost，不受影响
  window.addEventListener(
    "dragstart",
    (e) => {
      if ((e.target as HTMLElement | null)?.tagName === "IMG") e.preventDefault();
    },
    { capture: true },
  );
  // F5 / Ctrl+R/P/S/U 纵深拦截（COM 层 AreBrowserAcceleratorKeysEnabled=false 已禁，防回归）
  window.addEventListener(
    "keydown",
    (e) => {
      if (isBrowserResidueKey(e)) e.preventDefault();
    },
    { capture: true },
  );
}
