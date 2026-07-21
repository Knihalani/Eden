"use client";

import {
  ChevronDown,
  ChevronUp,
  Layers,
  Loader2,
  Zap,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { cn } from "@/lib/utils";
import {
  formatTimestamp,
  getEventTypeColor,
  type TraceEventItem,
} from "./replay-types";

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex-shrink-0">
        {label}
      </span>
      <span className="text-xs text-[var(--text-secondary)] font-mono truncate">
        {value}
      </span>
    </div>
  );
}

export function ReplayEvents({
  loadingTrace,
  traceError,
  traceEvents,
  expandedEvent,
  onExpand,
  onRetry,
  listRef,
}: {
  loadingTrace: boolean;
  traceError: string | null;
  traceEvents: TraceEventItem[];
  expandedEvent: string | null;
  onExpand: (id: string | null) => void;
  onRetry: () => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={listRef} className="space-y-2">
      {loadingTrace ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Loader2 className="w-6 h-6 text-[var(--text-muted)] animate-spin" />
          <p className="text-sm text-[var(--text-muted)]">Loading events…</p>
        </div>
      ) : traceError ? (
        <ErrorState
          title="Couldn't load trace"
          message={traceError}
          size="sm"
          action={
            <button
              type="button"
              onClick={onRetry}
              className="text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
            >
              Try again
            </button>
          }
        />
      ) : traceEvents.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No events"
          description="Select a job with trace data to view its events."
        />
      ) : (
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {traceEvents.map((event) => {
            const colors = getEventTypeColor(event.event_type);
            const isExpanded = expandedEvent === event.event_id;
            return (
              <div
                key={event.event_id}
                className={cn(
                  "rounded-lg border transition-all bg-[var(--bg-primary)]",
                  isExpanded
                    ? "border-[var(--border-strong)]"
                    : "border-[var(--border-default)] hover:border-[var(--border-strong)]",
                )}
              >
                <button
                  className="w-full flex items-start gap-3 p-3 text-left"
                  onClick={() =>
                    onExpand(isExpanded ? null : event.event_id)
                  }
                >
                  <div
                    className={cn(
                      "p-1.5 rounded-md flex-shrink-0 mt-0.5",
                      colors.bg,
                    )}
                  >
                    <Zap className={cn("w-3.5 h-3.5", colors.text)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={cn("text-xs font-semibold", colors.text)}
                      >
                        {event.event_type}
                      </span>
                      <span className="text-[10px] text-[var(--text-muted)] font-mono">
                        seq {event.sequence}
                      </span>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {formatTimestamp(event.timestamp)}
                      </span>
                      {event.priority !== "normal" && (
                        <span
                          className={cn(
                            "text-[10px] px-1 rounded font-medium uppercase",
                            event.priority === "high"
                              ? "bg-[var(--error)]/10 text-[var(--error)]"
                              : "bg-[var(--warning)]/10 text-[var(--warning)]",
                          )}
                        >
                          {event.priority}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
                      {event.entity_id.slice(0, 24)}…
                    </p>
                  </div>
                  <div className="flex-shrink-0 mt-1">
                    {isExpanded ? (
                      <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="overflow-hidden">
                    <div className="px-3 pb-3 pt-0 border-t border-[var(--border-default)]">
                      <div className="pt-3 space-y-2">
                        <DetailRow label="Event ID" value={event.event_id} />
                        <DetailRow
                          label="Sequence"
                          value={String(event.sequence)}
                        />
                        <DetailRow label="Timestamp" value={event.timestamp} />
                        <DetailRow label="Tenant" value={event.tenant_id} />
                        <DetailRow label="User" value={event.user_id} />
                        <DetailRow label="Entity" value={event.entity_id} />
                        <DetailRow label="Version" value={event.version} />
                        <div className="mt-2">
                          <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider block mb-1">
                            Payload
                          </span>
                          <pre className="text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)] rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap break-all">
                            {JSON.stringify(event.payload, null, 2)}
                          </pre>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
