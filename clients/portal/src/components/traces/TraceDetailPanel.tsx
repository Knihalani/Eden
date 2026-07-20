"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, ExternalLink, Radio } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { useLiveTraceStream } from "@/hooks/use-live-trace-stream";
import { buildTranscriptRows } from "@/lib/observability/build-transcript-rows";
import { VirtualizedTranscript } from "@/components/transcript-v2/VirtualizedTranscript";
import { CrossLinkBar } from "@/components/portal-os/CrossLinkBar";
import { ErrorState } from "@/components/ui/error-state";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import { markEden } from "@/lib/perf";
import { cn } from "@/lib/utils";
import {
  artifactHref,
  labelingQueueHref,
  playgroundHref,
} from "@/lib/portal-cross-links";
import { ScoresTab } from "@/app/(portal)/observability/ScoresTab";
import { LatencyHistogram } from "@/components/observability/LatencyHistogram";

export interface TraceDetailPanelProps {
  traceId: string;
  onClose?: () => void;
  highlightSpanId?: string | null;
}

type DetailMode = "transcript" | "tree" | "meta" | "scores";

export function TraceDetailPanel({ traceId, onClose, highlightSpanId }: TraceDetailPanelProps) {
  const { currentOrg } = useOrg();
  const [phase, setPhase] = useState<"meta" | "ready" | "error">("meta");
  const [mode, setMode] = useState<DetailMode>("transcript");
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    duration_ms: number;
    span_count: number;
    outcome: string | null;
    model?: string;
    cost_cents?: number | null;
    session_id?: string | null;
  } | null>(null);
  const [rows, setRows] = useState<ReturnType<typeof buildTranscriptRows>>([]);

  const sessionId = meta?.session_id ?? null;
  const liveStream = useLiveTraceStream({
    orgId: currentOrg?.id,
    sessionId: sessionId ?? traceId,
    enabled: Boolean(currentOrg?.id && (sessionId || phase === "ready")),
  });

  useEffect(() => {
    if (!currentOrg || !traceId) return;
    let cancelled = false;
    setPhase("meta");
    setError(null);
    setRows([]);
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
        setRows(
          buildTranscriptRows(roots as Array<Record<string, unknown>>, {
            lazyToolPayloads: true,
          }),
        );
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
          kind: "tool",
          status: last.status === "error" ? "error" : "ok",
        } as (typeof prev)[number],
      ];
    });
  }, [liveStream.events, liveStream.live]);

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

  const crossLinks = [
    { label: "Create artifact", href: artifactHref() },
    { label: "Open playground", href: playgroundHref(traceId) },
    { label: "Add to dataset", href: `/evals?tab=datasets&promote_trace=${encodeURIComponent(traceId)}` },
    { label: "Seed labeling", href: labelingQueueHref() },
    { label: "Related issues", href: `/issues?q=${encodeURIComponent(traceId)}` },
    { label: "Alerts", href: "/alerts" },
    ...(sessionId
      ? [{ label: "Session", href: `/sessions/${encodeURIComponent(sessionId)}` }]
      : []),
  ];

  const showLiveBadge = liveStream.live && !liveStream.finalized;

  return (
    <div className="flex flex-col h-full">
      <CrossLinkBar links={crossLinks} />
      <div className="px-4 py-2 border-b border-[var(--border-default)] flex flex-wrap items-center gap-2 text-xs">
        <TraceOutcomeBadge outcome={meta?.outcome ?? null} />
        {showLiveBadge && (
          <span
            data-testid="live-trace-badge"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--terminal)] border border-[var(--terminal)]/40 bg-[var(--terminal)]/10"
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
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--error)] border border-[var(--error)]/40 hover:bg-[var(--error)]/10"
          >
            Live reconnect failed — Retry
          </button>
        )}
        {liveStream.finalized && (
          <span className="text-[10px] text-[var(--text-muted)]">Live → persisted</span>
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
            View session <ExternalLink className="w-3 h-3" />
          </Link>
        )}
        <div className="inline-flex rounded-md border border-[var(--border-default)] p-0.5 ml-2">
          {(["transcript", "tree", "meta", "scores"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "px-2 py-0.5 text-[10px] capitalize rounded",
                mode === m
                  ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                  : "text-[var(--text-muted)]",
              )}
            >
              {m}
            </button>
          ))}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Esc
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {mode === "scores" && currentOrg ? (
          <ScoresTab orgId={currentOrg.id} traceId={traceId} />
        ) : mode === "meta" ? (
          <div className="space-y-4 p-3">
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--text-muted)]">Trace</dt>
                <dd className="font-mono break-all">{traceId}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--text-muted)]">Model</dt>
                <dd>{meta?.model ?? "—"}</dd>
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
          <ul className="space-y-1 p-2 font-mono text-[11px] text-[var(--text-secondary)]">
            {rows.map((r) => (
              <li key={r.span_id} className="truncate">
                {r.name} · {r.duration_ms.toFixed(0)}ms · {r.span_id.slice(0, 8)}
              </li>
            ))}
          </ul>
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
