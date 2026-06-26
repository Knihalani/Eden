"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";
import { Wallet, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface TickerData {
  budget: {
    cost_hard_limit_usd: number;
    enforcement_enabled: boolean;
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
 * Polls /budget/ticker every 5s; renders a single
 * colour-coded progress bar + recent-event count.
 */
export function BudgetTicker() {
  const { currentOrg } = useOrg();
  const [data, setData] = useState<TickerData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!currentOrg?.id) return;
    try {
      const res = await fetch(
        `${API_BASE}/orgs/${currentOrg.id}/budget/ticker`,
        { credentials: "include" }
      );
      if (res.ok) {
        const d = await res.json();
        setData(d.data);
      }
    } catch (err) {
      console.error("Ticker fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    if (!currentOrg?.id) return;
    fetchData();
  }, [currentOrg?.id, fetchData]);

  // Cost-safe polling — pauses on tab-hidden, backs off on errors,
  // permanent bail on 401/403. Replaces the raw setInterval that
  // would have kept firing through all three failure modes. The
  // hook's ``tick`` fires once on mount + every ``intervalMs`` after
  // success. June 2026 cost-pass.
  usePolling({
    fetch: fetchData,
    intervalMs: 5_000,
    enabled: Boolean(currentOrg?.id),
    deps: [currentOrg?.id],
  });

  if (!currentOrg) return null;
  if (loading || !data) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-3 text-xs text-[var(--text-secondary)]">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading budget…
      </div>
    );
  }

  const cost = data.consumption.cost_usd;
  const cap = data.budget.cost_hard_limit_usd;
  const pct = cap > 0 ? (cost / cap) * 100 : 0;
  const status =
    pct >= 100 ? "exceeded" : pct >= 80 ? "alert" : "ok";
  const highSeverityCount = data.recent_actions.filter(
    (a) => a.severity === "high"
  ).length;

  return (
    <div
      className={cn(
        "rounded-md border p-3",
        status === "exceeded"
          ? "border-red-500/40 bg-red-500/5"
          : status === "alert"
          ? "border-yellow-500/40 bg-yellow-500/5"
          : "border-[var(--border-default)] bg-[var(--bg-elev-1)]"
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
          <Wallet className="h-3 w-3" />
          {data.consumption.window} budget
        </div>
        {status === "exceeded" ? (
          <AlertTriangle className="h-3 w-3 text-red-400" />
        ) : status === "alert" ? (
          <AlertTriangle className="h-3 w-3 text-yellow-400" />
        ) : (
          <CheckCircle2 className="h-3 w-3 text-green-400" />
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
              ? "bg-red-500"
              : status === "alert"
              ? "bg-yellow-500"
              : "bg-green-500"
          )}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      {highSeverityCount > 0 && (
        <div className="mt-2 text-xs text-red-400">
          {highSeverityCount} high-severity event
          {highSeverityCount === 1 ? "" : "s"} in last 10
        </div>
      )}
      {!data.budget.enforcement_enabled && (
        <div className="mt-2 text-xs text-[var(--text-secondary)]">
          Enforcement off (advisory)
        </div>
      )}
    </div>
  );
}