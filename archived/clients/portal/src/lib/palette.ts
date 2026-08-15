/**
 * Wave 10 — the ⌘K command palette was keyboard-only and undiscoverable.
 * Visible triggers (sidebar, mobile header) dispatch this event; the
 * palette listens for it in addition to the Cmd+K shortcut.
 */

/** Custom event name that opens the global ⌘K command palette. */
export const OPEN_PALETTE_EVENT = "eden:open-command-palette";

/** Dispatch the event from visible triggers. No-op outside a browser. */
export function openCommandPalette(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
}
