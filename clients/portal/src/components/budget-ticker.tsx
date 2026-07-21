"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";
import { fetchApi } from "@/lib/api/core";
import { Wallet, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { errorFromCaught } from "@/lib/safe-error-message";

interface TickerData {
  budget: {
    cost_hard_limit_usd: number;
    enforcement_enabled: boolean;
    threshold_alert_pct: number;
  };
  consumption: {
    cost_usd: number;
    window: string;
  };
  recent_actions: Array<{
    id: string;
    action_type: string;
    severity: string;
    cost_at_action: number;
    created_at: string;
  }>;
}

/**
 * Compact budget ticker card for the sidebar / dashboard.
 * Polls /budget/ticker every 30s; renders a single
 * colour-coded progress bar + recent-event count.
 */
const BUDGET_TICKER_INTERVAL_MS = 30_000;

export function BudgetTicker() {
  const { currentOrg } = useOrg();
  const [data, setData] = useState<TickerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!currentOrg?.id) return;
    try {
      const d = await fetchApi<{ data?: TickerData }>(
        `/orgs/${currentOrg.id}/budget/ticker`,
      );
      setData(d.data ?? null);
      setError(null);
    } catch (err) {
      console.error("Ticker fetch failed", err);
      setError(errorFromCaught(err, "Budget unavailable"));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

  // Single poll path: usePolling fires immediately on start + every
  // intervalMs. A parallel useEffect fetch duplicated the first hit
  // on every org flip (2× /budget/ticker per switch).
  useEffect(() => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setError(null);
  }, [currentOrg?.id]);

  // Cost-safe polling — pauses on tab-hidden, backs off on errors,
  // permanent bail on 401/403. Interval ≥30s (K2).
  usePolling({
    fetch: fetchData,
    intervalMs: BUDGET_TICKER_INTERVAL_MS,
    enabled: Boolean(currentOrg?.id),
    deps: [currentOrg?.id],
  });

  if (!currentOrg) return null;

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-3 text-xs text-[var(--text-secondary)]">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading budget…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-xs text-[var(--error)]">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-3 text-xs text-[var(--text-secondary)]">
        No budget data
      </div>
    );
  }

  const cost = data.consumption.cost_usd;
  const cap = data.budget.cost_hard_limit_usd;
  const pct = cap > 0 ? (cost / cap) * 100 : 0;
  const alertPct =
    typeof data.budget.threshold_alert_pct === "number"
      ? data.budget.threshold_alert_pct
      : 80;
  const status =
    pct >= 100 ? "exceeded" : pct >= alertPct ? "alert" : "ok";
  const highSeverityCount = data.recent_actions.filter(
    (a) => a.severity === "high"
  ).length;

  return (
    <Link
      href="/optimization?tab=budget"
      className={cn(
        "block rounded-md border p-3 transition-colors hover:border-[var(--accent)]/40",
        status === "exceeded"
          ? "border-[var(--error)]/30 bg-[var(--error-bg)]"
          : status === "alert"
          ? "border-[var(--warning)]/30 bg-[var(--warning-bg)]"
          : "border-[var(--border-default)] bg-[var(--bg-elev-1)]"
      )}
      aria-label="Open budget settings"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
          <Wallet className="h-3 w-3" />
          {data.consumption.window} budget
        </div>
        {status === "exceeded" ? (
          <AlertTriangle className="h-3 w-3 text-[var(--error)]" />
        ) : status === "alert" ? (
          <AlertTriangle className="h-3 w-3 text-[var(--warning)]" />
        ) : (
          <CheckCircle2 className="h-3 w-3 text-[var(--success)]" />
        )}
      </div>
      <div className="mt-2 text-lg font-semibold text-[var(--text-primary)]">
        ${cost.toFixed(2)}
        <span className="ml-1 text-xs font-normal text-[var(--text-secondary)]">
          / ${cap.toFixed(2)}
        </span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[var(--bg-elev-2)]">
        <div
          className={cn(
            "h-full transition-all",
            status === "exceeded"
              ? "bg-[var(--error)]"
              : status === "alert"
              ? "bg-[var(--warning)]"
              : "bg-[var(--success)]"
          )}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      {highSeverityCount > 0 && (
        <div className="mt-2 text-xs text-[var(--error)]">
          {highSeverityCount} high-severity event
          {highSeverityCount === 1 ? "" : "s"} in last 10
        </div>
      )}
      {!data.budget.enforcement_enabled && (
        <div className="mt-2 text-xs text-[var(--text-secondary)]">
          Enforcement off (advisory)
        </div>
      )}
    </Link>
  );
}
