"use client";

/**
 * N13 TranscriptV2 orchestrator — progressive VirtualizedTranscript + parallel swimlanes + j/k.
 */

import * as React from "react";
import { TranscriptView, type TranscriptViewProps } from "@/components/observability/TranscriptView";
import { ParallelToolLane } from "./ParallelToolLane";
import { RrwebThumb } from "./RrwebThumb";
import { useParallelGroups } from "./hooks/useParallelGroups";
import { useTranscriptKeyboard } from "./hooks/useTranscriptKeyboard";
import type { TranscriptRow } from "@/lib/observability/types";

const INITIAL_BATCH = 30;
const BATCH_SIZE = 25;

export interface TranscriptV2Props extends TranscriptViewProps {
  virtualize?: boolean;
  sessionId?: string | null;
  showRrwebThumb?: boolean;
  /** When set, swimlane selection highlights this span. */
  highlightSpanId?: string | null;
  onSpanSelect?: (spanId: string) => void;
}

function flattenSpanIds(rows: TranscriptRow[]): string[] {
  const out: string[] = [];
  const walk = (rs: TranscriptRow[]) => {
    for (const r of rs) {
      out.push(r.span_id);
      if (r.children?.length) walk(r.children);
    }
  };
  walk(rows);
  return out;
}

export function TranscriptV2({
  rows,
  virtualize = true,
  sessionId,
  showRrwebThumb = true,
  highlightSpanId,
  onSpanSelect,
  ...rest
}: TranscriptV2Props) {
  const [visibleCount, setVisibleCount] = React.useState(
    virtualize ? Math.min(INITIAL_BATCH, rows.length) : rows.length,
  );
  const [selectedSpanId, setSelectedSpanId] = React.useState<string | null>(
    highlightSpanId ?? rows[0]?.span_id ?? null,
  );
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    setVisibleCount(virtualize ? Math.min(INITIAL_BATCH, rows.length) : rows.length);
  }, [rows, virtualize]);

  React.useEffect(() => {
    if (highlightSpanId) setSelectedSpanId(highlightSpanId);
  }, [highlightSpanId]);

  React.useEffect(() => {
    if (!virtualize || visibleCount >= rows.length) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => Math.min(c + BATCH_SIZE, rows.length));
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [virtualize, visibleCount, rows.length]);

  const slice = rows.slice(0, visibleCount);

  React.useEffect(() => {
    if (!highlightSpanId) return;
    const el = document.querySelector(
      `[data-span-id="${CSS.escape(highlightSpanId)}"]`,
    );
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [highlightSpanId, slice.length]);

  const blocks = useParallelGroups(slice);
  const flatIds = React.useMemo(() => flattenSpanIds(slice), [slice]);

  const handleSelect = React.useCallback(
    (spanId: string) => {
      setSelectedSpanId(spanId);
      onSpanSelect?.(spanId);
    },
    [onSpanSelect],
  );

  useTranscriptKeyboard({
    spanIds: flatIds,
    selectedSpanId,
    onSelect: handleSelect,
  });

  const parallelBlocks = blocks.filter((b) => b.type === "parallel_tools");

  return (
    <div className="relative space-y-space-2" data-testid="transcript-v2">
      {showRrwebThumb && (
        <div className="flex items-center justify-end px-space-1">
          <RrwebThumb traceId={rest.traceId} sessionId={sessionId} />
        </div>
      )}

      {parallelBlocks.length > 0 && (
        <div className="space-y-space-2 px-space-1">
          {parallelBlocks.map((b) =>
            b.type === "parallel_tools" ? (
              <ParallelToolLane
                key={`lane-${b.step_index}`}
                lanes={b.lanes}
                selectedSpanId={selectedSpanId}
                onSelect={handleSelect}
                orgId={rest.orgId}
                traceId={rest.traceId}
              />
            ) : null,
          )}
        </div>
      )}

      <TranscriptView {...rest} rows={slice} />

      {virtualize && visibleCount < rows.length && (
        <div
          ref={sentinelRef}
          className="h-8 flex items-center justify-center text-xs text-[var(--text-muted)]"
          aria-hidden
        >
          Loading more steps… ({visibleCount}/{rows.length})
        </div>
      )}
    </div>
  );
}
