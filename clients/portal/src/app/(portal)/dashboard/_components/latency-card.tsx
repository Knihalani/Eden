"use client";

import { Loader2, Timer, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface LatencyCardProps {
  loading: boolean;
  p95Ms: number | null;
  p50Ms?: number | null;
  trend?: "up" | "down" | null;
  trendValue?: string;
  /** The threshold above which latency is "bad" (e.g. 5000ms) */
  budgetMs?: number;
  href?: string;
}

export function LatencyCard({
  loading,
  p95Ms,
  trend,
  trendValue,
  budgetMs = 5000,
  href = "/observability",
}: LatencyCardProps) {
  const empty = !loading && p95Ms == null;
  const ratio = p95Ms != null && budgetMs > 0 ? Math.min(p95Ms / budgetMs, 1) : 0;

  // Color the bar based on ratio
  const barColor =
    ratio < 0.5
      ? "var(--success)"
      : ratio < 0.8
        ? "var(--warning)"
        : "var(--error)";

  // For latency, "down" is good (lower latency)
  const trendIsGood = trend ? (trend === "down" ? "up" : "down") : "up";

  return (
    <a
      href={href}
      className="block bg-[var(--bg-primary)] rounded-xl p-5 border border-[var(--border-default)] transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2.5 rounded-lg bg-[var(--primary-light)] text-[var(--primary)]">
            <Timer className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-secondary)]">p95 Latency</p>
            <p className="text-xs text-[var(--text-muted)]">last hour</p>
          </div>
        </div>
        {trend && trendValue && !empty && (
          <div
            className={cn(
              "flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded",
              trend === trendIsGood
                ? "text-[var(--success)] bg-[var(--success-bg)]"
                : "text-[var(--error)] bg-[var(--error-bg)]"
            )}
          >
            {trend === "up" ? (
              <ArrowUpRight className="w-3 h-3" />
            ) : (
              <ArrowDownRight className="w-3 h-3" />
            )}
            {trendValue}
          </div>
        )}
      </div>

      <div className="mt-2">
        <p className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
          {loading ? (
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          ) : empty || p95Ms == null ? (
            <span className="text-[var(--text-muted)]">—</span>
          ) : (
            formatMs(p95Ms)
          )}
        </p>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">budget: {formatMs(budgetMs)}</p>
      </div>

      {/* Latency utilization bar */}
      <div className="mt-4">
        <div className="h-2 w-full bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
          {empty ? (
            <div className="h-full w-full bg-[var(--bg-tertiary)]" />
          ) : (
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${ratio * 100}%`, backgroundColor: barColor }}
            />
          )}
        </div>
      </div>
    </a>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
