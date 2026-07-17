"use client";

import Link from "next/link";
import { MonitorPlay } from "lucide-react";

export interface RrwebThumbProps {
  traceId: string;
  sessionId?: string | null;
  hasReplay?: boolean;
}

/** N13 / F09 — compact RRWeb entry point from transcript chrome. */
export function RrwebThumb({ traceId, sessionId, hasReplay = true }: RrwebThumbProps) {
  const href = sessionId
    ? `/sessions/${encodeURIComponent(sessionId)}?traceId=${encodeURIComponent(traceId)}&replay=1`
    : `/traces?traceId=${encodeURIComponent(traceId)}&view=replay`;

  if (!hasReplay) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded border border-dashed border-[var(--border-default)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
        <MonitorPlay className="h-3 w-3" />
        No browser recording
      </div>
    );
  }

  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2 py-1 text-[10px] text-[var(--accent)] hover:underline"
      data-testid="rrweb-thumb"
    >
      <MonitorPlay className="h-3 w-3" />
      Browser replay
    </Link>
  );
}
