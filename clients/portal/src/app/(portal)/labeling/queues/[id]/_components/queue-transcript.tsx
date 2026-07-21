"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { BoardItem } from "./use-labeling-queue";

type Props = {
  loading: boolean;
  queueLength: number;
  active: BoardItem | null;
  transcript: string;
};

export function QueueTranscript({ loading, queueLength, active, transcript }: Props) {
  return (
    <div className="min-h-[280px] border border-[var(--border-subtle)] p-space-4">
      <h3 className="mb-2 text-sm font-medium">Transcript</h3>
      {loading && queueLength === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">Loading board…</p>
      ) : active ? (
        <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap text-sm text-[var(--text-secondary)]">
          {transcript || "(empty)"}
        </pre>
      ) : (
        <div className="space-y-2 text-sm text-[var(--text-muted)]">
          <p>Queue empty — seed items from the labeling list, then open this board again.</p>
          <Button asChild size="sm" variant="outline" className="h-8 max-md:min-h-11">
            <Link href="/evals?tab=labeling">Back to labeling · seed item</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
