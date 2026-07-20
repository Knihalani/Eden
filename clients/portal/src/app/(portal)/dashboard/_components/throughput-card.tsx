"use client";

import Link from "next/link";
import { Activity, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface ThroughputCardProps {
  loading: boolean;
  /** Soft-fail / outage — do not present as calm empty. */
  unavailable?: boolean;
  /**
   * Average events/sec over the observability summary window
   * (total_traces / window_seconds). Not a live sample.
   */
  avgEps: number | null;
  /** Total traces in that same window — shown as context. */
  totalTraces: number | null;
  /** Summary window length for the subtitle (default 24). */
  windowHours?: number;
  trend?: "up" | "down" | null;
  trendValue?: string;
  href?: string;
}

export function ThroughputCard({
  loading,
  unavailable = false,
  avgEps,
  totalTraces,
  windowHours = 24,
  trend,
  trendValue,
  href = "/traces",
}: ThroughputCardProps) {
  const empty =
    !loading &&
    !unavailable &&
    (totalTraces == null || totalTraces === 0 || avgEps == null);

  return (
    <Link
      href={href}
      className="block transition-colors hover:border-[var(--border-strong)]"
    >
      <Card variant="interactive" padding="lg" className="h-full">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-lg bg-[var(--accent-light)] text-[var(--accent)]">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-secondary)]">
                Throughput
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                avg · last {windowHours}h
              </p>
            </div>
          </div>
          {trend && trendValue && !empty && !unavailable && !loading && (
            <div
              className={cn(
                "flex items-center gap-1 text-xs font-medium px-1.5 py-1 rounded",
                trend === "up"
                  ? "text-[var(--success)] bg-[var(--success-bg)]"
                  : "text-[var(--error)] bg-[var(--error-bg)]",
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

        <div className="flex items-end gap-3 mt-3">
          <div className="w-full">
            {loading ? (
              <div
                className="space-y-2"
                aria-busy="true"
                aria-label="Loading throughput"
              >
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-3 w-36" />
              </div>
            ) : (
              <>
                <p className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
                  {unavailable || empty ? (
                    <span className="text-[var(--text-muted)]">—</span>
                  ) : (
                    formatEps(avgEps!)
                  )}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {unavailable
                    ? "throughput unavailable"
                    : empty
                      ? "no events yet"
                      : `${formatCount(totalTraces!)} traces · events / sec`}
                </p>
              </>
            )}
          </div>
        </div>
      </Card>
    </Link>
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
