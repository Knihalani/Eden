"use client";

import dynamic from "next/dynamic";
import type { TranscriptRow } from "@/lib/observability/types";
import type { TraceViewerMeta } from "../use-trace-viewer-data";

const LatencyHistogram = dynamic(
  () =>
    import("@/components/observability/LatencyHistogram").then((m) => ({
      default: m.LatencyHistogram,
    })),
  { ssr: false },
);

export interface MetadataCanvasProps {
  traceId: string;
  meta: TraceViewerMeta | null;
  sessionId: string | null;
  totalTokens?: { input: number; output: number; total: number };
  rows: TranscriptRow[];
}

/** Spacious KV + latency hist. Inspector stays closed. */
export function MetadataCanvas({
  traceId,
  meta,
  sessionId,
  totalTokens,
  rows,
}: MetadataCanvasProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-space-4" data-testid="metadata-canvas">
      <div className="max-w-2xl space-y-space-4">
        <dl className="space-y-space-3 text-xs" data-testid="trace-metadata-dl">
          <div className="flex justify-between gap-4 border-b border-[var(--border-subtle)] pb-space-2">
            <dt className="text-[var(--text-muted)]">Trace</dt>
            <dd className="break-all text-right font-mono">{traceId}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--text-muted)]">Agent</dt>
            <dd className="font-mono">{meta?.agent_id ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--text-muted)]">Session</dt>
            <dd className="font-mono">{sessionId ?? "—"}</dd>
          </div>
          {meta?.user_id ? (
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--text-muted)]">User</dt>
              <dd className="font-mono">{meta.user_id}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--text-muted)]">Model</dt>
            <dd className="font-mono">{meta?.model ?? "—"}</dd>
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
            <dt className="text-[var(--text-muted)]">Duration</dt>
            <dd className="font-mono tabular-nums">{(meta?.duration_ms ?? 0).toFixed(0)}ms</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--text-muted)]">Spans</dt>
            <dd className="font-mono tabular-nums">{meta?.span_count ?? 0}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--text-muted)]">Outcome</dt>
            <dd>{meta?.outcome ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--text-muted)]">Tags</dt>
            <dd className="max-w-[70%] text-right">
              {meta?.tags?.length
                ? meta.tags.map((t) => (
                    <span
                      key={t}
                      className="mb-1 ml-1 inline-block rounded border border-[var(--border-subtle)] px-1.5 py-0.5 font-mono text-2xs text-[var(--text-muted)]"
                    >
                      {t}
                    </span>
                  ))
                : "—"}
            </dd>
          </div>
        </dl>
        <LatencyHistogram
          durations={rows.map((r) => r.duration_ms)}
          height={120}
          title="Span latency distribution"
        />
      </div>
    </div>
  );
}
