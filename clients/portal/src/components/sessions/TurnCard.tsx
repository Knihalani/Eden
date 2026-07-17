"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

export interface TurnCardProps {
  index: number;
  total: number;
  traceId: string;
  summary?: string;
  durationMs?: number;
  costCents?: number | null;
  outcome?: string | null;
  hadStumble?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}

export function TurnCard({
  index,
  total,
  traceId,
  summary,
  durationMs,
  costCents,
  outcome,
  hadStumble,
  selected,
  onSelect,
}: TurnCardProps) {
  return (
    <article
      className={cn(
        "shrink-0 w-64 rounded-xl border p-3 transition-colors cursor-pointer",
        selected
          ? "border-[var(--accent)] bg-[var(--accent-faint)]"
          : "border-[var(--border-default)] bg-[var(--bg-primary)] hover:border-[var(--accent)]",
      )}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect?.();
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Turn {index + 1}/{total}
        </span>
        {hadStumble && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--warning-bg)] text-[var(--warning)]">
            Stumble
          </span>
        )}
      </div>
      <p className="text-xs text-[var(--text-secondary)] line-clamp-3 min-h-[2.5rem] mb-2">
        {summary ?? `Trace ${traceId.slice(0, 8)}…`}
      </p>
      <div className="flex flex-wrap gap-2 text-[10px] text-[var(--text-muted)]">
        {durationMs != null && <span>{durationMs.toFixed(0)}ms</span>}
        {costCents != null && (
          <span className="font-mono">${(costCents / 100).toFixed(2)}</span>
        )}
        {outcome && <span className="capitalize">{outcome}</span>}
      </div>
      <Link
        href={`/traces?traceId=${encodeURIComponent(traceId)}&view=traces`}
        className="mt-2 inline-block text-[10px] text-[var(--accent)] hover:underline font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        Open trace
      </Link>
    </article>
  );
}
