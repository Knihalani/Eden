"use client";

/**
 * HeatmapTab — extracted from observability/page.tsx (June 2026).
 * Renders a 2D heatmap of a metric vs (x, y) buckets.
 */
import { BarChart3, Zap, Loader2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { HeatmapData } from "../_lib/types";
import { Card } from "@/components/ui/card";
const METRICS = ["duration_ms", "duration_ms_otel", "ttft_ms", "itl_ms_avg", "tpot_ms", "completion_duration_ms", "server_request_duration_ms", "cache_hit_duration_ms", "reward", "step_duration_ms", "cumulative_reward"];
export function HeatmapTab({
  data,
  metric,
  onMetricChange,
  onRefresh,
  loading
}: {
  data: HeatmapData | null;
  metric: string;
  onMetricChange: (m: string) => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  if (!data && !loading) {
    return <EmptyState
    // 'terminal' variant replaces the generic icon with a
    // preview of the data the user is about to load — a 4×3
    // mock heatmap with realistic intensity stops. This is a
    // stronger product moment than a chart icon: it tells the
    // user "this is what you'd see" without making them load.
    variant="terminal" terminal={<div className="rounded-lg overflow-hidden border border-[var(--border-default)] bg-[var(--bg-base)] shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)]">
            <div className="flex items-center gap-1.5 px-3 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
              <span className="w-2 h-2 rounded-full bg-[var(--traffic-close)]" />
              <span className="w-2 h-2 rounded-full bg-[var(--traffic-minimize)]" />
              <span className="w-2 h-2 rounded-full bg-[var(--traffic-zoom)]" />
              <span className="ml-2 text-[10px] font-mono text-[var(--text-muted)] tracking-wider">
                duration_ms × reward
              </span>
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--terminal)]">
                <span className="w-1 h-1 rounded-full bg-[var(--terminal)]" />
                preview
              </span>
            </div>
            <div className="p-4 grid grid-cols-6 gap-1">
              {["var(--heat-low)", "var(--heat-low)", "var(--heat-mid)", "var(--heat-low)", "var(--heat-low)", "var(--heat-low)", "var(--heat-mid)", "var(--heat-mid)", "var(--heat-high)", "var(--heat-mid)", "var(--heat-low)", "var(--heat-low)", "var(--heat-low)", "var(--heat-high)", "var(--heat-high)", "var(--heat-mid)", "var(--heat-low)", "var(--heat-low)", "var(--heat-low)", "var(--heat-mid)", "var(--heat-low)", "var(--heat-low)", "var(--heat-low)", "var(--heat-low)"].map((color, i) => <div key={i} className="aspect-square rounded-sm" style={{
          background: color,
          opacity: 0.85
        }} aria-hidden />)}
            </div>
          </div>} title="No heatmap data loaded" description="Load the heatmap to see where the pipeline spends time and where reward is dropping." size="lg" action={<button onClick={onRefresh} className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors">
            <Zap className="w-4 h-4" />
            Load Heatmap
          </button>} />;
  }
  const bucketMap = new Map<string, number>();
  data?.buckets.forEach(b => {
    bucketMap.set(`${b.x}|${b.y}`, b.value);
  });
  const minVal = data?.min_value ?? 0;
  const maxVal = data?.max_value ?? 1;
  const range = Math.max(maxVal - minVal, 0.001);
  function getColor(value: number): string {
    const ratio = (value - minVal) / range;
    if (ratio < 0.33) return `rgba(var(--heat-low), ${0.15 + ratio * 1.5})`;
    if (ratio < 0.66) return `rgba(var(--heat-mid), ${0.2 + (ratio - 0.33) * 1.5})`;
    return `rgba(var(--heat-high), ${0.25 + (ratio - 0.66) * 2})`;
  }
  return <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <select value={metric} onChange={e => onMetricChange(e.target.value)} className="px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]">
            {METRICS.map(m => <option key={m} value={m}>
                {m}
              </option>)}
          </select>
          <button onClick={onRefresh} disabled={loading} className="inline-flex items-center gap-2 px-3 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Refresh
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="w-3 h-3 rounded" style={{
          background: "rgba(var(--heat-low), 0.4)"
        }} />
          Low
          <span className="w-3 h-3 rounded" style={{
          background: "rgba(var(--heat-mid), 0.5)"
        }} />
          Mid
          <span className="w-3 h-3 rounded" style={{
          background: "rgba(var(--heat-high), 0.6)"
        }} />
          High
        </div>
      </div>

      {loading ? <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div> : data ? <Card padding="md" className="overflow-x-auto">
          <div className="min-w-[500px]">
            <div className="flex">
              <div className="w-16 flex-shrink-0" />
              <div className="flex-1 grid" style={{
            gridTemplateColumns: `repeat(${data.x_labels.length}, minmax(60px, 1fr))`
          }}>
                {data.x_labels.map(label => <div key={label} className="text-[10px] text-[var(--text-muted)] text-center pb-1 truncate px-0.5">
                    {label}
                  </div>)}
              </div>
            </div>
            <div className="space-y-0.5">
              {data.y_labels.map(yLabel => <div key={yLabel} className="flex items-center">
                  <div className="w-16 text-[10px] text-[var(--text-muted)] text-right pr-2 flex-shrink-0">
                    {yLabel}
                  </div>
                  <div className="flex-1 grid gap-0.5" style={{
              gridTemplateColumns: `repeat(${data.x_labels.length}, minmax(60px, 1fr))`
            }}>
                    {data.x_labels.map(xLabel => {
                const value = bucketMap.get(`${xLabel}|${yLabel}`) ?? 0;
                return <div key={`${xLabel}-${yLabel}`} className={cn("h-8 rounded flex items-center justify-center text-[9px] font-medium text-[var(--text-secondary)]")} style={{
                  backgroundColor: getColor(value)
                }} title={`${xLabel} @ ${yLabel}: ${value.toFixed(2)}`}>
                          {value > 0 ? value.toFixed(0) : ""}
                        </div>;
              })}
                  </div>
                </div>)}
            </div>
          </div>
        </Card> : null}
    </div>;
}