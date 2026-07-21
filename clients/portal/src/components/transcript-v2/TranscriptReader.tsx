"use client";

import * as React from "react";
import { Copy } from "lucide-react";
import { isInternalFrameworkSpan } from "@/lib/observability/elide";
import type { TranscriptRow as TR } from "@/lib/observability/types";
import { TranscriptRowItem } from "./TranscriptRowItem";
import {
  TRANSCRIPT_ROW_ESTIMATE,
  TRANSCRIPT_ROW_ESTIMATE_EXPANDED,
  VirtualTranscript,
} from "./VirtualTranscript";
import { classifySpanKind } from "./span-kind";
import {
  SummaryCard,
  SpanDetailSidebar,
  findRowBySpanId,
  flattenSpanIds,
} from "./transcript-reader-chrome";

export { formatDuration } from "./transcript-format";

export interface TranscriptViewProps {
  traceId: string;
  rows: TR[];
  totalDurationMs: number;
  totalCost?: number;
  totalTokens?: { input: number; output: number; total: number };
  model?: string;
  outcome?: "success" | "failure" | "partial" | "timeout" | "crash" | null;
  spanCount: number;
  orgId?: string;
  hideSummary?: boolean;
  virtualizeList?: boolean;
}

export function TranscriptReader({
  traceId,
  rows,
  totalDurationMs,
  totalCost,
  totalTokens,
  model,
  outcome,
  spanCount,
  orgId,
  hideSummary = false,
  virtualizeList = false,
}: TranscriptViewProps) {
  const [selectedSpanId, setSelectedSpanId] = React.useState<string | null>(
    rows[0]?.span_id || null,
  );
  const [showInternal, setShowInternal] = React.useState(false);

  const { visibleRows, internalCount } = React.useMemo(() => {
    let count = 0;
    const walk = (rs: TR[]): TR[] => {
      const out: TR[] = [];
      for (const r of rs) {
        if (isInternalFrameworkSpan(r.name) && !showInternal) {
          count++;
          continue;
        }
        const child = r.children ? walk(r.children) : undefined;
        out.push({ ...r, children: child });
      }
      return out;
    };
    const filtered = walk(rows);
    return { visibleRows: filtered, internalCount: count };
  }, [rows, showInternal]);

  const selectedRow = React.useMemo(
    () => findRowBySpanId(visibleRows, selectedSpanId),
    [visibleRows, selectedSpanId],
  );

  const flatSpanIds = React.useMemo(() => flattenSpanIds(visibleRows), [visibleRows]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const down = e.key === "ArrowDown" || e.key === "j";
      const up = e.key === "ArrowUp" || e.key === "k";
      if (!down && !up) return;
      if (flatSpanIds.length === 0) return;
      e.preventDefault();
      const idx = selectedSpanId ? flatSpanIds.indexOf(selectedSpanId) : -1;
      const next = down
        ? flatSpanIds[Math.min(idx + 1, flatSpanIds.length - 1)]
        : flatSpanIds[Math.max(idx - 1, 0)];
      if (next) setSelectedSpanId(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flatSpanIds, selectedSpanId]);

  const copyTraceSummary = React.useCallback(async () => {
    const summary = [
      `trace=${traceId}`,
      `spans=${spanCount}`,
      `duration_ms=${totalDurationMs}`,
      outcome ? `outcome=${outcome}` : null,
      model ? `model=${model}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    try {
      await navigator.clipboard.writeText(summary);
    } catch {
      // ignore
    }
  }, [traceId, spanCount, totalDurationMs, outcome, model]);

  const virtualItems = React.useMemo(() => {
    if (!virtualizeList) return [];
    return visibleRows.map((row) => {
      const isSub =
        classifySpanKind(row) === "subagent" ||
        !!row.is_subagent ||
        (row.children?.length ?? 0) > 0;
      return {
        key: row.span_id,
        estimate: isSub ? TRANSCRIPT_ROW_ESTIMATE_EXPANDED : TRANSCRIPT_ROW_ESTIMATE,
        sticky: isSub,
        content: (
          <TranscriptRowItem
            row={row}
            selectedSpanId={selectedSpanId}
            onSelect={setSelectedSpanId}
            orgId={orgId}
            traceId={traceId}
            depth={0}
          />
        ),
      };
    });
  }, [virtualizeList, visibleRows, selectedSpanId, orgId, traceId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!hideSummary && (
        <SummaryCard
          durationMs={totalDurationMs}
          spanCount={spanCount}
          outcome={outcome}
          model={model}
          totalCost={totalCost}
          totalTokens={totalTokens}
        />
      )}

      <div className="flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-4 py-space-2 text-xs gap-space-2">
        <span className="text-[var(--text-muted)]">
          {visibleRows.length} step{visibleRows.length === 1 ? "" : "s"}
          {internalCount > 0 ? ` · ${internalCount} internal hidden` : ""}
        </span>
        <div className="flex items-center gap-space-3">
          {internalCount > 0 && (
            <button
              type="button"
              onClick={() => setShowInternal((v) => !v)}
              className="text-[var(--accent)] hover:underline min-h-[44px] px-space-1"
            >
              {showInternal ? "Hide internal" : "Show internal"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void copyTraceSummary()}
            className="inline-flex items-center gap-space-1 text-[var(--accent)] hover:underline min-h-[44px] px-space-1"
            title="Copy trace summary"
          >
            <Copy className="h-3 w-3" /> Copy summary
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {visibleRows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
              No spans to display
            </div>
          ) : virtualizeList ? (
            <VirtualTranscript items={virtualItems} className="p-space-2" />
          ) : (
            <div className="space-y-space-1 p-space-2">
              {visibleRows.map((row) => (
                <TranscriptRowItem
                  key={row.span_id}
                  row={row}
                  selectedSpanId={selectedSpanId}
                  onSelect={setSelectedSpanId}
                  orgId={orgId}
                  traceId={traceId}
                  depth={0}
                />
              ))}
            </div>
          )}
        </div>
        {selectedRow && <SpanDetailSidebar row={selectedRow} orgId={orgId} />}
      </div>
    </div>
  );
}

export const TranscriptView = TranscriptReader;
