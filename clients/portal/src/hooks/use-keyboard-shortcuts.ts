"use client";

/**
 * useKeyboardShortcuts — global key bindings for the observability
 * page (Phase 7.2 C7).
 *
 *   j/k        step down/up in the trace list
 *   o          open the selected trace detail
 *   esc        close the detail panel
 *   /          focus the search input
 *   1-4        switch tab (Traces / Tree / Timeline / Scores)
 *   l          toggle Live tail
 *   ?          show the shortcut overlay
 *
 * The hook attaches a single document-level keydown listener and
 * is no-op when the focus is in an input or textarea (so typing
 * in the search box doesn't trigger shortcuts).
 */

import * as React from "react";

export interface ShortcutMap {
  j?: () => void;
  k?: () => void;
  o?: () => void;
  esc?: () => void;
  "/"? : () => void;
  "1"?: () => void;
  "2"?: () => void;
  "3"?: () => void;
  "4"?: () => void;
  l?: () => void;
  "?"?: () => void;
  [key: string]: (() => void) | undefined;
}

function isTextInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts(map: ShortcutMap, enabled: boolean = true): void {
  React.useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return;
      // Don't trigger with modifier keys
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      const fn = map[key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [map, enabled]);
}
