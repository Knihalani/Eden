"use client";

import * as React from "react";
import Link from "next/link";
import { X } from "lucide-react";
import type { TranscriptRow as TR } from "@/lib/observability/types";
import {
  MessagesPanel,
  ResponsePanel,
  ToolCallsList,
  ToolResultsPanel,
  ReasoningPanel,
  LazyJson,
  SectionHeader,
  IoFormatToggle,
} from "@/components/transcript-v2/transcript-panels";
import { formatDuration } from "@/components/transcript-v2/transcript-format";
import { classifySpanKind, spanKindColor, spanKindLabel } from "@/components/transcript-v2/span-kind";
import { playgroundHref, promoteTraceToDatasetHref } from "@/lib/portal-cross-links";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-[var(--border-subtle)] py-1.5">
      <dt className="shrink-0 text-[var(--text-muted)]">{k}</dt>
      <dd className="min-w-0 break-all text-right font-mono text-[var(--text-secondary)]">{v}</dd>
    </div>
  );
}

export interface SpanInspectorProps {
  row: TR;
  traceId: string;
  orgId?: string;
  onClose: () => void;
  className?: string;
}

/**
 * Sticky full-height inspector — Input plane vs toned Output wash.
 */
export function SpanInspector({
  row,
  traceId,
  orgId,
  onClose,
  className,
}: SpanInspectorProps) {
  const [ioMode, setIoMode] = React.useState<"formatted" | "json">("formatted");
  const hasMessages = Boolean(row.request_body?.messages?.length);
  const hasResponse = row.response_body != null;
  const hasTools = Boolean(row.tool_calls?.length || row.tool_results?.length);
  const hasIo = hasMessages || hasResponse || hasTools || Boolean(row.reasoning?.length);
  const kind = classifySpanKind(row);
  const rail = spanKindColor(kind);

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 w-full flex-col overflow-hidden border-l border-[var(--border-default)] bg-[var(--bg-secondary)]",
        "min-w-0 max-w-full sm:min-w-[360px] sm:max-w-[28rem]",
        className,
      )}
      data-testid="span-inspector"
      data-testid-legacy="span-detail-sidebar"
      aria-label="Span I/O inspector"
    >
      <div className="shrink-0 border-b border-[var(--border-default)]">
        <div className="flex items-stretch">
          <span className="w-1 shrink-0" style={{ background: rail }} aria-hidden />
          <div className="min-w-0 flex-1 px-space-3 py-space-2">
            <div className="flex items-start justify-between gap-space-2">
              <div className="min-w-0">
                <div className="text-2xs font-mono uppercase tracking-wider text-[var(--text-muted)]">
                  {spanKindLabel(kind)}
                </div>
                <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
                  {row.name}
                </div>
                <div className="mt-space-1 font-mono text-2xs text-[var(--text-muted)]">
                  {row.span_id}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close span inspector"
                data-testid="span-inspector-close"
                className={cn(
                  "inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                  FOCUS_RING_CLASS,
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Link
                href={playgroundHref(traceId, row.span_id)}
                className="text-2xs text-[var(--accent)] hover:underline"
                data-testid="inspector-playground"
              >
                Playground
              </Link>
              <Link
                href={promoteTraceToDatasetHref(traceId)}
                className="text-2xs text-[var(--accent)] hover:underline"
                data-testid="inspector-dataset"
              >
                Dataset
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <dl className="space-y-0 p-space-3 text-xs">
          <KV k="duration" v={formatDuration(row.duration_ms)} />
          <KV k="outcome" v={row.outcome || "—"} />
          {row.finish_reason ? <KV k="finish_reason" v={row.finish_reason} /> : null}
          {row.model_version ? <KV k="model_version" v={row.model_version} /> : null}
          {row.cache_hit ? <KV k="cache" v="HIT" /> : null}
          {row.streaming_metrics?.ttft_ms != null ? (
            <KV k="ttft_ms" v={row.streaming_metrics.ttft_ms.toFixed(0)} />
          ) : null}
          <KV k="timestamp" v={row.timestamp} />
        </dl>

        {!hasIo ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-1 border-t border-[var(--border-default)] p-6 text-center"
            data-testid="span-inspector-empty"
          >
            <p className="text-sm text-[var(--text-secondary)]">No I/O on this span</p>
            <p className="text-xs text-[var(--text-muted)]">
              Select an LLM or tool span to inspect messages and responses.
            </p>
          </div>
        ) : (
          <div className="space-y-space-3 border-t border-[var(--border-default)] p-space-3">
            <div className="flex items-center justify-between gap-2">
              <SectionHeader>I/O</SectionHeader>
              <IoFormatToggle value={ioMode} onChange={setIoMode} id="io-format-toggle-inspector" />
            </div>

            {ioMode === "json" ? (
              <LazyJson
                value={{
                  request: row.request_body,
                  response: row.response_body,
                  tool_calls: row.tool_calls,
                  tool_results: row.tool_results,
                }}
              />
            ) : (
              <>
                {row.reasoning && row.reasoning.length > 0 ? (
                  <ReasoningPanel blocks={row.reasoning} />
                ) : null}
                {hasMessages ? (
                  <div
                    data-plane="input"
                    className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-2.5"
                  >
                    <MessagesPanel title="Input" messages={row.request_body!.messages!} />
                  </div>
                ) : null}
                {row.tool_calls && row.tool_calls.length > 0 ? (
                  <ToolCallsList
                    toolCalls={row.tool_calls}
                    orgId={orgId}
                    traceId={traceId}
                    spanId={row.span_id}
                    agentId={row.agent_id ?? undefined}
                  />
                ) : null}
                {row.tool_results && row.tool_results.length > 0 ? (
                  <ToolResultsPanel results={row.tool_results} />
                ) : null}
                {hasResponse ? (
                  <div
                    data-plane="output"
                    className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]/50 p-2.5"
                  >
                    <ResponsePanel response={row.response_body as never} />
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
