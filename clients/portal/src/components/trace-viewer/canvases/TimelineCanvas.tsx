"use client";

import { TraceTimelineView } from "@/components/traces/trace-detail-views";
import type { TimelineStep } from "@/lib/observability/timeline-sync";

export interface TimelineCanvasProps {
  loading: boolean;
  error: string | null;
  steps: TimelineStep[];
  totalMs: number;
  markers: Array<{ at_ms: number; label: string; severity: string }>;
  selectedSpanId: string | null;
  onSpanSelect: (spanId: string) => void;
}

/** Full Gantt — reuses timeline-sync math via TraceTimelineView. */
export function TimelineCanvas({
  loading,
  error,
  steps,
  totalMs,
  markers,
  selectedSpanId,
  onSpanSelect,
}: TimelineCanvasProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="timeline-canvas">
      <TraceTimelineView
        loading={loading}
        error={error}
        steps={steps}
        totalMs={totalMs}
        markers={markers}
        selectedSpanId={selectedSpanId}
        onSpanSelect={onSpanSelect}
        variant="full"
      />
    </div>
  );
}
