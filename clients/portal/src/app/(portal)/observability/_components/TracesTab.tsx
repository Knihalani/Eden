"use client";

/**
 * TracesTab — the trace list surface, extracted from
 * observability/page.tsx (June 2026 UI overhaul).
 *
 * Used by:
 *   • /traces (standalone page)
 *   • /observability (legacy tab; will be removed once /observability
 *     becomes an 8-card landing pointing to the per-sub-route pages)
 *
 * Pure presentational: the parent owns traces/loading/filter state and
 * provides the four callbacks. We also accept `initialTraceId` so a
 * deep link like `/traces?trace_id=abc-123` can pre-select a row.
 */

import { Filter, Loader2, TreePine, Clock, PlayCircle, Download } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { OutcomeBadge } from "@/components/ui/outcome-badge";
import { cn } from "@/lib/utils";
import type { TraceFilter, TraceItem } from "../_lib/types";

interface TracesTabProps {
  traces: TraceItem[];
  loading: boolean;
  filter: TraceFilter;
  onFilterChange: (f: TraceFilter) => void;
  onSelectTrace: (id: string) => void;
  onViewTimeline: (id: string) => void;
  onExport: (id: string) => void;
  /** Pre-select this trace on first mount (for `?trace_id=` deep links). */
  initialTraceId?: string;
  /** Show the "Open in Replay" deep link. Defaults to true. */
  showReplayLink?: boolean;
}

const OUTCOMES = ["success", "failure", "partial", "timeout", "crash"] as const;

export function TracesTab({
  traces,
  loading,
  filter,
  onFilterChange,
  onSelectTrace,
  onViewTimeline,
  onExport,
  initialTraceId,
  showReplayLink = true,
}: TracesTabProps) {
  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-3">
        <Filter className="w-4 h-4 text-[var(--text-muted)]" />
        <select
          value={filter.realm}
          onChange={(e) => onFilterChange({ ...filter, realm: e.target.value })}
          className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
        >
          <option value="">All Realms</option>
          <option value="environment">Environment</option>
          <option value="production">Production</option>
        </select>
        <select
          value={filter.outcome}
          onChange={(e) => onFilterChange({ ...filter, outcome: e.target.value })}
          className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
        >
          <option value="">All Outcomes</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o.charAt(0).toUpperCase() + o.slice(1)}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Agent ID..."
          value={filter.agent_id}
          onChange={(e) => onFilterChange({ ...filter, agent_id: e.target.value })}
          className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
      </div>

      {loading && traces.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : traces.length === 0 ? (
        <EmptyState
          icon={Loader2}
          title="No traces found"
          description="Send telemetry from the Eden SDK or run a job — traces will appear here as your agents run."
          size="lg"
        />
      ) : (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide sticky left-0 bg-[var(--bg-secondary)]">
                    Trace ID
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Realm</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Outcome</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Spans</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Duration</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Streaming</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {traces.map((trace) => {
                  const isSelected = initialTraceId === trace.trace_id;
                  return (
                    <tr
                      key={trace.trace_id}
                      data-trace-id={trace.trace_id}
                      className={cn(
                        "transition-colors",
                        isSelected
                          ? "bg-[var(--accent-faint)] hover:bg-[var(--accent-faint)]"
                          : "hover:bg-[var(--bg-tertiary)]/50"
                      )}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-[var(--text-primary)] sticky left-0 bg-[var(--bg-primary)]">
                        {trace.trace_id.slice(0, 16)}…
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--accent-faint)] text-[var(--accent)]">
                          {trace.realm}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <OutcomeBadge outcome={trace.outcome} />
                      </td>
                      <td className="px-4 py-3 text-[var(--text-secondary)]">{trace.span_count}</td>
                      <td className="px-4 py-3 text-[var(--text-secondary)]">{trace.duration_ms.toFixed(0)}ms</td>
                      <td className="px-4 py-3 text-[var(--text-muted)] text-xs">
                        {trace.streaming_metrics ? (
                          <div className="flex flex-col gap-0.5">
                            <span>TTFT {trace.streaming_metrics.ttft_ms?.toFixed(0)}ms</span>
                            <span>ITL {trace.streaming_metrics.itl_ms_avg?.toFixed(1)}ms</span>
                            <span>TPOT {trace.streaming_metrics.tpot_ms?.toFixed(1)}ms</span>
                          </div>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => onSelectTrace(trace.trace_id)}
                            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
                            title="View Trace Tree"
                            aria-label="View Trace Tree"
                          >
                            <TreePine className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => onViewTimeline(trace.trace_id)}
                            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
                            title="View Timeline"
                            aria-label="View Timeline"
                          >
                            <Clock className="w-4 h-4" />
                          </button>
                          {showReplayLink && (
                            <Link
                              href={`/replay?trace_id=${trace.trace_id}`}
                              className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
                              title="Open in Replay"
                              aria-label="Open in Replay"
                            >
                              <PlayCircle className="w-4 h-4" />
                            </Link>
                          )}
                          <button
                            onClick={() => onExport(trace.trace_id)}
                            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
                            title="Export"
                            aria-label="Export"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
