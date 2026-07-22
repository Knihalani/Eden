"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, Clock, X } from "lucide-react";
import type { TranscriptRow as TR } from "@/lib/observability/types";
import { formatDuration } from "./transcript-format";
import { MessagesPanel, ResponsePanel } from "./transcript-panels";

export function SummaryCard({
  durationMs,
  spanCount,
  outcome,
  model,
  totalCost,
  totalTokens,
}: {
  durationMs: number;
  spanCount: number;
  outcome?: string | null;
  model?: string;
  totalCost?: number;
  totalTokens?: { input: number; output: number; total: number };
}) {
  const borderColor =
    outcome === "success"
      ? "var(--terminal)"
      : outcome === "failure" || outcome === "crash"
        ? "var(--error)"
        : outcome === "partial" || outcome === "timeout"
          ? "var(--warning)"
          : "var(--border-default)";
  return (
    <div
      className="border-b-2 px-space-4 py-space-3"
      style={{ borderBottomColor: borderColor, background: "var(--bg-secondary)" }}
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <div className="flex items-center gap-space-2">
          <Clock className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <span className="font-mono tabular-nums">{formatDuration(durationMs)}</span>
        </div>
        <div className="text-[var(--text-muted)]">
          <span className="font-mono tabular-nums text-[var(--text-primary)]">{spanCount}</span>{" "}
          spans
        </div>
        {model && (
          <div className="text-[var(--text-muted)]">
            <span className="text-[var(--text-primary)] font-mono text-xs">{model}</span>
          </div>
        )}
        {totalTokens && (
          <div className="text-[var(--text-muted)]">
            <span className="font-mono tabular-nums text-[var(--text-primary)]">
              {totalTokens.total.toLocaleString()}
            </span>{" "}
            tokens
            <span className="ml-space-1 text-2xs">
              ({totalTokens.input.toLocaleString()} in / {totalTokens.output.toLocaleString()} out)
            </span>
          </div>
        )}
        {totalCost != null && (
          <div className="text-[var(--text-muted)]">
            <span className="font-mono tabular-nums text-[var(--text-primary)]">
              ${totalCost.toFixed(4)}
            </span>
          </div>
        )}
        {outcome && (
          <div className="flex items-center gap-space-1">
            {outcome === "success" ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-[var(--terminal)]" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5 text-[var(--error)]" />
            )}
            <span
              className="text-xs font-mono uppercase"
              style={{
                color: outcome === "success" ? "var(--terminal)" : "var(--error)",
              }}
            >
              {outcome}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-space-2 text-xs">
      <span className="text-[var(--text-muted)] font-mono">{k}</span>
      <span className="font-mono text-[var(--text-primary)] text-right truncate">{v}</span>
    </div>
  );
}

export function SpanDetailSidebar({
  row,
  orgId: _orgId,
  onClose,
  layout = "default",
}: {
  row: TR;
  orgId?: string;
  onClose?: () => void;
  /** Fullscreen: full-height right rail (~28–32% / min 360px). */
  layout?: "default" | "fullscreen";
}) {
  const hasMessages = Boolean(row.request_body?.messages?.length);
  const hasResponse = row.response_body != null;
  const fullscreen = layout === "fullscreen";

  return (
    <aside
      className={
        fullscreen
          ? "absolute inset-y-0 right-0 z-10 flex h-full min-h-0 w-[min(100%,22rem)] shrink-0 flex-col self-stretch overflow-hidden border-l border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-lg sm:static sm:z-auto sm:w-[min(32%,28rem)] sm:min-w-[360px] sm:shadow-none"
          : "sticky top-0 w-80 shrink-0 self-start border-l border-[var(--border-default)] bg-[var(--bg-secondary)] max-h-[min(70vh,720px)] overflow-y-auto"
      }
      data-testid="span-detail-sidebar"
      data-layout={layout}
      aria-label="Span I/O inspector"
    >
      <div className="shrink-0 border-b border-[var(--border-default)] px-space-3 py-space-2">
        <div className="flex items-start justify-between gap-space-2">
          <div className="min-w-0">
            <div className="text-2xs font-mono uppercase tracking-wider text-[var(--text-muted)]">
              Span
            </div>
            <div className="truncate font-mono text-sm">{row.name}</div>
            <div className="mt-space-1 text-2xs text-[var(--text-muted)]">
              {row.span_id} • {row.event_type}
            </div>
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close span inspector"
              data-testid="span-inspector-close"
              className="inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <div
        className={
          fullscreen
            ? "flex min-h-0 flex-1 flex-col overflow-y-auto"
            : undefined
        }
      >
        <div className="space-y-space-2 p-space-3 text-xs">
          <KV k="duration" v={formatDuration(row.duration_ms)} />
          <KV k="outcome" v={row.outcome || "—"} />
          {row.finish_reason && <KV k="finish_reason" v={row.finish_reason} />}
          {row.system_fingerprint && <KV k="fingerprint" v={row.system_fingerprint} />}
          {row.model_version && <KV k="model_version" v={row.model_version} />}
          {row.service_tier && <KV k="service_tier" v={row.service_tier} />}
          {row.cache_hit && <KV k="cache" v="HIT" />}
          {row.streaming_metrics?.ttft_ms != null && (
            <KV k="ttft_ms" v={row.streaming_metrics.ttft_ms.toFixed(0)} />
          )}
          {row.streaming_metrics?.itl_ms_avg != null && (
            <KV k="itl_ms_avg" v={row.streaming_metrics.itl_ms_avg.toFixed(1)} />
          )}
          {row.streaming_metrics?.tpot_ms != null && (
            <KV k="tpot_ms" v={row.streaming_metrics.tpot_ms.toFixed(1)} />
          )}
          <KV k="timestamp" v={row.timestamp} />
        </div>
        {(hasMessages || hasResponse) && (
          <div
            className={
              fullscreen
                ? "space-y-space-4 border-t border-[var(--border-default)] p-space-3"
                : "space-y-space-3 border-t border-[var(--border-default)] p-space-3"
            }
          >
            {hasMessages ? (
              <div data-plane="input">
                <MessagesPanel title="Input" messages={row.request_body!.messages!} />
              </div>
            ) : null}
            {hasResponse ? (
              <div data-plane="output">
                <ResponsePanel response={row.response_body as never} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

export function findRowBySpanId(rows: TR[], id: string | null): TR | null {
  if (!id) return null;
  for (const r of rows) {
    if (r.span_id === id) return r;
    if (r.children) {
      const found = findRowBySpanId(r.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function flattenSpanIds(rows: TR[]): string[] {
  const out: string[] = [];
  const walk = (rs: TR[]) => {
    for (const r of rs) {
      if (r.span_id) out.push(r.span_id);
      if (r.children?.length) walk(r.children);
    }
  };
  walk(rows);
  return out;
}
