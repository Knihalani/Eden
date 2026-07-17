"use client";

import { useCallback } from "react";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

/**
 * j/k list navigation for portal resource pages (U19).
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
      const next = Math.max(0, Math.min(itemCount - 1, selectedIndex + delta));
      if (next !== selectedIndex) onSelectIndex(next);
    },
    [itemCount, selectedIndex, onSelectIndex],
  );

  useKeyboardShortcuts(
    {
      j: () => step(1),
      k: () => step(-1),
    },
    enabled && itemCount > 0,
  );
}
