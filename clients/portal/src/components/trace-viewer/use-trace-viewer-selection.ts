"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * One selection model: spanId + inspector open.
 * Esc closes inspector first, then viewer (via onRequestClose).
 */
export function useTraceViewerSelection(opts: {
  highlightSpanId?: string | null;
  onSpanSelect?: (spanId: string | null) => void;
  onRequestClose?: () => void;
  /** When true, Esc is owned by this hook (Dialog should not auto-close). */
  open: boolean;
}) {
  const { highlightSpanId, onSpanSelect, onRequestClose, open } = opts;

  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(
    highlightSpanId ?? null,
  );
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(highlightSpanId));

  useEffect(() => {
    if (highlightSpanId) {
      setSelectedSpanId(highlightSpanId);
      setInspectorOpen(true);
    } else {
      setInspectorOpen(false);
    }
  }, [highlightSpanId]);

  const selectSpan = useCallback(
    (spanId: string | null, openInspector = true) => {
      setSelectedSpanId(spanId);
      if (spanId && openInspector) setInspectorOpen(true);
      if (!spanId) setInspectorOpen(false);
      onSpanSelect?.(spanId);
    },
    [onSpanSelect],
  );

  const openInspector = useCallback(() => {
    if (selectedSpanId) setInspectorOpen(true);
  }, [selectedSpanId]);

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    onSpanSelect?.(null);
  }, [onSpanSelect]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (inspectorOpen) {
        e.preventDefault();
        e.stopPropagation();
        setInspectorOpen(false);
        onSpanSelect?.(null);
        return;
      }
      onRequestClose?.();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, inspectorOpen, onRequestClose, onSpanSelect]);

  return {
    selectedSpanId,
    inspectorOpen,
    selectSpan,
    openInspector,
    closeInspector,
  };
}
