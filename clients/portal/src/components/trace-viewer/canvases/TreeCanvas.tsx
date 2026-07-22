"use client";

import type { TranscriptRow } from "@/lib/observability/types";
import { TraceTreeView } from "@/components/traces/trace-detail-views";

export interface TreeCanvasProps {
  roots: TranscriptRow[];
  selectedSpanId: string | null;
  onSpanSelect: (spanId: string) => void;
}

/** Virtualized hierarchy with metrics — reuses TraceTreeView quiet filter. */
export function TreeCanvas({ roots, selectedSpanId, onSpanSelect }: TreeCanvasProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="tree-canvas">
      <TraceTreeView
        roots={roots}
        selectedSpanId={selectedSpanId}
        onSpanSelect={onSpanSelect}
      />
    </div>
  );
}
