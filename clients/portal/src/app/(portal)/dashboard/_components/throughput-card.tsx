"use client";

import { Loader2, Activity, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { AreaChart, Area, ResponsiveContainer, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

interface ThroughputCardProps {
  loading: boolean;
  /** events-per-minute buckets over the last 5 minutes (length should be ~5) */
  series: Array<{ t: string; eps: number }>;
  /** current events-per-second */
  currentEps: number;
  trend?: "up" | "down" | null;
  trendValue?: string;
  href?: string;
}

export function ThroughputCard({
  loading,
  series,
  currentEps,
  trend,
  trendValue,
  href = "/observability",
}: ThroughputCardProps) {
  const hasData = series.some((p) => p.eps > 0);
  const empty = !loading && !hasData;

  return (
    <a
      href={href}
      className="block transition-shadow hover:shadow-md"
    >
      <Card variant="interactive" padding="lg" className="h-full">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2.5">
          <div className="p-2.5 rounded-lg bg-[var(--accent-light)] text-[var(--accent)]">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-secondary)]">Live Throughput</p>
            <p className="text-xs text-[var(--text-muted)]">last 5 min</p>
          </div>
        </div>
        {trend && trendValue && !empty && (
          <div
            className={cn(
              "flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded",
              trend === "up"
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

      <div className="flex items-end gap-3 mt-3">
        <div>
          <p className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
            {loading ? (
              <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
            ) : empty ? (
              <span className="text-[var(--text-muted)]">—</span>
            ) : (
              currentEps.toFixed(2)
            )}
          </p>
          <p className="text-xs text-[var(--text-muted)]">events / sec</p>
        </div>
      </div>

      <div className="h-16 mt-3 -mx-1">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : empty ? (
          <div className="h-full flex items-center justify-center text-xs text-[var(--text-muted)]">
            No events yet
          </div>
        ) : (
          <div role="img" aria-label="Live throughput over last 5 minutes">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="throughputGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Area
                type="monotone"
                dataKey="eps"
                stroke="var(--accent)"
                strokeWidth={2}
                fill="url(#throughputGradient)"
                isAnimationActive={false}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
          </div>
        )}
      </div>
    </Card></a>
  );
}
