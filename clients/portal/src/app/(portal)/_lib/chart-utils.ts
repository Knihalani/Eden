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
  backgroundColor: "var(--surface)",
  border: "1px solid var(--border)",
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

/* ------------------- Deterministic synthetic data ----------------------- */
// Used when backend routes return 404 (e.g. /optimization/* is not yet
// implemented on the server). The shape and magnitudes match what the real
// endpoint is expected to return, so swapping in real data is a one-line
// change at the call site.

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function pseudoRandom(seed: number, i: number): number {
  const x = Math.sin(seed * 9301 + i * 49297) * 233280;
  return x - Math.floor(x);
}

export interface SyntheticSeedOptions {
  orgId: string;
  days: number;
}

export function makeSyntheticCostByModel(opts: SyntheticSeedOptions) {
  const models = [
    { model: "gpt-4o", share: 0.42 },
    { model: "claude-sonnet-4.5", share: 0.28 },
    { model: "gpt-4o-mini", share: 0.15 },
    { model: "claude-haiku-4.5", share: 0.10 },
    { model: "o1-preview", share: 0.05 },
  ];
  const seed = hashString(`${opts.orgId}:cost-by-model:${opts.days}`);
  return models.map((m, idx) => {
    const total = 240 * (0.6 + pseudoRandom(seed, idx) * 0.8);
    return {
      model: m.model,
      cost_usd: Math.round(total * m.share * 100) / 100,
      tokens: Math.round(total * 14_000 * m.share),
      requests: Math.round(60 * m.share * (0.7 + pseudoRandom(seed, idx + 7))),
    };
  });
}

export function makeSyntheticCostOverTime(opts: SyntheticSeedOptions) {
  const dates = buildDateRange(opts.days);
  const seed = hashString(`${opts.orgId}:cost-over-time:${opts.days}`);
  return dates.map((date, i) => {
    const base = 6 + pseudoRandom(seed, i) * 14;
    const trend = i / Math.max(1, dates.length - 1);
    return { date, cost_usd: Math.round((base + trend * 8) * 100) / 100 };
  });
}

export function makeSyntheticCacheByDay(opts: SyntheticSeedOptions) {
  const dates = buildDateRange(opts.days);
  const seed = hashString(`${opts.orgId}:cache:${opts.days}`);
  return dates.map((date, i) => {
    const hits = Math.round(80 + pseudoRandom(seed, i) * 60);
    const misses = Math.round(15 + pseudoRandom(seed, i + 99) * 20);
    return {
      date,
      cache_hits: hits,
      cache_misses: misses,
      tokens_saved: hits * 1800,
      cost_saved_usd: Math.round(hits * 0.012 * 100) / 100,
    };
  });
}

export function makeSyntheticSavingsByDay(opts: SyntheticSeedOptions) {
  const dates = buildDateRange(opts.days);
  const seed = hashString(`${opts.orgId}:savings:${opts.days}`);
  return dates.map((date, i) => {
    const actual = 4 + pseudoRandom(seed, i) * 8;
    const baseline = actual * (1.4 + pseudoRandom(seed, i + 3) * 0.6);
    return {
      date,
      baseline_cost_usd: Math.round(baseline * 100) / 100,
      actual_cost_usd: Math.round(actual * 100) / 100,
    };
  });
}

export function makeSyntheticBudget(orgId: string) {
  const seed = hashString(`${orgId}:budget`);
  const daysInto = new Date().getDate();
  const daysInMonth = 30;
  const spent = 320 + pseudoRandom(seed, 1) * 200;
  const budget = 1200;
  return {
    budget_usd: budget,
    spent_usd: Math.round(spent * 100) / 100,
    burn_pct: Math.round((spent / budget) * 1000) / 10,
    days_into_period: daysInto,
    days_remaining: Math.max(0, daysInMonth - daysInto),
    projected_eom_cost_usd: Math.round((spent / Math.max(1, daysInto)) * daysInMonth * 100) / 100,
    on_track: spent / Math.max(1, daysInto) < budget / daysInMonth,
  };
}

export function makeSyntheticCostPerTrace(opts: SyntheticSeedOptions) {
  const seed = hashString(`${opts.orgId}:cost-per-trace:${opts.days}`);
  const models = ["gpt-4o", "claude-sonnet-4.5", "gpt-4o-mini", "claude-haiku-4.5", "o1-preview"];
  const out: Array<{
    trace_id: string;
    cost_usd: number;
    tokens: number;
    latency_ms: number;
    model: string;
  }> = [];
  for (let i = 0; i < 80; i++) {
    const modelIdx = Math.floor(pseudoRandom(seed, i) * models.length);
    const cost = 0.005 + pseudoRandom(seed, i + 5) * 0.4;
    const tokens = 800 + Math.floor(pseudoRandom(seed, i + 7) * 18000);
    const latency = 200 + pseudoRandom(seed, i + 11) * 4500;
    out.push({
      trace_id: `trc_${i.toString(16).padStart(6, "0")}`,
      cost_usd: Math.round(cost * 1000) / 1000,
      tokens,
      latency_ms: Math.round(latency),
      model: models[modelIdx],
    });
  }
  return out;
}

export function makeSyntheticTokenUsageByDay(opts: SyntheticSeedOptions) {
  const dates = buildDateRange(opts.days);
  const seed = hashString(`${opts.orgId}:token-usage:${opts.days}`);
  return dates.map((date, i) => {
    const input = 30_000 + pseudoRandom(seed, i) * 80_000;
    const output = 12_000 + pseudoRandom(seed, i + 9) * 24_000;
    return {
      date,
      input_tokens: Math.round(input),
      output_tokens: Math.round(output),
    };
  });
}

export function makeSyntheticLatencyByDay(opts: SyntheticSeedOptions) {
  const dates = buildDateRange(opts.days);
  const seed = hashString(`${opts.orgId}:latency:${opts.days}`);
  return dates.map((date, i) => {
    const p50 = 350 + pseudoRandom(seed, i) * 200;
    const p95 = p50 * (2.4 + pseudoRandom(seed, i + 3) * 0.6);
    const p99 = p95 * (1.6 + pseudoRandom(seed, i + 5) * 0.4);
    return {
      date,
      p50_ms: Math.round(p50),
      p95_ms: Math.round(p95),
      p99_ms: Math.round(p99),
    };
  });
}

export function makeSyntheticThroughputByHour(opts: SyntheticSeedOptions) {
  const seed = hashString(`${opts.orgId}:throughput:${opts.days}`);
  // 7 weekdays x 24 hours
  const out: Array<{ hour: number; weekday: number; requests: number }> = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      // Business hours (9-18) on weekdays = high; nights/weekends = low.
      const isWeekday = weekday < 5;
      const isBusinessHour = hour >= 9 && hour <= 18;
      const base = isWeekday && isBusinessHour ? 80 : isWeekday ? 20 : 8;
      const noise = pseudoRandom(seed, weekday * 24 + hour) * base * 0.6;
      out.push({ hour, weekday, requests: Math.round(base + noise) });
    }
  }
  return out;
}

export function makeSyntheticTopAgents(opts: SyntheticSeedOptions) {
  const seed = hashString(`${opts.orgId}:top-agents:${opts.days}`);
  const agents = [
    "planner",
    "critic",
    "refiner",
    "executor",
    "code-quality",
    "verifier",
    "tester",
    "archivist",
  ];
  return agents
    .map((agent, i) => ({
      agent,
      cost_usd: Math.round((8 + pseudoRandom(seed, i) * 40) * 100) / 100,
      requests: Math.round(40 + pseudoRandom(seed, i + 11) * 200),
      avg_latency_ms: Math.round(400 + pseudoRandom(seed, i + 23) * 1800),
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
}

/* ------------------ "fetch with synthetic fallback" --------------------- */

export interface FetchWithFallbackOpts<T> {
  fetcher: () => Promise<T>;
  fallback: () => T;
  /** Don't fall back to synthetic data — return null so the caller can show a real error. */
  fatal?: boolean;
}

export interface FetchWithFallbackResult<T> {
  data: T | null;
  isSynthetic: boolean;
  error: string | null;
}

/**
 * Wraps an api.* call so that 404 (or any error) gracefully degrades to
 * deterministic synthetic data. Pages use this to render real charts even
 * when the backend routes for optimization aren't built yet.
 */
export async function fetchWithFallback<T>(
  opts: FetchWithFallbackOpts<T>
): Promise<FetchWithFallbackResult<T>> {
  try {
    const data = await opts.fetcher();
    return { data, isSynthetic: false, error: null };
  } catch (e) {
    if (opts.fatal) {
      return {
        data: null,
        isSynthetic: false,
        error: e instanceof Error ? e.message : "Request failed",
      };
    }
    return { data: opts.fallback(), isSynthetic: true, error: null };
  }
}
