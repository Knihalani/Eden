"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import type { TranscriptRow } from "@/lib/observability/types";
import type { TraceViewerMeta } from "../use-trace-viewer-data";
import { cn } from "@/lib/utils";

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

function MetaCell({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2.5">
      <div className="text-2xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 break-all text-sm text-[var(--text-primary)]",
          mono && "font-mono text-xs",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/** Two-column KV grid + raw JSON drawer + latency hist. */
export function MetadataCanvas({
  traceId,
  meta,
  sessionId,
  totalTokens,
  rows,
}: MetadataCanvasProps) {
  const [jsonOpen, setJsonOpen] = React.useState(false);

  const raw = React.useMemo(
    () => ({
      trace_id: traceId,
      agent_id: meta?.agent_id ?? null,
      session_id: sessionId,
      user_id: meta?.user_id ?? null,
      model: meta?.model ?? null,
      outcome: meta?.outcome ?? null,
      duration_ms: meta?.duration_ms ?? 0,
      span_count: meta?.span_count ?? 0,
      cost_cents: meta?.cost_cents ?? null,
      tokens: totalTokens ?? null,
      tags: meta?.tags ?? null,
    }),
    [traceId, meta, sessionId, totalTokens],
  );

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto p-space-4"
      data-testid="metadata-canvas"
    >
      <div className="mx-auto max-w-3xl space-y-space-4">
        <div
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          data-testid="trace-metadata-dl"
        >
          <MetaCell label="Trace" value={traceId} />
          <MetaCell label="Agent" value={meta?.agent_id ?? "—"} />
          <MetaCell label="Session" value={sessionId ?? "—"} />
          {meta?.user_id ? <MetaCell label="User" value={meta.user_id} /> : null}
          <MetaCell label="Model" value={meta?.model ?? "—"} />
          <MetaCell
            label="Tokens"
            value={
              totalTokens
                ? `${totalTokens.total.toLocaleString()} (${totalTokens.input.toLocaleString()} in / ${totalTokens.output.toLocaleString()} out)`
                : "—"
            }
          />
          <MetaCell
            label="Cost"
            value={
              meta?.cost_cents != null
                ? `$${(meta.cost_cents / 100).toFixed(4)}`
                : "—"
            }
          />
          <MetaCell
            label="Duration"
            value={`${(meta?.duration_ms ?? 0).toFixed(0)}ms`}
          />
          <MetaCell label="Spans" value={String(meta?.span_count ?? 0)} />
          <MetaCell label="Outcome" value={meta?.outcome ?? "—"} mono={false} />
          <MetaCell
            label="Tags"
            mono={false}
            value={
              meta?.tags?.length ? (
                <span className="flex flex-wrap gap-1">
                  {meta.tags.map((t) => (
                    <span
                      key={t}
                      className="inline-block rounded border border-[var(--border-subtle)] px-1.5 py-0.5 font-mono text-2xs text-[var(--text-muted)]"
                    >
                      {t}
                    </span>
                  ))}
                </span>
              ) : (
                "—"
              )
            }
          />
        </div>

        <div className="rounded-md border border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={() => setJsonOpen((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
            data-testid="metadata-json-toggle"
          >
            Raw JSON
            <span className="font-mono text-2xs text-[var(--text-muted)]">
              {jsonOpen ? "hide" : "show"}
            </span>
          </button>
          {jsonOpen ? (
            <pre className="max-h-64 overflow-auto border-t border-[var(--border-subtle)] bg-[var(--bg-tertiary)]/40 p-3 font-mono text-2xs text-[var(--text-secondary)]">
              {JSON.stringify(raw, null, 2)}
            </pre>
          ) : null}
        </div>

        <LatencyHistogram
          durations={rows.map((r) => r.duration_ms)}
          height={120}
          title="Span latency distribution"
        />
      </div>
    </div>
  );
}
