"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ChevronRight, Loader2, ExternalLink, Radio } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { useLiveTraceStream } from "@/hooks/use-live-trace-stream";
import {
  buildSpanTree,
  buildTranscriptRows,
} from "@/lib/observability/build-transcript-rows";
import type { TranscriptRow } from "@/lib/observability/types";
import { VirtualizedTranscript } from "@/components/transcript-v2/VirtualizedTranscript";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorState } from "@/components/ui/error-state";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import { markEden } from "@/lib/perf";
import {
  artifactHref,
  labelingQueueHref,
  playgroundHref,
} from "@/lib/portal-cross-links";
import { useTraceTimeline } from "@/app/(portal)/observability/_lib/use-observability-data";
import { cn } from "@/lib/utils";

const ScoresTab = dynamic(
  () =>
    import("@/app/(portal)/observability/ScoresTab").then((m) => ({
      default: m.ScoresTab,
    })),
  { ssr: false },
);
const LatencyHistogram = dynamic(
  () =>
    import("@/components/observability/LatencyHistogram").then((m) => ({
      default: m.LatencyHistogram,
    })),
  { ssr: false },
);

/** Laminar P0-4: Transcript · Tree · Timeline · Metadata (+ Scores moat). */
export const TRACE_DETAIL_MODE_TABS = [
  { id: "transcript", label: "Transcript" },
  { id: "tree", label: "Tree" },
  { id: "timeline", label: "Timeline" },
  { id: "meta", label: "Metadata" },
  { id: "scores", label: "Scores" },
] as const;

export type DetailMode = (typeof TRACE_DETAIL_MODE_TABS)[number]["id"];

export interface TraceDetailPanelProps {
  traceId: string;
  onClose?: () => void;
  highlightSpanId?: string | null;
  /** When true, hide Esc close (parent DetailPanelShell owns close). */
  hideCloseControl?: boolean;
  /** URL / parent-driven mode; defaults to transcript. */
  initialMode?: DetailMode;
  /** Notify parent when local mode tabs change (e.g. sync `?mode=`). */
  onModeChange?: (mode: DetailMode) => void;
}

export function TraceDetailPanel({
  traceId,
  onClose,
  highlightSpanId,
  hideCloseControl = false,
  initialMode = "transcript",
  onModeChange,
}: TraceDetailPanelProps) {
  const { currentOrg } = useOrg();
  const [phase, setPhase] = useState<"meta" | "ready" | "error">("meta");
  const [mode, setMode] = useState<DetailMode>(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    duration_ms: number;
    span_count: number;
    outcome: string | null;
    model?: string;
    cost_cents?: number | null;
    session_id?: string | null;
    agent_id?: string | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
  } | null>(null);
  const [rows, setRows] = useState<ReturnType<typeof buildTranscriptRows>>([]);
  const [treeRows, setTreeRows] = useState<ReturnType<typeof buildSpanTree>>([]);

  const sessionId = meta?.session_id ?? null;
  const liveStream = useLiveTraceStream({
    orgId: currentOrg?.id,
    sessionId: sessionId ?? traceId,
    enabled: Boolean(currentOrg?.id && (sessionId || phase === "ready")),
  });

  const timelineQuery = useTraceTimeline(
    mode === "timeline" ? currentOrg?.id : undefined,
    mode === "timeline" ? traceId : null,
  );

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode, traceId]);

  useEffect(() => {
    if (!currentOrg || !traceId) return;
    let cancelled = false;
    setPhase("meta");
    setError(null);
    setRows([]);
    setTreeRows([]);
    markEden("eden:panel_open", "trace");

    // K4: fetch meta + tree in parallel (was sequential meta→tree).
    Promise.all([
      api.listObservabilityTraces(currentOrg.id, { trace_id: traceId, limit: 1 }),
      api.getTraceTree(currentOrg.id, traceId),
    ])
      .then(([list, tree]) => {
        if (cancelled) return;
        const trace = list.traces?.[0];
        const roots = Array.isArray(tree?.root_spans) ? tree.root_spans : [];
        // Deep link honesty: 200 + empty list/tree means the id does not exist.
        if (!trace && roots.length === 0) {
          setError("Trace not found");
          setPhase("error");
          return;
        }
        const rootRecords = roots as Array<Record<string, unknown>>;
        setRows(
          buildTranscriptRows(rootRecords, {
            lazyToolPayloads: true,
          }),
        );
        setTreeRows(buildSpanTree(rootRecords));
        setMeta({
          duration_ms: tree?.total_duration_ms ?? trace?.duration_ms ?? 0,
          span_count: tree?.span_count ?? trace?.span_count ?? 0,
          outcome: tree?.outcome ?? trace?.outcome ?? null,
          model: trace?.model ?? undefined,
          cost_cents: trace?.cost_cents ?? null,
          session_id:
            (trace as { agent_session_id?: string; session_id?: string } | undefined)
              ?.agent_session_id ??
            (trace as { session_id?: string } | undefined)?.session_id ??
            null,
          agent_id: (trace as { agent_id?: string | null } | undefined)?.agent_id ?? null,
          input_tokens:
            (trace as { input_tokens?: number | null } | undefined)?.input_tokens ?? null,
          output_tokens:
            (trace as { output_tokens?: number | null } | undefined)?.output_tokens ?? null,
        });
        setPhase("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load trace");
        setPhase("error");
      });

    return () => {
      cancelled = true;
    };
  }, [currentOrg, traceId]);

  useEffect(() => {
    if (!liveStream.live || liveStream.events.length === 0) return;
    const last = liveStream.events[liveStream.events.length - 1];
    if (!last || (last.type !== "span_end" && last.type !== "span_start")) return;
    const spanId = typeof last.span_id === "string" ? last.span_id : null;
    if (!spanId) return;
    setRows((prev) => {
      if (prev.some((r) => r.span_id === spanId)) return prev;
      return [
        ...prev,
        {
          span_id: spanId,
          name: String(last.name ?? "live.span"),
          timestamp:
            typeof last.timestamp === "string"
              ? last.timestamp
              : new Date().toISOString(),
          duration_ms: Number(
            (last.attributes as { duration_ms?: number } | undefined)?.duration_ms ?? 0,
          ),
          event_type: "tool",
          outcome: last.status === "error" ? "error" : null,
        } as (typeof prev)[number],
      ];
    });
  }, [liveStream.events, liveStream.live]);

  const fallbackTimelineSteps = useMemo(() => {
    if (rows.length === 0) return [];
    const t0 = Math.min(...rows.map((r) => new Date(r.timestamp).getTime()));
    return rows.map((r) => {
      const start = Math.max(0, new Date(r.timestamp).getTime() - t0);
      const duration = Math.max(0, r.duration_ms);
      return {
        name: r.name,
        start_ms: start,
        end_ms: start + duration,
        duration_ms: duration,
        event_type: String(r.event_type ?? "span"),
        outcome: r.outcome === "failure" || r.outcome === "error" ? "failure" : null,
      };
    });
  }, [rows]);

  const timelineSteps =
    timelineQuery.data?.steps?.length ? timelineQuery.data.steps : fallbackTimelineSteps;
  const timelineTotalMs =
    timelineQuery.data?.total_duration_ms ??
    meta?.duration_ms ??
    Math.max(1, ...timelineSteps.map((s) => s.end_ms), 1);

  const totalTokens =
    meta?.input_tokens != null && meta?.output_tokens != null
      ? {
          input: meta.input_tokens,
          output: meta.output_tokens,
          total: meta.input_tokens + meta.output_tokens,
        }
      : undefined;

  const setModeAndNotify = (next: DetailMode) => {
    setMode(next);
    onModeChange?.(next);
  };

  if (phase === "meta") {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        <p className="text-xs text-[var(--text-muted)]">Loading trace summary…</p>
      </div>
    );
  }

  if (error || phase === "error") {
    return <ErrorState title="Could not load trace" message={error ?? "Unknown error"} />;
  }

  const openInLinks = [
    { label: "Create artifact", href: artifactHref() },
    { label: "Open playground", href: playgroundHref(traceId) },
    {
      label: "Add to dataset",
      href: `/evals?tab=datasets&promote_trace=${encodeURIComponent(traceId)}`,
    },
    { label: "Seed labeling", href: labelingQueueHref() },
    { label: "Related issues", href: `/issues?q=${encodeURIComponent(traceId)}` },
    { label: "Alerts", href: "/alerts" },
  ];

  const showLiveBadge = liveStream.live && !liveStream.finalized;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-[var(--border-default)] flex flex-wrap items-center gap-2 text-xs">
        <TraceOutcomeBadge outcome={meta?.outcome ?? null} />
        {showLiveBadge && (
          <span
            data-testid="live-trace-badge"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-[var(--terminal)] border border-[var(--terminal)]/40 bg-[var(--terminal)]/10"
            aria-live="polite"
          >
            <Radio className="h-3 w-3 animate-pulse" aria-hidden />
            Live
          </span>
        )}
        {liveStream.failed && !liveStream.finalized && (
          <button
            type="button"
            data-testid="live-trace-retry"
            onClick={() => liveStream.retry()}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-[var(--error)] border border-[var(--error)]/40 hover:bg-[var(--error)]/10"
          >
            Live reconnect failed — Retry
          </button>
        )}
        {liveStream.finalized && (
          <span className="text-2xs text-[var(--text-muted)]">Live → persisted</span>
        )}
        <span className="text-[var(--text-muted)]">
          {meta?.span_count ?? 0} spans · {(meta?.duration_ms ?? 0).toFixed(0)}ms
          {liveStream.events.length > 0 ? ` · +${liveStream.events.length} live` : ""}
        </span>
        {meta?.cost_cents != null && (
          <span className="font-mono">${(meta.cost_cents / 100).toFixed(2)}</span>
        )}
        {sessionId && (
          <Link
            href={`/sessions/${encodeURIComponent(sessionId)}`}
            className="text-[var(--accent)] hover:underline inline-flex items-center gap-1"
          >
            Session <ExternalLink className="w-3 h-3" />
          </Link>
        )}
        <details className="group relative">
          <summary className="cursor-pointer list-none text-[var(--text-muted)] hover:text-[var(--text-primary)] inline-flex items-center gap-0.5 [&::-webkit-details-marker]:hidden">
            Open in…
            <ChevronRight className="h-3 w-3 opacity-60 transition-transform group-open:rotate-90" />
          </summary>
          <div className="absolute left-0 top-full z-20 mt-1 min-w-[11rem] rounded border border-[var(--border-default)] bg-[var(--bg-primary)] py-1 shadow-md">
            {openInLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="block px-3 py-1.5 text-2xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </details>
        <Tabs
          value={mode}
          onValueChange={(id) => setModeAndNotify(id as DetailMode)}
          className="ml-2"
        >
          <TabsList
            variant="underline"
            aria-label="Trace detail modes"
            className="h-auto gap-1 rounded-none bg-transparent p-0"
          >
            {TRACE_DETAIL_MODE_TABS.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                variant="underline"
                className="min-h-8 px-2 text-2xs"
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {onClose && !hideCloseControl ? (
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Esc
          </button>
        ) : null}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {mode === "scores" && currentOrg ? (
          <ScoresTab orgId={currentOrg.id} traceId={traceId} />
        ) : mode === "timeline" ? (
          <TraceTimelineView
            loading={timelineQuery.isLoading && timelineSteps.length === 0}
            error={timelineQuery.error?.message ?? null}
            steps={timelineSteps}
            totalMs={timelineTotalMs}
            markers={timelineQuery.data?.markers ?? []}
          />
        ) : mode === "meta" ? (
          <div className="space-y-4 p-3">
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--text-muted)]">Trace</dt>
                <dd className="font-mono break-all">{traceId}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--text-muted)]">Agent</dt>
                <dd>{meta?.agent_id ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--text-muted)]">Model</dt>
                <dd>{meta?.model ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--text-muted)]">Tokens</dt>
                <dd className="font-mono">
                  {totalTokens
                    ? `${totalTokens.total.toLocaleString()} (${totalTokens.input.toLocaleString()} in / ${totalTokens.output.toLocaleString()} out)`
                    : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--text-muted)]">Cost</dt>
                <dd className="font-mono">
                  {meta?.cost_cents != null ? `$${(meta.cost_cents / 100).toFixed(4)}` : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--text-muted)]">Outcome</dt>
                <dd>{meta?.outcome ?? "—"}</dd>
              </div>
            </dl>
            <LatencyHistogram
              durations={rows.map((r) => r.duration_ms)}
              height={120}
              title="Span latency distribution"
            />
          </div>
        ) : mode === "tree" ? (
          treeRows.length === 0 ? (
            <p className="p-4 text-sm text-[var(--text-muted)]">No spans in tree.</p>
          ) : (
            <ul className="space-y-0.5 p-2 font-mono text-2xs" data-testid="trace-span-tree">
              {treeRows.map((node) => (
                <SpanTreeNode key={node.span_id} node={node} depth={0} />
              ))}
            </ul>
          )
        ) : rows.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)] p-4">
            {liveStream.live ? "Waiting for live steps…" : "No transcript steps found."}
          </p>
        ) : (
          <VirtualizedTranscript
            traceId={traceId}
            rows={rows}
            totalDurationMs={meta?.duration_ms ?? 0}
            totalCost={meta?.cost_cents != null ? meta.cost_cents / 100 : undefined}
            totalTokens={totalTokens}
            model={meta?.model}
            outcome={
              (meta?.outcome as
                | "success"
                | "failure"
                | "partial"
                | "timeout"
                | "crash"
                | null) ?? null
            }
            spanCount={meta?.span_count ?? rows.length}
            orgId={currentOrg?.id}
            sessionId={sessionId}
            highlightSpanId={highlightSpanId}
          />
        )}
      </div>
    </div>
  );
}

function SpanTreeNode({ node, depth }: { node: TranscriptRow; depth: number }) {
  const kids = node.children ?? [];
  const [open, setOpen] = useState(depth < 2);
  const failed = node.outcome === "failure" || node.outcome === "error";

  return (
    <li>
      <div
        className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-[var(--bg-secondary)]"
        style={{ paddingLeft: `${depth * 0.75 + 0.25}rem` }}
      >
        {kids.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Collapse" : "Expand"}
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
            />
          </button>
        ) : (
          <span className="inline-block w-3 shrink-0" aria-hidden />
        )}
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            failed ? "bg-[var(--error)]" : "bg-[var(--terminal)]/70",
          )}
          title={node.outcome ?? "ok"}
        />
        <span className="min-w-0 truncate text-[var(--text-secondary)]" title={node.name}>
          {node.name}
        </span>
        <span className="shrink-0 text-[var(--text-muted)]">
          {node.duration_ms.toFixed(0)}ms
        </span>
        <span className="shrink-0 text-[var(--text-muted)]/70">
          {node.span_id.slice(0, 8)}
        </span>
      </div>
      {open && kids.length > 0 ? (
        <ul>
          {kids.map((child) => (
            <SpanTreeNode key={child.span_id} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TraceTimelineView({
  loading,
  error,
  steps,
  totalMs,
  markers,
}: {
  loading: boolean;
  error: string | null;
  steps: Array<{
    name: string;
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    event_type: string;
    outcome: string | null;
  }>;
  totalMs: number;
  markers: Array<{ at_ms: number; label: string; severity: string }>;
}) {
  if (loading) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        <p className="text-xs text-[var(--text-muted)]">Loading timeline…</p>
      </div>
    );
  }

  if (error && steps.length === 0) {
    return <ErrorState title="Could not load timeline" message={error} />;
  }

  if (steps.length === 0) {
    return (
      <p className="p-4 text-sm text-[var(--text-muted)]">No timeline steps for this trace.</p>
    );
  }

  const span = Math.max(totalMs, 1);

  return (
    <div className="space-y-3 p-3" data-testid="trace-timeline">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs text-[var(--text-muted)]">
          Condensed Gantt · {steps.length} steps · {span.toFixed(0)}ms
        </p>
        {error ? (
          <p className="text-2xs text-[var(--warning)]">API timeline unavailable — using span tree</p>
        ) : null}
      </div>
      <div className="relative space-y-1.5">
        {markers.map((m) => (
          <div
            key={`${m.at_ms}-${m.label}`}
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--warning)]/60"
            style={{ left: `${Math.min(100, (m.at_ms / span) * 100)}%` }}
            title={m.label}
          />
        ))}
        {steps.map((s, i) => {
          const left = Math.min(100, (s.start_ms / span) * 100);
          const width = Math.max(0.5, Math.min(100 - left, (s.duration_ms / span) * 100));
          const failed = s.outcome === "failure" || s.outcome === "error";
          return (
            <div key={`${s.name}-${i}`} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2">
              <span className="truncate font-mono text-2xs text-[var(--text-secondary)]" title={s.name}>
                {s.name}
              </span>
              <div className="relative h-5 rounded bg-[var(--bg-secondary)]">
                <div
                  className={
                    failed
                      ? "absolute top-0.5 bottom-0.5 rounded bg-[var(--error)]/80"
                      : "absolute top-0.5 bottom-0.5 rounded bg-[var(--terminal)]/70"
                  }
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${s.name}: ${s.duration_ms.toFixed(0)}ms`}
                />
              </div>
              <span className="w-12 text-right font-mono text-2xs text-[var(--text-muted)]">
                {s.duration_ms.toFixed(0)}ms
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
