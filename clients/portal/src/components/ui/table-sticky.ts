/**
 * Shared sticky-first-column classes for dense tables on narrow viewports.
 * Use with an `overflow-x-auto` scroll parent so identity stays visible while
 * other columns scroll. Pair th/td with matching z/bg so cells do not bleed.
 */

/** Position + stacking only — pair with a solid bg token on the cell. */
export const STICKY_FIRST = "sticky left-0 z-10";

/** Header cell pinned to the left edge. */
export const STICKY_FIRST_TH = `${STICKY_FIRST} bg-[var(--bg-secondary)]`;

/** Body cell pinned to the left edge. */
export const STICKY_FIRST_TD = `${STICKY_FIRST} bg-[var(--bg-primary)]`;
