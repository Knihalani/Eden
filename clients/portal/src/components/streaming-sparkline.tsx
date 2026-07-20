"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { fetchApi } from "@/lib/api/core";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Loader2, AlertTriangle } from "lucide-react";

interface StreamingToken {
  span_id: string;
  token_index: number;
  token_text: string | null;
  token_byte_len: number;
  delta_ms: number;
  abs_ms: number;
  finish_reason: string | null;
  redacted: boolean;
}

interface SparklineProps {
  traceId: string;
  orgId: string;
  showText?: boolean;
}

/**
 * D.8 streaming token sparkline.
 *
 * Fetches the per-token delta_ms series for the trace and
 * renders a horizontal bar chart. Tokens flagged as stalls
 * (delta > 5x p50) are highlighted in red; redacted tokens
 * show a [REDACTED] pill instead of their text.
 */
export function StreamingSparkline({
  traceId,
  orgId,
  showText = false,
}: SparklineProps) {
  const tokensQuery = useOrgQuery(
    queryKeys.observability.tokens(orgId, traceId),
    orgId,
    async () => {
      const d = await fetchApi<{ data?: { tokens?: StreamingToken[] } }>(
        `/orgs/${orgId}/traces/${traceId}/tokens`,
      );
      return d.data?.tokens ?? [];
    },
    { enabled: Boolean(traceId) },
  );

  const tokens = tokensQuery.data ?? [];
  const loading = tokensQuery.isLoading;
  const error = tokensQuery.error?.message ?? null;

  const { p50, stalls, totalBytes, spanCount } = useMemo(() => {
    if (tokens.length === 0) {
      return { p50: 0, stalls: 0, totalBytes: 0, spanCount: 0 };
    }
    const sortedDeltas = tokens
      .map((t) => t.delta_ms)
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    const p50 =
      sortedDeltas.length > 0
        ? sortedDeltas[Math.floor(sortedDeltas.length / 2)]
        : 0;
    const stalls = tokens.filter((t) => t.delta_ms > 5 * p50 && p50 > 0).length;
    const totalBytes = tokens.reduce((acc, t) => acc + (t.token_byte_len || 0), 0);
    const spanCount = new Set(tokens.map((t) => t.span_id)).size;
    return { p50, stalls, totalBytes, spanCount };
  }, [tokens]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-3 text-xs text-[var(--text-secondary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading streaming tokens…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-xs text-[var(--error)]">
        <AlertTriangle className="h-4 w-4" />
        {error}
      </div>
    );
  }
  if (tokens.length === 0) {
    return (
      <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-3 text-xs text-[var(--text-secondary)]">
        No streaming tokens captured for this trace. Enable
        <code className="mx-1 rounded bg-[var(--bg-inset)] px-1">streaming_token_capture_mode=full</code>
        in the SDK config to capture token text.
      </div>
    );
  }

  const maxDelta = Math.max(...tokens.map((t) => t.delta_ms), 1);

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Streaming tokens
          </h3>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {tokens.length} tokens across {spanCount} span
            {spanCount === 1 ? "" : "s"} · {totalBytes.toLocaleString()} bytes ·
            p50 Δ {p50}ms
          </p>
        </div>
        {stalls > 0 && (
          <div className="flex items-center gap-1 rounded-md bg-[var(--error-bg)] px-2 py-1 text-xs text-[var(--error)]">
            <AlertTriangle className="h-4 w-4" />
            {stalls} stall{stalls === 1 ? "" : "s"}
          </div>
        )}
      </div>

      <div
        className="flex h-12 items-end gap-px"
        role="img"
        aria-label={`Streaming tokens chart: ${tokens.length} tokens, ${stalls} stall${stalls === 1 ? "" : "s"}, p50 delta ${p50} milliseconds`}
      >
        {tokens.map((t, i) => {
          const heightPct = (t.delta_ms / maxDelta) * 100;
          const isStall = p50 > 0 && t.delta_ms > 5 * p50;
          return (
            <div
              key={`${t.span_id}:${t.token_index}:${i}`}
              className={cn(
                "flex-1 rounded-sm transition-all hover:opacity-80",
                isStall ? "bg-[var(--error)]" : "bg-[var(--accent)]/60"
              )}
              style={{ height: `${Math.max(2, heightPct)}%` }}
              title={`Token ${t.token_index} · ${t.token_byte_len}B · Δ ${t.delta_ms}ms${isStall ? " (stall)" : ""}`}
            />
          );
        })}
      </div>

      {showText && (
        <div className="mt-3 flex flex-wrap gap-1 text-xs">
          {tokens.slice(0, 100).map((t, i) => (
            <span
              key={`text:${t.span_id}:${t.token_index}:${i}`}
              className={cn(
                "rounded px-1.5 py-0.5",
                t.redacted
                  ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                  : "bg-[var(--bg-inset)] text-[var(--text-primary)]"
              )}
            >
              {t.redacted ? "[REDACTED]" : t.token_text || `Δ${t.delta_ms}ms`}
            </span>
          ))}
        </div>
      )}

      {tokens.some((t) => t.finish_reason) && (
        <div className="mt-2 text-xs text-[var(--text-secondary)]">
          Finish reason:{" "}
          <span className="font-medium text-[var(--text-primary)]">
            {tokens.find((t) => t.finish_reason)?.finish_reason}
          </span>
        </div>
      )}
    </div>
  );
}
