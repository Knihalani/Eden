"use client";

import dynamic from "next/dynamic";

const ScoresTab = dynamic(
  () =>
    import("@/app/(portal)/observability/ScoresTab").then((m) => ({
      default: m.ScoresTab,
    })),
  { ssr: false },
);

export interface ScoresCanvasProps {
  orgId: string;
  traceId: string;
}

/** Thin host for existing ScoresTab. Inspector closed. */
export function ScoresCanvas({ orgId, traceId }: ScoresCanvasProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="scores-canvas">
      <ScoresTab orgId={orgId} traceId={traceId} />
    </div>
  );
}
