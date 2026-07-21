"use client";

import { useEffect } from "react";

export interface UseTranscriptKeyboardOptions {
  spanIds: string[];
  selectedSpanId: string | null;
  onSelect: (spanId: string) => void;
  enabled?: boolean;
}

/**
 * N13 / Observe V3 Wave 6: j/k (and ↑/↓) move between transcript steps.
 * Only when focus is inside the transcript root — list hub owns j/k otherwise.
 * Modifier chords (⌘K) are ignored.
 */
export function useTranscriptKeyboard({
  spanIds,
  selectedSpanId,
  onSelect,
  enabled = true,
}: UseTranscriptKeyboardOptions) {
  useEffect(() => {
    if (!enabled || spanIds.length === 0) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      // Scope to transcript so hub list j/k / Enter stay intact.
      if (!target?.closest?.('[data-testid="transcript-v2"]')) return;

      const down = e.key === "j" || e.key === "ArrowDown";
      const up = e.key === "k" || e.key === "ArrowUp";
      if (!down && !up) return;

      e.preventDefault();
      const idx = selectedSpanId ? spanIds.indexOf(selectedSpanId) : -1;
      const next = down
        ? spanIds[Math.min(Math.max(idx, -1) + 1, spanIds.length - 1)]
        : spanIds[Math.max(idx <= 0 ? 0 : idx - 1, 0)];
      if (next) onSelect(next);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spanIds, selectedSpanId, onSelect, enabled]);
}
