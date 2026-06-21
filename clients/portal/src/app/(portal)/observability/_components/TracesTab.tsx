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

import { Filter, Loader2, TreePine, Clock, PlayCircle, Download, Layers } from "lucide-react";
import Link from "next/link";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
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
  const columns: DataTableColumn<TraceItem>[] = [
    {
      key: "trace_id",
      header: "Trace ID",
      sortable: true,
      sticky: true,
      cell: (t) => (
        <span className="font-mono text-xs text-[var(--text-primary)]">
          {t.trace_id.slice(0, 16)}…
        </span>
      ),
    },
    {
      key: "realm",
      header: "Realm",
      sortable: true,
      cell: (t) => (
        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--accent-faint)] text-[var(--accent)]">
          {t.realm}
        </span>
      ),
    },
    {
      key: "outcome",
      header: "Outcome",
      sortable: true,
      cell: (t) => <TraceOutcomeBadge outcome={t.outcome} />,
    },
    {
      key: "span_count",
      header: "Spans",
      sortable: true,
      align: "right",
      cell: (t) => <span className="text-[var(--text-secondary)]">{t.span_count}</span>,
    },
    {
      key: "duration_ms",
      header: "Duration",
      sortable: true,
      align: "right",
      cell: (t) => <span className="text-[var(--text-secondary)]">{t.duration_ms.toFixed(0)}ms</span>,
    },
    {
      key: "streaming_metrics",
      header: "Streaming",
      cell: (t) =>
        t.streaming_metrics ? (
          <div className="flex flex-col gap-0.5 text-[var(--text-muted)] text-xs">
            <span>TTFT {t.streaming_metrics.ttft_ms?.toFixed(0)}ms</span>
            <span>ITL {t.streaming_metrics.itl_ms_avg?.toFixed(1)}ms</span>
            <span>TPOT {t.streaming_metrics.tpot_ms?.toFixed(1)}ms</span>
          </div>
        ) : (
          <span className="text-[var(--text-muted)] text-xs">—</span>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      cell: (t) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSelectTrace(t.trace_id);
            }}
            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
            title="View Trace Tree"
            aria-label="View Trace Tree"
          >
            <TreePine className="w-4 h-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onViewTimeline(t.trace_id);
            }}
            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
            title="View Timeline"
            aria-label="View Timeline"
          >
            <Clock className="w-4 h-4" />
          </button>
          {showReplayLink && (
            <Link
              href={`/replay?trace_id=${t.trace_id}`}
              onClick={(e) => e.stopPropagation()}
              className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
              title="Open in Replay"
              aria-label="Open in Replay"
            >
              <PlayCircle className="w-4 h-4" />
            </Link>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onExport(t.trace_id);
            }}
            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
            title="Export"
            aria-label="Export"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      ),
    },
  ];

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
      ) : (
        <DataTable
          columns={columns}
          rows={traces}
          rowKey={(t) => t.trace_id}
          loading={loading && traces.length > 0}
          defaultSort={{ key: "duration_ms", direction: "desc" }}
          emptyTitle="No traces found"
          emptyDescription="Send telemetry from the Eden SDK or run a job — traces will appear here as your agents run."
          emptyIcon={Layers}
          onRowClick={(t) => onSelectTrace(t.trace_id)}
          rowAttrs={(t) => ({ "data-trace-id": t.trace_id })}
          highlightRowId={initialTraceId}
          pageSize={25}
        />
      )}
    </div>
  );
}
