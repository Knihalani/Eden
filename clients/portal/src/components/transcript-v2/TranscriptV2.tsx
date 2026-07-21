"use client";

import * as React from "react";
import {
  TranscriptReader,
  type TranscriptViewProps,
} from "./TranscriptReader";
import { ParallelToolLane } from "./ParallelToolLane";
import { RrwebThumb } from "./RrwebThumb";
import { useParallelGroups } from "./hooks/useParallelGroups";
import { useTranscriptKeyboard } from "./hooks/useTranscriptKeyboard";
import { TranscriptRowItem } from "./TranscriptRowItem";
import {
  TRANSCRIPT_ROW_ESTIMATE,
  TRANSCRIPT_ROW_ESTIMATE_EXPANDED,
  VirtualTranscript,
} from "./VirtualTranscript";
import { classifySpanKind } from "./span-kind";
import { isInternalFrameworkSpan } from "@/lib/observability/elide";
import type { TranscriptRow } from "@/lib/observability/types";
import {
  SpanDetailSidebar,
  findRowBySpanId,
} from "./transcript-reader-chrome";

export interface TranscriptV2Props extends TranscriptViewProps {
  virtualize?: boolean;
  sessionId?: string | null;
  showRrwebThumb?: boolean;
  highlightSpanId?: string | null;
  /** Write-back selected span (e.g. `?spanId=`). Pass null/empty to clear. */
  onSpanSelect?: (spanId: string | null) => void;
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

function filterInternal(rows: TranscriptRow[]): TranscriptRow[] {
  const walk = (rs: TranscriptRow[]): TranscriptRow[] => {
    const out: TranscriptRow[] = [];
    for (const r of rs) {
      if (isInternalFrameworkSpan(r.name)) continue;
      const child = r.children ? walk(r.children) : undefined;
      out.push({ ...r, children: child });
    }
    return out;
  };
  return walk(rows);
}

export function TranscriptV2({
  rows,
  virtualize = true,
  sessionId,
  showRrwebThumb = true,
  highlightSpanId,
  onSpanSelect,
  hideSummary: _hideSummary,
  virtualizeList: _virtualizeList,
  ...rest
}: TranscriptV2Props) {
  const visibleRows = React.useMemo(() => filterInternal(rows), [rows]);

  const [selectedSpanId, setSelectedSpanId] = React.useState<string | null>(
    highlightSpanId ?? visibleRows[0]?.span_id ?? rows[0]?.span_id ?? null,
  );
  /** Inspector closed until explicit selection or URL `spanId`. */
  const [inspectorSpanId, setInspectorSpanId] = React.useState<string | null>(
    highlightSpanId ?? null,
  );

  React.useEffect(() => {
    if (highlightSpanId) {
      setSelectedSpanId(highlightSpanId);
      setInspectorSpanId(highlightSpanId);
    } else {
      setInspectorSpanId(null);
    }
  }, [highlightSpanId]);

  React.useEffect(() => {
    if (!highlightSpanId) return;
    const el = document.querySelector(
      `[data-span-id="${CSS.escape(highlightSpanId)}"]`,
    );
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [highlightSpanId, visibleRows.length]);

  const blocks = useParallelGroups(visibleRows);
  const flatIds = React.useMemo(() => flattenSpanIds(visibleRows), [visibleRows]);

  const handleSelect = React.useCallback(
    (spanId: string) => {
      setSelectedSpanId(spanId);
      setInspectorSpanId(spanId);
      onSpanSelect?.(spanId);
    },
    [onSpanSelect],
  );

  const handleCloseInspector = React.useCallback(() => {
    setInspectorSpanId(null);
    onSpanSelect?.(null);
  }, [onSpanSelect]);

  useTranscriptKeyboard({
    spanIds: flatIds,
    selectedSpanId,
    onSelect: handleSelect,
  });

  const parallelBlocks = blocks.filter((b) => b.type === "parallel_tools");
  const inspectorRow = React.useMemo(
    () => findRowBySpanId(visibleRows, inspectorSpanId),
    [visibleRows, inspectorSpanId],
  );

  const virtualItems = React.useMemo(() => {
    if (!virtualize) return [];
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
            onSelect={handleSelect}
            orgId={rest.orgId}
            traceId={rest.traceId}
            depth={0}
          />
        ),
      };
    });
  }, [virtualize, visibleRows, selectedSpanId, handleSelect, rest.orgId, rest.traceId]);

  return (
    <div
      className="relative flex min-h-0 gap-0 outline-none"
      data-testid="transcript-v2"
      tabIndex={0}
      aria-label="Transcript — j/k to step spans"
    >
      <div className="min-w-0 flex-1 space-y-space-2">
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

        {virtualize ? (
          <div className="h-[min(70vh,720px)] min-h-[240px]">
            <VirtualTranscript items={virtualItems} className="p-space-2" />
          </div>
        ) : (
          <TranscriptReader {...rest} rows={rows} hideSummary />
        )}
      </div>
      {inspectorRow ? (
        <SpanDetailSidebar
          row={inspectorRow}
          orgId={rest.orgId}
          onClose={handleCloseInspector}
        />
      ) : null}
    </div>
  );
}
