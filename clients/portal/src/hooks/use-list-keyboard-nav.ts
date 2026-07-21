"use client";

import { useCallback } from "react";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

/** True when focus is inside the transcript reader (span j/k owns the keys). */
export function isFocusInTranscript(): boolean {
  const el = document.activeElement;
  return Boolean(
    el instanceof HTMLElement && el.closest('[data-testid="transcript-v2"]'),
  );
}

/**
 * j/k + ArrowDown/ArrowUp list navigation for portal resource pages (U19 / Wave 11).
 * Enter re-selects / opens the current index (Observe V3 Wave 6).
 * Skips j/k when focus is in transcript so span nav does not clash.
 */
export function useListKeyboardNav(
  itemCount: number,
  selectedIndex: number,
  onSelectIndex: (index: number) => void,
  enabled = true,
): void {
  const step = useCallback(
    (delta: number) => {
      if (itemCount <= 0) return;
      if (isFocusInTranscript()) return;
      const next = Math.max(0, Math.min(itemCount - 1, selectedIndex + delta));
      if (next !== selectedIndex) onSelectIndex(next);
    },
    [itemCount, selectedIndex, onSelectIndex],
  );

  const openCurrent = useCallback(() => {
    if (itemCount <= 0) return;
    if (isFocusInTranscript()) return;
    const idx = Math.max(0, Math.min(itemCount - 1, selectedIndex));
    onSelectIndex(idx);
  }, [itemCount, selectedIndex, onSelectIndex]);

  useKeyboardShortcuts(
    {
      j: () => step(1),
      k: () => step(-1),
      ArrowDown: () => step(1),
      ArrowUp: () => step(-1),
      Enter: () => openCurrent(),
    },
    enabled && itemCount > 0,
  );
}
