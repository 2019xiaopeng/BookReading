import { useEffect, useRef, useState } from "react";

import { clampZoomScale, panClamp } from "../image/layout";

// shortcut: 放大显示的是 .opt 当前 blob（已降采样 ≤1520px，2x DPR 够用）；按需取原图需 .opt→原书条目名映射表
// （生成 .opt 时留映射，升级后 readEpubImage(bookId, entry) 换源），当前 content hook 时机拿不到原始条目名。
export type ZoomState = { scale: number; tx: number; ty: number };

/** P-1：光标锚点缩放（锚点=视图中心坐标系下的指针位置；原点为内容中心，与 ImageReader 同款数学） */
export function zoomAnchored(
  z: ZoomState,
  factor: number,
  px: number,
  py: number,
  viewW: number,
  viewH: number,
  contentW: number,
  contentH: number,
): ZoomState {
  const scale = clampZoomScale(z.scale * factor);
  if (scale === z.scale) return z;
  const k = scale / z.scale;
  return { scale, ...panClamp(px - (px - z.tx) * k, py - (py - z.ty) * k, viewW, viewH, contentW, contentH, scale) };
}

/** 基础适配尺寸（不放大超过原始像素）：内容在视口内的 1x 显示宽高 */
export function baseFitSize(naturalW: number, naturalH: number, viewW: number, viewH: number): { w: number; h: number } {
  if (naturalW <= 0 || naturalH <= 0 || viewW <= 0 || viewH <= 0) return { w: 0, h: 0 };
  const k = Math.min(viewW / naturalW, viewH / naturalH, 1);
  return { w: naturalW * k, h: naturalH * k };
}

const RESET: ZoomState = { scale: 1, tx: 0, ty: 0 };

/** P-1 图片 Lightbox：全屏浮层，滚轮缩放（0.5–4x 光标锚点）+ 拖拽平移 + 双击复位 + Esc/点背景关闭 */
export default function ImageLightbox(props: { src: string; alt?: string; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState<ZoomState>(RESET);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        props.onClose();
      }
    };
    // capture 阶段 + stopImmediatePropagation：ReaderPage 的 window keydown（bubble 阶段，
    // Esc 语义=关抽屉>解锁>唤醒栏）不能抢走 Lightbox 的 Esc
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [props.onClose]);

  // 滚轮=缩放（preventDefault+stopPropagation：防背后 epub 滚动/翻页滚轮）
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - rect.width / 2;
      const py = e.clientY - rect.top - rect.height / 2;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom(zoomAnchored(zoomRef.current, factor, px, py, rect.width, rect.height, sizeRef.current.w, sizeRef.current.h));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 拖拽平移（指针锚点；panClamp 复用漫画阅读器数学）
  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (zoom.scale === 1) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const start = zoom;
    const onMove = (ev: PointerEvent) => {
      const d = sizeRef.current;
      const root = rootRef.current;
      const vw = root?.clientWidth ?? window.innerWidth;
      const vh = root?.clientHeight ?? window.innerHeight;
      setZoom({ ...start, ...panClamp(start.tx + ev.clientX - sx, start.ty + ev.clientY - sy, vw, vh, d.w, d.h, start.scale) });
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      ref={rootRef}
      className="wr-lightbox"
      role="dialog"
      aria-label="图片查看"
      // 布局样式内联（weread.css 本批禁改；z=hud 之下最高——toast 之上、一切阅读层之上）
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "calc(var(--wr-z-hud) - 1)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--wr-scrim)",
        cursor: "zoom-out",
      }}
      // 点背景关闭（img 自身点击不冒泡关闭——拖拽结束的 click 落在 img 上）
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <img
        ref={imgRef}
        src={props.src}
        alt={props.alt ?? ""}
        draggable={false}
        style={{
          maxWidth: "92%",
          maxHeight: "92%",
          objectFit: "contain",
          transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`,
          cursor: zoom.scale > 1 ? "grab" : "zoom-in",
          userSelect: "none",
        }}
        onLoad={(e) => {
          const el = e.currentTarget;
          const root = rootRef.current;
          setSize(baseFitSize(el.naturalWidth, el.naturalHeight, root?.clientWidth ?? 0, root?.clientHeight ?? 0));
          setZoom(RESET);
        }}
        onDoubleClick={() => setZoom(RESET)}
        onPointerDown={onPointerDown}
      />
      <div
        className="wr-lightbox-hint"
        style={{
          position: "absolute",
          bottom: 16,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 12,
          color: "rgba(255, 255, 255, 0.72)",
          pointerEvents: "none",
        }}
      >
        滚轮缩放 · 拖拽平移 · 双击复位 · Esc 关闭
      </div>
    </div>
  );
}
