import { useEffect, useRef, useState, type RefObject } from "react";

export function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>): { width: number; height: number } {
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const nextWidth = Math.round(el.clientWidth);
      const nextHeight = Math.round(el.clientHeight);
      setSize((prev) => {
        if (prev.width === nextWidth && prev.height === nextHeight) return prev;
        return { width: nextWidth, height: nextHeight };
      });
    };

    const schedule = () => {
      if (rafRef.current != null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        measure();
      });
    };

    measure();

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        schedule();
      });
      ro.observe(el);
    }

    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [ref]);

  return size;
}

