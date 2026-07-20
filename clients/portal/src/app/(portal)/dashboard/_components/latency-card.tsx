"use client";

import Link from "next/link";
import { Timer, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface LatencyCardProps {
  loading: boolean;
  /** Soft-fail / outage — do not present as calm empty. */
  unavailable?: boolean;
  p95Ms: number | null;
  p50Ms?: number | null;
  trend?: "up" | "down" | null;
  trendValue?: string;
  href?: string;
}

export function LatencyCard({
  loading,
  unavailable = false,
  p95Ms,
  p50Ms = null,
  trend,
  trendValue,
  href = "/traces",
}: LatencyCardProps) {
  const empty = !loading && !unavailable && p95Ms == null;

  // For latency, "down" is good (lower latency)
  const trendIsGood = trend ? (trend === "down" ? "up" : "down") : "up";

  return (
    <Link
      href={href}
      className="block transition-colors hover:border-[var(--border-strong)]"
    >
      <Card variant="interactive" padding="lg" className="h-full">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-lg bg-[var(--primary-light)] text-[var(--primary)]">
              <Timer className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-secondary)]">
                p95 Latency
              </p>
              <p className="text-xs text-[var(--text-muted)]">last 24h</p>
            </div>
          </div>
          {trend && trendValue && !empty && !unavailable && !loading && (
            <div
              className={cn(
                "flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded",
                trend === trendIsGood
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

        <div className="mt-2">
          {loading ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading latency">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
          ) : (
            <>
              <p className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
                {unavailable || empty || p95Ms == null ? (
                  <span className="text-[var(--text-muted)]">—</span>
                ) : (
                  formatMs(p95Ms)
                )}
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {unavailable
                  ? "latency unavailable"
                  : empty
                    ? "no latency data"
                    : p50Ms != null
                      ? `p50 ${formatMs(p50Ms)}`
                      : "p50 —"}
              </p>
            </>
          )}
        </div>
      </Card>
    </Link>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
