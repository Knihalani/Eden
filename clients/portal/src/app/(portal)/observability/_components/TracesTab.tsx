"use client";

/**
 * TracesTab — the trace list surface for /traces.
 *
 * Wave 6: filters live in the hub QueryFilterBar (≤2 chrome bands).
 * This component is table-only: sort, selection, and Display-driven columns.
 */
import { TreePine, Clock, PlayCircle, Download, Layers, Tag } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { SkeletonTableRow } from "@/components/ui/skeleton";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import type { DataTableColumn, DataTableBulkAction } from "@/components/ui/data-table";
import { InfiniteDataTable } from "@/components/portal-os";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import type { TraceFilter, TraceItem } from "../_lib/types";
import { Card } from "@/components/ui/card";

/** Optional columns controlled by Display — never a third chrome band. */
export const TRACES_OPTIONAL_COLUMNS = [
  { id: "streaming_metrics", label: "Streaming" },
  { id: "input_tokens", label: "In tok" },
  { id: "output_tokens", label: "Out tok" },
  { id: "cost_cents", label: "Cost" },
] as const;

export type TracesOptionalColumnId =
  (typeof TRACES_OPTIONAL_COLUMNS)[number]["id"];

/** Default visible optional cols — streaming stays hidden until Display. */
export const TRACES_DEFAULT_VISIBLE_OPTIONAL: TracesOptionalColumnId[] = [
  "input_tokens",
  "output_tokens",
  "cost_cents",
];

interface TracesTabProps {
  traces: TraceItem[];
  loading: boolean;
  /** Kept for parent filter identity; filters render in hub toolbar. */
  filter: TraceFilter;
  onFilterChange?: (f: TraceFilter) => void;
  onSelectTrace: (id: string) => void;
  onViewTimeline: (id: string) => void;
  /** Open detail panel on the Tree tab. */
  onViewTree?: (id: string) => void;
  onExport: (id: string) => void;
  /** Pre-select this trace on first mount (for `?traceId=` deep links). */
  initialTraceId?: string;
  /** Show the "Open in Replay" deep link. Defaults to true. */
  showReplayLink?: boolean;
  onAnnotate?: (id: string) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  /** Visible optional column ids (Display menu / saved views). */
  visibleColumns?: string[];
  onSortChange?: (
    sort: { key: string; direction: "asc" | "desc" } | null,
  ) => void;
  defaultSort?: { key: string; direction: "asc" | "desc" };
  selectable?: boolean;
  bulkActions?: DataTableBulkAction<TraceItem>[];
}

function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
function formatCostUSD(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const dollars = cents / 100;
  if (dollars === 0) return "$0.00";
  if (dollars < 0.01) return "<$0.01";
  return `$${dollars.toFixed(2)}`;
}
function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return `${ms.toFixed(0)}ms`;
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const delta = Date.now() - t;
  const sec = Math.round(delta / 1000);
  if (sec < 60) return `${Math.max(0, sec)}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function identityLabel(t: TraceItem): string {
  const agent = t.agent_id?.trim();
  if (agent) return agent;
  const model = t.model?.trim();
  if (model) return model;
  return t.trace_id.slice(0, 12);
}

export function TracesTab({
  traces,
  loading,
  onSelectTrace,
  onViewTimeline,
  onViewTree,
  onExport,
  initialTraceId,
  showReplayLink = true,
  onAnnotate,
  hasMore,
  onLoadMore,
  loadingMore,
  visibleColumns = TRACES_DEFAULT_VISIBLE_OPTIONAL,
  onSortChange,
  defaultSort = { key: "started_at", direction: "desc" },
  selectable = true,
  bulkActions,
}: TracesTabProps) {
  const visibleKey = visibleColumns.join("\0");
  const showTokenCostCols = traces.some(
    (t) =>
      t.input_tokens != null || t.output_tokens != null || t.cost_cents != null,
  );

  // Stable column identity — avoids InfiniteDataTable/DataTable re-sorting
  // and header remounts on every parent re-render (W12 table perf).
  const columns: DataTableColumn<TraceItem>[] = useMemo(() => {
    const visible = new Set(visibleColumns);
    return [
    {
      key: "agent_id",
      header: "Agent",
      sortable: true,
      sticky: true,
      cell: (t) => (
        <div className="min-w-0 max-w-[220px]">
          <div className="truncate text-sm font-medium text-[var(--text-primary)]">
            {identityLabel(t)}
          </div>
          <div className="truncate font-mono text-2xs text-[var(--text-muted)]">
            {t.trace_id.slice(0, 16)}…
          </div>
        </div>
      ),
    },
    {
      key: "started_at",
      header: "When",
      sortable: true,
      cell: (t) => (
        <span
          className="text-xs text-[var(--text-secondary)] tabular-nums"
          title={t.started_at ?? undefined}
        >
          {formatRelativeTime(t.started_at)}
        </span>
      ),
    },
    {
      key: "model",
      header: "Model",
      sortable: true,
      cell: (t) => (
        <span className="block max-w-[140px] truncate text-xs text-[var(--text-secondary)]">
          {t.model?.trim() || "—"}
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
      key: "duration_ms",
      header: "Duration",
      sortable: true,
      align: "right",
      cell: (t) => (
        <span className="tabular-nums text-[var(--text-secondary)]">
          {formatDurationMs(t.duration_ms)}
        </span>
      ),
    },
    {
      key: "span_count",
      header: "Spans",
      sortable: true,
      align: "right",
      cell: (t) => (
        <span className="tabular-nums text-[var(--text-secondary)]">{t.span_count}</span>
      ),
    },
    ...(showTokenCostCols && visible.has("input_tokens")
      ? [
          {
            key: "input_tokens" as const,
            header: "In tok",
            sortable: true,
            align: "right" as const,
            cell: (t: TraceItem) => (
              <span className="font-mono text-[var(--text-secondary)] tabular-nums">
                {formatTokens(t.input_tokens)}
              </span>
            ),
          },
        ]
      : []),
    ...(showTokenCostCols && visible.has("output_tokens")
      ? [
          {
            key: "output_tokens" as const,
            header: "Out tok",
            sortable: true,
            align: "right" as const,
            cell: (t: TraceItem) => (
              <span className="font-mono text-[var(--text-secondary)] tabular-nums">
                {formatTokens(t.output_tokens)}
              </span>
            ),
          },
        ]
      : []),
    ...(showTokenCostCols && visible.has("cost_cents")
      ? [
          {
            key: "cost_cents" as const,
            header: "Cost",
            sortable: true,
            align: "right" as const,
            cell: (t: TraceItem) => (
              <span className="font-mono text-[var(--text-primary)] tabular-nums font-medium">
                {formatCostUSD(t.cost_cents)}
              </span>
            ),
          },
        ]
      : []),
    ...(visible.has("streaming_metrics")
      ? [
          {
            key: "streaming_metrics" as const,
            header: "Streaming",
            cell: (t: TraceItem) =>
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
        ]
      : []),
    {
      key: "actions",
      header: "Actions",
      align: "right",
      cell: (t) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              (onViewTree ?? onSelectTrace)(t.trace_id);
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
          {onAnnotate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAnnotate(t.trace_id);
              }}
              className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
              title="Annotate"
              aria-label="Annotate"
            >
              <Tag className="w-4 h-4" />
            </button>
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
  }, [
    visibleKey,
    visibleColumns,
    showTokenCostCols,
    showReplayLink,
    onSelectTrace,
    onViewTimeline,
    onViewTree,
    onAnnotate,
    onExport,
  ]);

  return (
    <div className="space-y-4" data-testid="traces-table">
      {loading && traces.length === 0 ? (
        <Card
          padding="lg"
          className="overflow-hidden"
          role="status"
          aria-live="polite"
          aria-label="Loading traces"
        >
          <div className="flex items-center gap-4 px-4 py-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <span className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
              Loading traces…
            </span>
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonTableRow
              key={i}
              columns={["w-32", "w-24", "w-20", "w-28", "w-16"]}
            />
          ))}
        </Card>
      ) : (
        <InfiniteDataTable
          columns={columns}
          rows={traces}
          rowKey={(t) => t.trace_id}
          loading={loading && traces.length > 0}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
          loadingMore={loadingMore}
          defaultSort={defaultSort}
          onSortChange={onSortChange}
          selectable={selectable}
          bulkActions={bulkActions}
          emptyTitle="No traces found"
          emptyDescription={U20_EMPTY_COPY.traces}
          emptyIcon={Layers}
          emptyVariant="terminal"
          emptyTerminal={
            <div className="rounded-lg overflow-hidden border border-[var(--border-default)] bg-[var(--bg-base)] text-left shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)]">
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
                <span className="w-2 h-2 rounded-full bg-[var(--traffic-close)]" />
                <span className="w-2 h-2 rounded-full bg-[var(--traffic-minimize)]" />
                <span className="w-2 h-2 rounded-full bg-[var(--traffic-zoom)]" />
                <span className="ml-2 text-2xs font-mono text-[var(--text-muted)] tracking-wider">
                  traces.log
                </span>
                <span className="ml-auto inline-flex items-center gap-1 text-2xs font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  <span className="w-1 h-1 rounded-full bg-[var(--text-muted)]" />
                  waiting
                </span>
              </div>
              <div className="p-4 space-y-1 font-mono text-xs">
                <div className="flex items-center gap-3 text-[var(--text-muted)]">
                  <span>··:··:··</span>
                  <span className="text-[var(--text-secondary)]">trace_id=…</span>
                  <span className="text-[var(--accent)]">agent.start</span>
                  <span className="ml-auto text-[var(--terminal)]">ready</span>
                </div>
                <div className="flex items-center gap-3 text-[var(--text-muted)]">
                  <span>··:··:··</span>
                  <span className="text-[var(--text-secondary)]">trace_id=…</span>
                  <span className="text-[var(--accent)]">tool.call</span>
                  <span className="ml-auto text-[var(--text-muted)]">
                    awaiting ingest
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[var(--text-muted)]">
                  <span>··:··:··</span>
                  <span className="text-[var(--text-secondary)]">trace_id=…</span>
                  <span className="text-[var(--accent)]">agent.finish</span>
                  <span className="ml-auto text-[var(--text-muted)]">
                    awaiting ingest
                  </span>
                </div>
              </div>
            </div>
          }
          onRowClick={(t) => onSelectTrace(t.trace_id)}
          rowAttrs={(t) => ({
            "data-trace-id": t.trace_id,
          })}
          highlightRowId={initialTraceId}
        />
      )}
    </div>
  );
}
