"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatWindowShort, type TrendInfo } from "./dashboard-helpers";
import type { WidgetId } from "./home-widgets";
import { HOME_MOBILE_ABOVE_FOLD } from "./home-widgets";

export type HomeKpiStripProps = {
  show: (id: WidgetId) => boolean;
  windowHours: number;
  summaryWindowHours: number;
  summaryLoading: boolean;
  summaryError: boolean;
  avgEps: number | null;
  throughputTotal: number | null;
  throughputTrend: TrendInfo;
  errorRate: number | null;
  errorTrend: TrendInfo;
  costLoading: boolean;
  costUnavailable: boolean;
  costEmpty: boolean;
  costUsd: number;
  costSubtitle: string;
  costTrend: "up" | "down" | null;
  costDeltaPct: number;
  issuesLoading: boolean;
  issuesUnavailable: boolean;
  openIssueCount: number | null;
};

type MetricCell = {
  id: string;
  label: string;
  value: string;
  meta: string;
  loading: boolean;
  empty: boolean;
  trend?: "up" | "down" | null;
  trendValue?: string;
  trendIsGood?: "up" | "down";
  warn?: boolean;
};

/**
 * Helicone-restraint status strip — ≤4 metrics as one tonal row.
 * Evidence under diagnosis; not an icon-chip card collage.
 */
export function HomeKpiStrip(props: HomeKpiStripProps) {
  const {
    show,
    windowHours,
    summaryWindowHours,
    summaryLoading,
    summaryError,
    avgEps,
    throughputTotal,
    throughputTrend,
    errorRate,
    errorTrend,
    costLoading,
    costUnavailable,
    costEmpty,
    costUsd,
    costSubtitle,
    costTrend,
    costDeltaPct,
    issuesLoading,
    issuesUnavailable,
    openIssueCount,
  } = props;

  const cells: MetricCell[] = [];

  if (show("throughput")) {
    const empty =
      !summaryLoading &&
      !summaryError &&
      (throughputTotal == null || throughputTotal === 0 || avgEps == null);
    cells.push({
      id: "throughput",
      label: "Throughput",
      value:
        summaryError || empty
          ? "—"
          : formatEps(avgEps!),
      meta: summaryError
        ? "unavailable"
        : empty
          ? "no events yet"
          : `${formatCount(throughputTotal!)} · ${formatWindowShort(summaryWindowHours)}`,
      loading: summaryLoading,
      empty: empty || summaryError,
      trend: summaryError || empty ? null : throughputTrend.trend,
      trendValue: summaryError || empty ? undefined : throughputTrend.trendValue,
      trendIsGood: "up",
    });
  }

  if (show("errors")) {
    const empty =
      !summaryLoading &&
      !summaryError &&
      (errorRate == null || throughputTotal === 0);
    cells.push({
      id: "errors",
      label: "Errors",
      value:
        summaryError || empty
          ? "—"
          : `${((errorRate ?? 0) * 100).toFixed(1)}%`,
      meta: summaryError
        ? "unavailable"
        : empty
          ? "no events yet"
          : formatWindowShort(windowHours),
      loading: summaryLoading,
      empty: empty || summaryError,
      trend: summaryError || empty ? null : errorTrend.trend,
      trendValue: summaryError || empty ? undefined : errorTrend.trendValue,
      trendIsGood: "down",
      warn: !summaryError && !empty && (errorRate ?? 0) > 0.05,
    });
  }

  if (show("cost")) {
    cells.push({
      id: "cost",
      label: "Cost",
      value: costEmpty || costUnavailable ? "—" : `$${costUsd.toFixed(2)}`,
      meta: costSubtitle,
      loading: costLoading,
      empty: costEmpty || costUnavailable,
      trend: costUnavailable ? null : costTrend,
      trendValue: costUnavailable
        ? undefined
        : costTrend
          ? `${Math.abs(costDeltaPct)}%`
          : undefined,
      trendIsGood: "down",
    });
  }

  if (show("issues")) {
    cells.push({
      id: "issues",
      label: "Open issues",
      value: issuesUnavailable ? "—" : String(openIssueCount ?? 0),
      meta: issuesUnavailable
        ? "unavailable"
        : openIssueCount === 0
          ? "nothing open"
          : "needs triage",
      loading: issuesLoading,
      empty: issuesUnavailable,
      warn: !issuesUnavailable && (openIssueCount ?? 0) > 0,
    });
  }

  return (
    <section
      className={cn(
        "rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40",
        "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4",
        "divide-y md:divide-y-0 md:divide-x divide-[var(--border-subtle)]",
        HOME_MOBILE_ABOVE_FOLD === 3 &&
          "max-md:[&>*:nth-child(n+4)]:hidden",
      )}
      data-testid="dashboard-status-kpis"
      data-home-shell-kpi="restraint"
      data-kpi-cap={String(HOME_MOBILE_ABOVE_FOLD)}
      aria-label="Status metrics"
    >
      {cells.map((cell) => (
        <MetricCellView key={cell.id} cell={cell} />
      ))}
    </section>
  );
}

function MetricCellView({ cell }: { cell: MetricCell }) {
  return (
    <div className="flex flex-col gap-space-1 px-space-4 py-space-3 sm:px-space-5 sm:py-space-4 min-w-0">
      <div className="flex items-center justify-between gap-space-2">
        <p className="text-xs font-medium text-[var(--text-muted)] m-0 truncate">
          {cell.label}
        </p>
        {cell.trend && cell.trendValue && !cell.loading && !cell.empty ? (
          <TrendChip
            trend={cell.trend}
            value={cell.trendValue}
            good={cell.trendIsGood ?? "up"}
          />
        ) : null}
      </div>
      {cell.loading ? (
        <Skeleton className="h-7 w-16" aria-label={`Loading ${cell.label}`} />
      ) : (
        <p
          className={cn(
            "text-2xl font-semibold font-mono tracking-tight m-0 tabular-nums",
            cell.empty
              ? "text-[var(--text-muted)]"
              : cell.warn
                ? "text-[var(--warning-strong)]"
                : "text-[var(--text-primary)]",
          )}
        >
          {cell.value}
        </p>
      )}
      <p className="text-xs text-[var(--text-faint)] font-mono m-0 truncate">
        {cell.meta}
      </p>
    </div>
  );
}

function TrendChip({
  trend,
  value,
  good,
}: {
  trend: "up" | "down";
  value: string;
  good: "up" | "down";
}) {
  const positive = trend === good;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-mono px-1.5 py-0.5 rounded shrink-0",
        positive
          ? "text-[var(--terminal)] bg-[var(--terminal-faint)]"
          : "text-[var(--error)] bg-[var(--error-dim)]",
      )}
      aria-label={`${trend === "up" ? "Up" : "Down"} ${value}`}
    >
      {trend === "up" ? (
        <ArrowUpRight className="w-3 h-3" aria-hidden />
      ) : (
        <ArrowDownRight className="w-3 h-3" aria-hidden />
      )}
      {value}
    </span>
  );
}

function formatEps(eps: number): string {
  if (eps >= 10) return eps.toFixed(1);
  if (eps >= 1) return eps.toFixed(2);
  if (eps >= 0.01) return eps.toFixed(3);
  return eps.toFixed(4);
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
