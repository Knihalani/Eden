"use client";

/**
 * Shortcut help overlay — a small keyboard map dialog for pages that have
 * list-level shortcuts (Traces: j/k, tab-switch letters, `/` search).
 *
 * Wave 14: the shortcuts existed but were undiscoverable — the `?` affordance
 * the keyboard hook always promised was never wired. This dialog gives any
 * page a consistent way to surface its map: mount it, render a `?` trigger
 * (or bind the `?` key via ``useListKeyboard``'s ``onHelp``), and it handles
 * the modal chrome (scrim, Escape, focus management) so pages don't each
 * hand-roll one.
 */

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ShortcutRow {
  keys: string;
  label: string;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ShortcutHelp({
  open,
  onClose,
  title = "Keyboard shortcuts",
  shortcuts,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  shortcuts: ShortcutRow[];
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
    const panel = panelRef.current;
    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? panel)?.focus({ preventScroll: true });

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused.current?.focus?.({ preventScroll: true });
      previouslyFocused.current = null;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-[var(--scrim)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close keyboard shortcuts"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="relative w-full max-w-sm rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg)] p-4 shadow-[0_8px_32px_rgba(0,0,0,0.45)] outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] pb-2.5">
          <h2 id={titleId} className="type-ui text-[var(--text)]">
            {title}
          </h2>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <ul className="mt-2.5 divide-y divide-[var(--line)]">
          {shortcuts.map((row) => (
            <li
              key={row.keys}
              className="flex items-baseline justify-between gap-4 py-2"
            >
              <span className="type-body text-[var(--text-secondary)]">
                {row.label}
              </span>
              <kbd
                className={cn(
                  "type-mono shrink-0 rounded border border-[var(--line)] bg-[var(--bg-inset)]",
                  "px-1.5 py-0.5 text-[0.6875rem] !text-[var(--text)]",
                )}
              >
                {row.keys}
              </kbd>
            </li>
          ))}
        </ul>
        <p className="type-meta mt-3 text-[var(--text-faint)]">
          Press Esc to close
        </p>
      </div>
    </div>
  );
}
