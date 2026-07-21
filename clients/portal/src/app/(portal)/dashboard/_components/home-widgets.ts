/**
 * Home composition catalog — Status → Diagnosis → Action (Wave 6 / 7 / 11).
 * Fixed order: ≤4 KPIs + diagnosis + recent failures. No widget editor.
 */

export const ALL_WIDGETS = [
  "throughput",
  "errors",
  "cost",
  "issues",
  "failures",
  "traces",
] as const;

export type WidgetId = (typeof ALL_WIDGETS)[number];

/** Default Home — 4 KPI + diagnosis + recent failures (≤7 slots). */
export const HOME_KPI_CAP_DESKTOP = 7;
/** KPI strip hard cap (Helicone-restraint; not a card collage). */
export const HOME_KPI_STRIP_CAP = 4;
/** Mobile above-fold metric cells. */
export const HOME_MOBILE_ABOVE_FOLD = 3;

export const DEFAULT_WIDGETS: WidgetId[] = [
  "throughput",
  "errors",
  "cost",
  "issues",
  "failures",
  "traces",
];

/** KPI ids that appear in the restraint strip (subset of DEFAULT_WIDGETS). */
export const HOME_KPI_IDS = [
  "throughput",
  "errors",
  "cost",
  "issues",
] as const satisfies readonly WidgetId[];

void (DEFAULT_WIDGETS.length <= HOME_KPI_CAP_DESKTOP ||
  (() => {
    throw new Error("DEFAULT_WIDGETS exceeds HOME_KPI_CAP_DESKTOP (AC-04)");
  })());

void (
  HOME_KPI_IDS.length <= HOME_KPI_STRIP_CAP ||
  (() => {
    throw new Error("Default KPI strip exceeds HOME_KPI_STRIP_CAP");
  })()
);

export const TIME_RANGES = [
  { hours: 1, label: "Last 1h" },
  { hours: 6, label: "Last 6h" },
  { hours: 24, label: "Last 24h" },
  { hours: 168, label: "Last 7d" },
] as const;

/** Optional quiet footer destinations — text links, not cards. */
export const HOME_QUIET_LINKS = [
  { label: "Traces", href: "/traces" },
  { label: "Issues", href: "/issues" },
  { label: "Agents", href: "/agents" },
  { label: "Scorecard", href: "/improve/scorecard" },
] as const;
