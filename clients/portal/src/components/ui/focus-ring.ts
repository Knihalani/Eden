/**
 * Focus ring token helpers — pair with globals.css `--focus-ring`.
 * Prefer native :focus-visible rules; use these class strings when
 * composing interactive surfaces that opt out of the global ring.
 */
export const FOCUS_RING_CLASS =
  "focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--focus-ring-offset),0_0_0_4px_var(--focus-ring)]";

export const FOCUS_RING_VARS = {
  ring: "var(--focus-ring)",
  offset: "var(--focus-ring-offset)",
} as const;
