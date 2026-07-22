"use client";

import { useTranslations } from "next-intl";
import { MetricInline } from "@/components/ui/metric-inline";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import { formatLatency } from "@/app/(portal)/traces/_lib/format";
import { cn } from "@/lib/utils";

type TimelineStep = {
  name: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  event_type: string;
  outcome: string | null;
  span_id?: string;
};

type Props = {
  steps: TimelineStep[];
  totalDurationMs: number;
  selectedSpanId?: string;
  onSelectSpan?: (spanId: string) => void;
};

export function TimelineCanvas({
  steps,
  totalDurationMs,
  selectedSpanId,
  onSelectSpan,
}: Props) {
  const t = useTranslations("traces.timeline");
  const total = totalDurationMs > 0 ? totalDurationMs : 1;

  if (steps.length === 0) {
    return (
      <p
        className="px-3 py-6 text-sm text-[var(--text-muted)]"
        data-testid="timeline-canvas-empty"
      >
        {t("empty")}
      </p>
    );
  }

  return (
    <div className="space-y-1 px-3 py-2" data-testid="timeline-canvas" data-mode="timeline">
      {steps.map((step, i) => {
        const left = Math.max(0, (step.start_ms / total) * 100);
        const width = Math.max(1, (step.duration_ms / total) * 100);
        const spanId = step.span_id ?? `step-${i}`;
        const selected = step.span_id === selectedSpanId;
        return (
          <button
            key={spanId}
            type="button"
            data-span-id={step.span_id}
            className={cn(
              "grid w-full grid-cols-[8rem_1fr_5rem] items-center gap-2 rounded px-1 py-1 text-left text-xs",
              "hover:bg-[var(--bg-tertiary)]",
              selected && "bg-[var(--bg-tertiary)]",
            )}
            onClick={() => step.span_id && onSelectSpan?.(step.span_id)}
          >
            <span className="truncate text-[var(--text-primary)]">{step.name}</span>
            <div className="relative h-4 rounded bg-[var(--bg-secondary)]">
              <div
                className="absolute inset-y-0 rounded bg-[var(--terminal)]/40"
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </div>
            <span className="inline-flex items-center justify-end gap-1">
              <MetricInline label="" value={formatLatency(step.duration_ms)} mono />
              <TraceOutcomeBadge outcome={step.outcome} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
