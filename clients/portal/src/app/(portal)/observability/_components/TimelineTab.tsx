"use client";

/**
 * TimelineTab — extracted from observability/page.tsx (June 2026).
 * Renders the horizontal timeline of a single trace's steps.
 */
import { ArrowRight, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TimelineData } from "../_lib/types";
import { Card } from "@/components/ui/card";
export function TimelineTab({
  timeline,
  selectedTraceId,
  onBack
}: {
  timeline: TimelineData | null;
  selectedTraceId: string;
  onBack: () => void;
}) {
  if (!timeline) {
    return <Card padding="lg" className="text-center py-16">
        <Clock className="w-12 h-12 mx-auto mb-3 text-[var(--text-muted)] opacity-40" />
        <p className="text-sm text-[var(--text-muted)]">Select a trace to view its timeline</p>
        <button onClick={onBack} className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors">
          <ArrowRight className="w-4 h-4" />
          Go to Traces
        </button>
      </Card>;
  }
  const totalMs = timeline.total_duration_ms || 1;
  return <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Clock className="w-4 h-4 text-[var(--accent)]" />
            Step Timeline
          </h3>
          <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{selectedTraceId}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs text-[var(--text-muted)]">{timeline.steps.length} steps</p>
            <p className="text-xs text-[var(--text-muted)]">{totalMs.toFixed(0)}ms total</p>
          </div>
          <button onClick={onBack} className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors">
            Back
          </button>
        </div>
      </div>

      <Card padding="md" className="space-y-3">
        {timeline.steps.map((step, idx) => {
        const leftPct = step.start_ms / totalMs * 100;
        const widthPct = Math.max(step.duration_ms / totalMs * 100, 0.5);
        return <div key={idx} className="relative">
              <div className="flex items-center gap-3 mb-1">
                <span className="text-xs text-[var(--text-muted)] w-8 text-right">{idx + 1}</span>
                <span className="text-sm font-medium text-[var(--text-primary)]">{step.name}</span>
                <span className="text-xs text-[var(--text-muted)] ml-auto">
                  {step.duration_ms.toFixed(1)}ms
                </span>
              </div>
              <div className="relative h-6 bg-[var(--bg-tertiary)] rounded-full overflow-hidden ml-11">
                <div className={cn("absolute h-full rounded-full transition-all", step.outcome === "success" && "bg-[var(--terminal)]/80", step.outcome === "failure" && "bg-[var(--error)]/80", step.outcome === "partial" && "bg-[var(--warning)]/80", step.outcome !== "success" && step.outcome !== "failure" && step.outcome !== "partial" && "bg-[var(--accent)]/60")} style={{
              left: `${leftPct}%`,
              width: `${widthPct}%`
            }} />
              </div>
            </div>;
      })}

        {timeline.markers.length > 0 && <div className="mt-6 pt-4 border-t border-[var(--border-default)]">
            <h4 className="text-xs font-semibold text-[var(--text-muted)] mb-3">Markers</h4>
            <div className="space-y-2">
              {timeline.markers.map((marker, idx) => <div key={idx} className="flex items-center gap-3 p-2 rounded-lg bg-[var(--bg-secondary)]">
                  <span className={cn("w-2 h-2 rounded-full flex-shrink-0", marker.severity === "high" ? "bg-[var(--error)]" : "bg-[var(--warning)]")} />
                  <span className="text-xs text-[var(--text-muted)] w-16">
                    {marker.at_ms.toFixed(0)}ms
                  </span>
                  <span className="text-sm text-[var(--text-primary)]">{marker.label}</span>
                </div>)}
            </div>
          </div>}
      </Card>
    </div>;
}