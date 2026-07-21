"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, Radio } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { useLiveTraceStream } from "@/hooks/use-live-trace-stream";
import {
  buildSpanTree,
  buildTranscriptRows,
} from "@/lib/observability/build-transcript-rows";
import { VirtualizedTranscript } from "@/components/transcript-v2/VirtualizedTranscript";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorState } from "@/components/ui/error-state";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import { markEden } from "@/lib/perf";
import { cn } from "@/lib/utils";
import {
  artifactHref,
  improveHref,
  labelingQueueHref,
  playgroundHref,
  preserveFromSearchParams,
  promoteTraceToDatasetHref,
  sessionHref,
} from "@/lib/portal-cross-links";
import { useTraceTimeline } from "@/app/(portal)/observability/_lib/use-observability-data";
import { resolveTimelineSteps } from "@/lib/observability/timeline-sync";
import { TraceTimelineView, TraceTreeView } from "./trace-detail-views";
import { TraceHeader } from "./TraceHeader";

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
  /** Write-back selected span id to hub URL (`?spanId=`). */
  onSpanSelect?: (spanId: string | null) => void;
}

export function TraceDetailPanel({
  traceId,
  onClose,
  highlightSpanId,
  hideCloseControl = false,
  initialMode = "transcript",
  onModeChange,
  onSpanSelect,
}: TraceDetailPanelProps) {
  const { currentOrg } = useOrg();
  const searchParams = useSearchParams();
  const linkPreserve = useMemo(
    () => preserveFromSearchParams(searchParams),
    [searchParams],
  );
  const [phase, setPhase] = useState<"meta" | "ready" | "error">("meta");
  const [mode, setMode] = useState<DetailMode>(initialMode);
  /** Laminar-style Gantt strip above transcript — collapsed by default. */
  const [ganttStripOpen, setGanttStripOpen] = useState(false);
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
    mode === "timeline" || (mode === "transcript" && ganttStripOpen)
      ? currentOrg?.id
      : undefined,
    mode === "timeline" || (mode === "transcript" && ganttStripOpen)
      ? traceId
      : null,
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

  const timelineSteps = useMemo(
    () => resolveTimelineSteps(timelineQuery.data?.steps, rows),
    [timelineQuery.data?.steps, rows],
  );
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

  const spanForPlayground = highlightSpanId ?? undefined;
  const addToDatasetHref = promoteTraceToDatasetHref(traceId, linkPreserve);
  const openPlaygroundHref = playgroundHref(traceId, spanForPlayground, linkPreserve);

  /** Wave 6 + Wave 9: secondary closed-loop actions (ghost; one solid CTA max elsewhere). */
  const openInLinks = [
    { label: "Open Improve", href: improveHref() },
    { label: "Create artifact", href: artifactHref() },
    { label: "Seed labeling", href: labelingQueueHref() },
    { label: "Related issues", href: `/issues?q=${encodeURIComponent(traceId)}` },
    { label: "Alerts", href: "/alerts" },
  ];
  if (sessionId) {
    openInLinks.unshift({
      label: "Open session",
      href: sessionHref(sessionId, linkPreserve),
    });
  }

  const showLiveBadge = liveStream.live && !liveStream.finalized;

  /** Wave 4: ≤4 header metrics — outcome · spans · duration · cost. */
  const headerMetrics = [
    { key: "outcome", node: <TraceOutcomeBadge outcome={meta?.outcome ?? null} /> },
    {
      key: "spans",
      node: (
        <span className="tabular-nums text-[var(--text-muted)]">
          {meta?.span_count ?? 0} spans
        </span>
      ),
    },
    {
      key: "duration",
      node: (
        <span className="tabular-nums text-[var(--text-muted)]">
          {(meta?.duration_ms ?? 0).toFixed(0)}ms
        </span>
      ),
    },
    {
      key: "cost",
      node:
        meta?.cost_cents != null ? (
          <span className="font-mono tabular-nums">${(meta.cost_cents / 100).toFixed(2)}</span>
        ) : (
          <span className="text-[var(--text-faint)]">—</span>
        ),
    },
  ] as const;

  const liveSlot = (
    <>
      {showLiveBadge && (
        <span
          data-testid="live-trace-badge"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--terminal)] border border-[var(--terminal)]/40 bg-[var(--terminal)]/10"
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
          className="inline-flex items-center gap-1 rounded border border-[var(--error)]/40 px-1.5 py-0.5 text-xs font-medium text-[var(--error)] hover:bg-[var(--error)]/10"
        >
          Live reconnect failed — Retry
        </button>
      )}
      {liveStream.finalized && (
        <span className="text-xs text-[var(--text-muted)]">Live → persisted</span>
      )}
      {liveStream.events.length > 0 ? (
        <span className="text-xs text-[var(--text-muted)]">+{liveStream.events.length} live</span>
      ) : null}
    </>
  );

  const overflowActions = (
    <div
      className="ml-auto flex flex-wrap items-center gap-1.5"
      data-wave-e1-trace-loop="primary"
      data-wave-v3-6-loop="secondary"
    >
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-xs font-medium text-[var(--text-secondary)]"
      >
        <Link
          href={addToDatasetHref}
          data-testid="trace-add-to-dataset"
          data-wave-e1-trace-cta="add-to-dataset"
          data-wave-v3-6-cta="add-to-dataset"
        >
          Add to dataset
        </Link>
      </Button>
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-xs font-medium text-[var(--text-secondary)]"
      >
        <Link
          href={openPlaygroundHref}
          data-testid="trace-open-playground"
          data-wave-e1-trace-cta="open-playground"
          data-wave-v3-6-cta="open-playground"
        >
          Iterate in playground
        </Link>
      </Button>
      <details className="group relative">
        <summary
          className="inline-flex cursor-pointer list-none items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden"
          data-testid="trace-actions-overflow"
        >
          More
          <ChevronRight className="h-3 w-3 opacity-60 transition-transform group-open:rotate-90" />
        </summary>
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[11rem] rounded border border-[var(--border-default)] bg-[var(--bg-primary)] py-1 shadow-md">
            {openInLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              data-wave9-improve-crossloop={
                link.label === "Open Improve" ? "trace-improve" : undefined
              }
              className="block px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </details>
    </div>
  );

  const modeTabs = (
    <Tabs
      value={mode}
      onValueChange={(id) => setModeAndNotify(id as DetailMode)}
      className="w-full sm:w-auto"
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
            className="min-h-8 px-2 text-xs"
          >
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  const pillClass =
    "rounded border border-[var(--border-subtle)] px-space-1 py-space-1 font-mono text-[var(--text-muted)] tabular-nums";
  const contextPills = (
    <div className="flex flex-wrap items-center gap-space-1" data-testid="trace-context-pills">
      {meta?.model ? <span className={pillClass}>{meta.model}</span> : null}
      {meta?.duration_ms != null ? (
        <span className={pillClass} data-pill="latency">
          {(meta.duration_ms).toFixed(0)}ms
        </span>
      ) : null}
      {totalTokens ? (
        <span className={pillClass} data-pill="tokens">
          {totalTokens.total.toLocaleString()} tok
        </span>
      ) : null}
      {meta?.cost_cents != null ? (
        <span className={pillClass} data-pill="cost">
          ${(meta.cost_cents / 100).toFixed(4)}
        </span>
      ) : null}
      {sessionId ? (
        <span className={pillClass} data-pill="session">
          session {sessionId.slice(0, 10)}…
        </span>
      ) : null}
    </div>
  );

  const failureOutcome =
    meta?.outcome === "failure" ||
    meta?.outcome === "error" ||
    meta?.outcome === "crash" ||
    meta?.outcome === "timeout";

  const issuesHref = (() => {
    const q = new URLSearchParams();
    q.set("q", traceId);
    if (linkPreserve?.pastHours) q.set("pastHours", linkPreserve.pastHours);
    if (linkPreserve?.realm) q.set("realm", linkPreserve.realm);
    if (linkPreserve?.outcome) q.set("outcome", linkPreserve.outcome);
    if (linkPreserve?.agent_id) q.set("agent_id", linkPreserve.agent_id);
    return `/issues?${q.toString()}`;
  })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TraceHeader
        metrics={[...headerMetrics]}
        liveSlot={liveSlot}
        overflowActions={overflowActions}
        modeTabs={modeTabs}
        contextPills={contextPills}
        closeControl={
          onClose && !hideCloseControl ? (
            <button
              type="button"
              onClick={onClose}
              className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              Esc
            </button>
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {mode === "scores" && currentOrg ? (
          <ScoresTab orgId={currentOrg.id} traceId={traceId} />
        ) : mode === "timeline" ? (
          <TraceTimelineView
            loading={timelineQuery.isLoading && timelineSteps.length === 0}
            error={timelineQuery.error?.message ?? null}
            steps={timelineSteps}
            totalMs={timelineTotalMs}
            markers={timelineQuery.data?.markers ?? []}
            selectedSpanId={highlightSpanId}
            onSpanSelect={(spanId) => onSpanSelect?.(spanId)}
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
          <TraceTreeView
            roots={treeRows}
            selectedSpanId={highlightSpanId}
            onSpanSelect={(spanId) => onSpanSelect?.(spanId)}
          />
        ) : rows.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)] p-4">
            {liveStream.live ? "Waiting for live steps…" : "No transcript steps found."}
          </p>
        ) : (
          <>
            {failureOutcome ? (
              <div
                data-testid="trace-failure-callout"
                className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-[var(--error)]/25 bg-[var(--error)]/5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)]"
              >
                <span>
                  Trace outcome{" "}
                  <span className="font-mono uppercase text-[var(--error)]">
                    {meta?.outcome}
                  </span>
                  .
                </span>
                <Link
                  href={issuesHref}
                  className="font-medium text-[var(--accent)] hover:underline"
                >
                  View related issues
                </Link>
              </div>
            ) : null}
            <div
              className="mb-2 rounded border border-[var(--border-subtle)]"
              data-testid="transcript-gantt-strip"
            >
              <button
                type="button"
                data-testid="transcript-gantt-toggle"
                aria-expanded={ganttStripOpen}
                onClick={() => setGanttStripOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-2xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 transition-transform",
                    ganttStripOpen && "rotate-90",
                  )}
                />
                Timeline overview
                <span className="ml-auto tabular-nums">
                  {timelineSteps.length} spans
                </span>
              </button>
              {ganttStripOpen ? (
                <TraceTimelineView
                  loading={timelineQuery.isLoading && timelineSteps.length === 0}
                  error={timelineQuery.error?.message ?? null}
                  steps={timelineSteps}
                  totalMs={timelineTotalMs}
                  markers={timelineQuery.data?.markers ?? []}
                  selectedSpanId={highlightSpanId}
                  onSpanSelect={(spanId) => onSpanSelect?.(spanId)}
                  variant="strip"
                />
              ) : null}
            </div>
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
              onSpanSelect={onSpanSelect}
            />
          </>
        )}
      </div>
    </div>
  );
}

