"use client";

/**
 * TracesTab — the trace list surface for /traces.
 *
 * Wave 3 column defaults (Laminar scan):
 * Status 40 · id · type · time · duration · cost · tokens
 * Optional Display cols: agent · spans · streaming · actions
 */
import { TreePine, Clock, PlayCircle, Download, Layers, Tag } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { SkeletonTableRow } from "@/components/ui/skeleton";
import type { DataTableColumn, DataTableBulkAction } from "@/components/ui/data-table";
import { InfiniteDataTable } from "@/components/portal-os";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import type { TraceFilter, TraceItem } from "../_lib/types";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Laminar status strip width (px) — Wave 2–3 numeric contract. */
export const TRACES_STATUS_COL_PX = 40;

/** Optional columns controlled by Display — never a third chrome band. */
export const TRACES_OPTIONAL_COLUMNS = [
  { id: "agent", label: "Agent" },
  { id: "spans", label: "Spans" },
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
  { id: "streaming_metrics", label: "Streaming" },
  { id: "actions", label: "Actions" },
] as const;

export type TracesOptionalColumnId =
  (typeof TRACES_OPTIONAL_COLUMNS)[number]["id"];

/** Default visible optional cols — core scan cols are always on. */
export const TRACES_DEFAULT_VISIBLE_OPTIONAL: TracesOptionalColumnId[] = [];

/** Core Wave 3 default column keys (always rendered). */
export const TRACES_CORE_COLUMNS = [
  "status",
  "id",
  "type",
  "time",
  "duration",
  "cost",
  "tokens",
] as const;

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

function typeLabel(t: TraceItem): string {
  const model = t.model?.trim();
  if (model) return model;
  const realm = t.realm?.trim();
  if (realm) return realm;
  return "trace";
}

const PREVIEW_MAX = 80;

function truncatePreview(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const text = String(raw).replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= PREVIEW_MAX) return text;
  return `${text.slice(0, PREVIEW_MAX)}…`;
}

/** Prefer list I/O fields; fall back to name/preview/error when present. */
function inputPreview(t: TraceItem): string {
  return (
    truncatePreview(t.input_text) ??
    truncatePreview(t.input) ??
    truncatePreview(t.preview) ??
    truncatePreview(t.name) ??
    "—"
  );
}

function outputPreview(t: TraceItem): string {
  return (
    truncatePreview(t.output_text) ??
    truncatePreview(t.output) ??
    truncatePreview(t.error) ??
    "—"
  );
}

function StatusStrip({ outcome }: { outcome: string | null }) {
  const color =
    outcome === "success"
      ? "bg-[var(--success)]"
      : outcome === "failure" || outcome === "crash"
        ? "bg-[var(--error)]"
        : outcome === "partial" || outcome === "timeout"
          ? "bg-[var(--warning)]"
          : "bg-[var(--text-muted)]";
  return (
    <div
      className="flex h-full w-10 items-center justify-center"
      data-testid="trace-status-strip"
      data-status-col-px={TRACES_STATUS_COL_PX}
      role="status"
      aria-label={outcome ? `Outcome: ${outcome}` : "Outcome: unknown"}
    >
      <span className={cn("h-8 w-1 rounded-full", color)} aria-hidden />
    </div>
  );
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

  const columns: DataTableColumn<TraceItem>[] = useMemo(() => {
    const visible = new Set(visibleColumns);
    const cols: DataTableColumn<TraceItem>[] = [
      {
        key: "outcome",
        header: "",
        sortable: true,
        sticky: true,
        className: "w-10 max-w-10 px-0",
        headerClassName: "w-10 max-w-10 px-0",
        cell: (t) => <StatusStrip outcome={t.outcome} />,
      },
      {
        key: "trace_id",
        header: "Id",
        sortable: true,
        cell: (t) => (
          <span className="font-mono text-xs text-[var(--text-primary)]">
            {t.trace_id.slice(0, 12)}…
          </span>
        ),
      },
      {
        key: "model",
        header: "Type",
        sortable: true,
        cell: (t) => (
          <span className="block max-w-[140px] truncate text-xs text-[var(--text-secondary)]">
            {typeLabel(t)}
          </span>
        ),
      },
      {
        key: "started_at",
        header: "Time",
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
        key: "cost_cents",
        header: "Cost",
        sortable: true,
        align: "right",
        cell: (t) => (
          <span className="font-mono text-[var(--text-primary)] tabular-nums font-medium">
            {formatCostUSD(t.cost_cents)}
          </span>
        ),
      },
      {
        key: "input_tokens",
        header: "Tokens",
        sortable: true,
        align: "right",
        cell: (t) => (
          <span
            className="font-mono text-[var(--text-secondary)] tabular-nums"
            title={
              t.input_tokens != null || t.output_tokens != null
                ? `${formatTokens(t.input_tokens)} in → ${formatTokens(t.output_tokens)} out`
                : undefined
            }
          >
            {t.input_tokens != null || t.output_tokens != null
              ? `${formatTokens(t.input_tokens)}→${formatTokens(t.output_tokens)}`
              : "—"}
          </span>
        ),
      },
    ];

    if (visible.has("agent")) {
      cols.splice(2, 0, {
        key: "agent_id",
        header: "Agent",
        sortable: true,
        cell: (t) => (
          <span className="block max-w-[160px] truncate text-xs text-[var(--text-secondary)]">
            {t.agent_id?.trim() || "—"}
          </span>
        ),
      });
    }

    if (visible.has("spans")) {
      cols.push({
        key: "span_count",
        header: "Spans",
        sortable: true,
        align: "right",
        cell: (t) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {t.span_count}
          </span>
        ),
      });
    }

    if (visible.has("input")) {
      cols.push({
        key: "input",
        header: "Input",
        cell: (t) => {
          const text = inputPreview(t);
          return (
            <span
              className="block max-w-[12rem] truncate text-xs text-[var(--text-muted)]"
              title={text === "—" ? undefined : text}
              data-testid="trace-input-preview"
            >
              {text}
            </span>
          );
        },
      });
    }

    if (visible.has("output")) {
      cols.push({
        key: "output",
        header: "Output",
        cell: (t) => {
          const text = outputPreview(t);
          return (
            <span
              className="block max-w-[12rem] truncate text-xs text-[var(--text-muted)]"
              title={text === "—" ? undefined : text}
              data-testid="trace-output-preview"
            >
              {text}
            </span>
          );
        },
      });
    }

    if (visible.has("streaming_metrics")) {
      cols.push({
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
      });
    }

    if (visible.has("actions")) {
      cols.push({
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
      });
    }

    return cols;
  }, [
    visibleKey,
    visibleColumns,
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
              columns={["w-10", "w-24", "w-20", "w-16", "w-16", "w-14", "w-20"]}
            />
          ))}
        </Card>
      ) : (
        <>
          {/* Wave 11.8 — mobile cards, not shrunk tables */}
          <ul
            className="flex flex-col gap-space-2 md:hidden m-0 p-0 list-none"
            data-wave11-mobile="cards"
            aria-label="Traces"
          >
            {traces.map((t) => (
              <li key={t.trace_id}>
                <button
                  type="button"
                  onClick={() => onSelectTrace(t.trace_id)}
                  className={cn(
                    "w-full text-left rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]",
                    "px-space-3 py-space-3 min-h-11 hover:bg-[var(--bg-tertiary)]/50 transition-colors",
                    initialTraceId === t.trace_id && "ring-1 ring-[var(--accent)]",
                  )}
                >
                  <div className="flex items-start justify-between gap-space-2">
                    <div className="min-w-0 flex flex-col gap-0.5">
                      <span className="font-mono text-xs text-[var(--text-primary)] truncate">
                        {t.trace_id.slice(0, 12)}…
                      </span>
                      <span className="text-xs text-[var(--text-muted)] truncate">
                        {typeLabel(t)}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 text-2xs font-medium uppercase tracking-wide",
                        t.outcome === "failure" || t.outcome === "crash"
                          ? "text-[var(--error)]"
                          : "text-[var(--text-muted)]",
                      )}
                    >
                      {t.outcome ?? "ok"}
                    </span>
                  </div>
                  <div className="mt-space-2 flex flex-wrap gap-space-3 text-xs text-[var(--text-muted)]">
                    <span>{formatRelativeTime(t.started_at)}</span>
                    <span>{formatDurationMs(t.duration_ms)}</span>
                    <span>{formatCostUSD(t.cost_cents)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
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
          </div>
        </>
      )}
    </div>
  );
}
