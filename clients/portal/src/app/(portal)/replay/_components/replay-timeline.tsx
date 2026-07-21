"use client";

import {
  Activity,
  CheckCircle2,
  Clock,
  History,
  Layers,
  Loader2,
  Play,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { cn } from "@/lib/utils";
import {
  formatDuration,
  getEventTypeColor,
  type TraceSummary,
} from "./replay-types";

export function ReplayTimeline({
  loadingTrace,
  traceError,
  traceSummary,
  typeDistribution,
  totalEvents,
  onRetry,
}: {
  loadingTrace: boolean;
  traceError: string | null;
  traceSummary: TraceSummary | null;
  typeDistribution: Record<string, number>;
  totalEvents: number;
  onRetry: () => void;
}) {
  if (loadingTrace) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <Loader2 className="w-6 h-6 text-[var(--text-muted)] animate-spin" />
        <p className="text-sm text-[var(--text-muted)]">Loading trace…</p>
      </div>
    );
  }
  if (traceError) {
    return (
      <ErrorState
        title="Couldn't load trace"
        message={traceError}
        size="sm"
        action={
          <Button
            variant="link"
            size="sm"
            className="min-h-11 px-0"
            onClick={onRetry}
          >
            Try again
          </Button>
        }
      />
    );
  }
  if (!traceSummary) {
    return (
      <EmptyState
        icon={History}
        title="No trace data for this job"
        description="Traces are generated during pipeline execution. Run a job to see its decision trace here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]"
        data-testid="replay-metric-strip"
      >
        <span className="inline-flex items-center gap-1">
          <Layers className="h-3 w-3" aria-hidden />
          <span className="font-mono tabular-nums text-[var(--text-primary)]">
            {traceSummary.event_count}
          </span>{" "}
          events
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3 w-3" aria-hidden />
          <span className="font-mono tabular-nums text-[var(--text-primary)]">
            {formatDuration(traceSummary.duration_ms)}
          </span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Play className="h-3 w-3" aria-hidden />
          {traceSummary.started_at
            ? new Date(traceSummary.started_at).toLocaleTimeString()
            : "—"}
        </span>
        <span className="inline-flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" aria-hidden />
          {traceSummary.ended_at
            ? new Date(traceSummary.ended_at).toLocaleTimeString()
            : "—"}
        </span>
      </div>

      <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
          <Activity className="w-4 h-4 text-[var(--accent)]" />
          Event Type Distribution
        </h3>
        {Object.keys(typeDistribution).length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No event distribution"
            description="This trace has no events to aggregate. Check that the pipeline ran to completion."
            size="sm"
          />
        ) : (
          <div className="space-y-2">
            {Object.entries(typeDistribution)
              .sort(([, a], [, b]) => b - a)
              .map(([type, count]) => {
                const pct =
                  totalEvents > 0
                    ? Math.round((count / totalEvents) * 100)
                    : 0;
                const colors = getEventTypeColor(type);
                return (
                  <div key={type} className="flex items-center gap-3">
                    <span
                      className={cn(
                        "text-xs font-medium w-24 truncate",
                        colors.text,
                      )}
                    >
                      {type}
                    </span>
                    <div className="flex-1 h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          colors.bg.replace("/10", ""),
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-[var(--text-muted)] w-12 text-right">
                      {count}
                    </span>
                    <span className="text-xs text-[var(--text-muted)] w-8 text-right">
                      {pct}%
                    </span>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          aria-label="Refresh trace"
          className="min-h-11"
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden />
          Refresh
        </Button>
      </div>
    </div>
  );
}
