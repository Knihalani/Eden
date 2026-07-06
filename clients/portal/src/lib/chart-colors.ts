/** Chart color values using CSS custom properties for dark-theme adaptability.
 *
 * ui-audit 2026-07-06 H1: recharts' <Cell fill="…"> and <Bar fill="…"> do
 * NOT resolve var() — they need concrete strings (recharts uses inline SVG
 * attributes, which bypass CSS). So we need two parallel sources:
 *
 *   1. `STORAGE_COLORS` (var() form) — for components that DO accept
 *      CSS strings (e.g. inline style="…", CSS background-fill, the
 *      bar `fill` attribute in some browsers).
 *
 *   2. `STORAGE_COLORS_RESOLVED` (concrete RGB form) — for recharts
 *      props. Resolved from globals.css at module load (client) or
 *      from `SSR_FALLBACK_HEX` (server).
 *
 * Adding a new token? Update BOTH arrays below. The audit caught the
 * previous bug where the SSR fallback used (#ef4444 / #8b5cf6) and
 * didn't match the live tokens — the chart flashed red+violet on
 * first paint, then purple+pink after hydration. Today the values
 * mirror `--chart-pie-1` through `--chart-pie-5` exactly.
 */
export const CHART_COLORS = {
  accent: "var(--chart-accent)",
  primary: "var(--chart-primary)",
  outcome: {
    gold: "var(--chart-outcome-gold)",
    silver: "var(--chart-outcome-silver)",
    bronze: "var(--chart-outcome-bronze)",
    partial: "var(--chart-outcome-partial)",
    failed: "var(--chart-outcome-failed)",
  },
  status: {
    pending: "var(--chart-label)",
    running: "var(--chart-accent)",
    completed: "var(--chart-success)",
    failed: "var(--chart-error)",
    human_review: "var(--chart-warning)",
    cancelled: "var(--chart-label)",
  },
  grid: "var(--chart-grid)",
  muted: "var(--chart-label)",
} as const;

export const STORAGE_COLORS = [
  "var(--chart-pie-1)",
  "var(--chart-pie-2)",
  "var(--chart-pie-3)",
  "var(--chart-pie-4)",
  "var(--chart-pie-5)",
] as const;

/** SSR fallback hex values — MUST match the values in globals.css for
 * `--chart-pie-1` through `--chart-pie-5`. Update both together.
 *
 * Order matters: index 0 = pie-1 (#5B9EFF accent blue), index 1 = pie-2
 * (#5FE5A8 terminal green), index 2 = pie-3 (#FFB547 warning gold),
 * index 3 = pie-4 (#C084FC purple), index 4 = pie-5 (#E879F9 magenta). */
export const STORAGE_COLORS_SSR_FALLBACK = [
  "#5B9EFF",
  "#5FE5A8",
  "#FFB547",
  "#C084FC",
  "#E879F9",
] as const;

/** Concrete-string pie palette for recharts. Reads from CSSOM at module
 * init when `window` is defined; otherwise uses the SSR fallback above.
 *
 * If you suspect a token mismatch, the right place to look is the
 * `--chart-pie-N` definitions in `globals.css` + the fallback array
 * above — they should be the same hex. */
export function getStorageColorsResolved(): readonly string[] {
  if (typeof window === "undefined") return STORAGE_COLORS_SSR_FALLBACK;
  const style = getComputedStyle(document.documentElement);
  return STORAGE_COLORS.map((tokenRef, idx) => {
    // tokenRef is "var(--chart-pie-N)" — extract the var name.
    const match = tokenRef.match(/var\((--[^)]+)\)/);
    if (!match) return STORAGE_COLORS_SSR_FALLBACK[idx];
    const resolved = style.getPropertyValue(match[1]).trim();
    return resolved || STORAGE_COLORS_SSR_FALLBACK[idx];
  });
}

export function getOutcomeChartColor(tier: string): string {
  return CHART_COLORS.outcome[tier as keyof typeof CHART_COLORS.outcome] ?? CHART_COLORS.muted;
}
