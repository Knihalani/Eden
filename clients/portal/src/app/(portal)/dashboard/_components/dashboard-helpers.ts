import { ApiError } from "@/lib/api";

/** Trace list row used by Home failures + helpers. */
export interface TraceRow {
  trace_id: string;
  agent_id: string | null;
  outcome: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  span_count: number;
  realm: string;
}

/**
 * Soft-fail ONLY undeployed / not-found shards (404) and intentional
 * validation quirks (422). Real outages (5xx) and auth failures
 * (401/403) must throw so `isError` fires and the banner shows —
 * never silent-null "all systems normal" / KPI theatre.
 */
export async function shardOr404Null<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 422)) {
      return null;
    }
    throw e;
  }
}

export function formatWindowShort(hours: number): string {
  if (hours >= 168) return "7d";
  if (hours === 24) return "24h";
  return `${hours}h`;
}

export function computeP95(traces: TraceRow[]): number | null {
  const durations = traces
    .map((t) => t.duration_ms)
    .filter((d): d is number => typeof d === "number" && d >= 0);
  if (durations.length === 0) return null;
  durations.sort((a, b) => a - b);
  const idx = Math.min(
    durations.length - 1,
    Math.floor(durations.length * 0.95),
  );
  return durations[idx];
}

export function computeP50(traces: TraceRow[]): number | null {
  const durations = traces
    .map((t) => t.duration_ms)
    .filter((d): d is number => typeof d === "number" && d >= 0);
  if (durations.length === 0) return null;
  durations.sort((a, b) => a - b);
  return durations[Math.floor(durations.length / 2)];
}

export function countBySeverity(
  alerts: Array<{ severity: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of alerts) {
    counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  }
  return counts;
}

export function isFailureOutcome(outcome: string | null): boolean {
  if (!outcome) return false;
  const o = outcome.toLowerCase();
  return o === "failure" || o === "failed" || o === "error";
}

export type TrendInfo = {
  trend: "up" | "down" | null;
  trendValue: string | undefined;
};

export function pctTrend(
  current: number | null | undefined,
  previous: number | null | undefined,
): TrendInfo {
  if (
    current == null ||
    previous == null ||
    previous <= 0 ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  ) {
    return { trend: null, trendValue: undefined };
  }
  const deltaPct = Math.round(((current - previous) / previous) * 100);
  if (deltaPct === 0) return { trend: null, trendValue: undefined };
  return {
    trend: deltaPct > 0 ? "up" : "down",
    trendValue: `${Math.abs(deltaPct)}%`,
  };
}
