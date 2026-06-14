/**
 * Shared chart utilities for /optimization and /analytics pages.
 * Centralizes:
 *   - axis tick styling (matches dashboard & analytics-tab)
 *   - currency / large-number formatters
 *   - deterministic synthetic data fallback (used when the server has no
 *     /optimization or /analytics sub-routes yet)
 *   - dark-terminal palette tokens
 *
 * Importable from any client component on the portal.
 */

/* ----------------------------- Theme tokens ------------------------------ */

export const CHART_COLORS = {
  // primary series
  accent: "var(--accent)",
  primary: "var(--primary)",
  success: "var(--success)",
  warning: "var(--warning)",
  error: "var(--error)",
  // categorical palette (used in donuts / multi-bar)
  series: [
    "var(--accent)",
    "var(--primary)",
    "var(--stage-executing)",
    "var(--stage-archiving)",
    "var(--stage-refining)",
    "var(--warning)",
    "var(--stage-verifying)",
    "var(--error)",
  ],
} as const;

export const TOOLTIP_STYLE = {
  backgroundColor: "var(--bg-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: "8px",
  fontSize: "12px",
  color: "var(--text-primary)",
  boxShadow: "var(--shadow-md)",
} as const;

export const AXIS_TICK_PROPS = {
  fontSize: 11,
  fill: "var(--text-muted)",
} as const;

/* --------------------------- Formatters --------------------------------- */

export function formatCurrency(value: number, opts?: { compact?: boolean }): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "$0";
  if (opts?.compact && Math.abs(value) >= 1000) {
    if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCompact(value: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

export function formatTokens(value: number): string {
  if (!value) return "0";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function formatLatency(ms: number): string {
  if (!ms) return "0ms";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

export function formatPercent(value: number, digits = 1): string {
  if (!value && value !== 0) return "0%";
  return `${value.toFixed(digits)}%`;
}

export function formatChartDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatHour(hour: number): string {
  if (hour === 0) return "12am";
  if (hour === 12) return "12pm";
  if (hour < 12) return `${hour}am`;
  return `${hour - 12}pm`;
}

/* ----------------------- Date range helpers ----------------------------- */

/** Build a list of YYYY-MM-DD strings for the last `days` days (oldest first). */
export function buildDateRange(days: number, endDate: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().split("T")[0]);
  }
  return out;
}

