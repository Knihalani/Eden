"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

export interface TraceSplitLayoutProps {
  master: ReactNode;
  detail: ReactNode | null;
  className?: string;
  /** default 400 */
  panelMinPx?: number;
  /** stack below this width; default 800 */
  stackBelowPx?: number;
}

export function TraceSplitLayout({
  master,
  detail,
  className,
  panelMinPx = 400,
  stackBelowPx = 800,
}: TraceSplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [detailWidth, setDetailWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setContainerWidth(w);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const stacked = containerWidth < stackBelowPx;
  const showDetail = detail != null;
  const sideBySide = showDetail && !stacked;

  useEffect(() => {
    if (detailWidth == null || !sideBySide || containerWidth <= 0) return;
    const max = Math.max(panelMinPx, containerWidth - panelMinPx);
    const next = Math.min(max, Math.max(panelMinPx, detailWidth));
    if (next !== detailWidth) setDetailWidth(next);
  }, [containerWidth, detailWidth, panelMinPx, sideBySide]);

  const clampWidth = useCallback(
    (width: number) => {
      const max = Math.max(panelMinPx, containerWidth - panelMinPx);
      return Math.min(max, Math.max(panelMinPx, width));
    },
    [containerWidth, panelMinPx],
  );

  const onResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const fallback = clampWidth(Math.floor(containerWidth * 0.5));
      dragRef.current = {
        startX: e.clientX,
        startWidth: detailWidth ?? fallback,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [clampWidth, containerWidth, detailWidth],
  );

  const onResizePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - e.clientX;
      setDetailWidth(clampWidth(dragRef.current.startWidth + delta));
    },
    [clampWidth],
  );

  const onResizePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const detailStyle: CSSProperties | undefined = sideBySide
    ? detailWidth != null
      ? {
          width: detailWidth,
          minWidth: panelMinPx,
          flex: "0 0 auto",
        }
      : {
          minWidth: panelMinPx,
          flex: "1 1 0%",
          maxWidth: "50%",
        }
    : undefined;

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 w-full",
        stacked ? "flex-col" : "flex-row",
        className,
      )}
      data-testid="trace-split-layout"
      data-stacked={stacked ? "true" : "false"}
    >
      <div className="min-w-0 flex-1">{master}</div>
      {sideBySide ? (
        <div
          role="separator"
          aria-orientation="vertical"
          data-testid="trace-split-resize"
          className="w-[6px] min-w-[6px] shrink-0 cursor-col-resize self-stretch"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        />
      ) : null}
      {showDetail ? (
        <div
          className={cn("min-w-0", stacked ? "w-full" : undefined)}
          style={detailStyle}
        >
          {detail}
        </div>
      ) : null}
    </div>
  );
}
