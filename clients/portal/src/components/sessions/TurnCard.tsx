"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { traceHref, type TracePreserveParams } from "@/lib/portal-cross-links";

export interface TurnCardProps {
  index: number;
  total: number;
  traceId: string;
  /** @deprecated Prefer inputPreview / outputPreview. */
  summary?: string;
  inputPreview?: string | null;
  outputPreview?: string | null;
  durationMs?: number;
  costCents?: number | null;
  outcome?: string | null;
  hadStumble?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  /** When set, "Open trace" deep-links with this view (default traces). */
  openTraceView?: "traces" | "sessions";
  /** Preserve hub filters (pastHours, realm, …) on Open-trace deep links. */
  preserve?: TracePreserveParams;
  className?: string;
}

export function TurnCard({
  index,
  total,
  traceId,
  summary,
  inputPreview,
  outputPreview,
  durationMs,
  costCents,
  outcome,
  hadStumble,
  selected,
  onSelect,
  openTraceView = "traces",
  preserve,
  className,
}: TurnCardProps) {
  const inputText =
    inputPreview?.trim() || summary?.trim() || `Trace ${traceId.slice(0, 8)}…`;
  const outputText = outputPreview?.trim() || "—";
  const openHref = traceHref(
    traceId,
    { ...preserve, view: openTraceView },
  );

  return (
    <article
      className={cn(
        "shrink-0 w-72 rounded-xl border p-3 transition-colors cursor-pointer",
        selected
          ? "border-[var(--accent)] bg-[var(--accent-faint)]"
          : "border-[var(--border-default)] bg-[var(--bg-primary)] hover:border-[var(--accent)]",
        className,
      )}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      data-testid={`turn-card-${index}`}
      aria-label={`Turn ${index + 1} of ${total}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect?.();
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-2xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Turn {index + 1}/{total}
        </span>
        {hadStumble && (
          <span className="text-2xs px-1.5 py-0.5 rounded bg-[var(--warning-bg)] text-[var(--warning)]">
            Stumble
          </span>
        )}
      </div>

      <div className="space-y-2 mb-2">
        <div>
          <p className="text-2xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Input
          </p>
          <p
            className="text-xs text-[var(--text-secondary)] line-clamp-2 min-h-[2rem]"
            data-testid="turn-input-preview"
            title={inputText}
          >
            {inputText}
          </p>
        </div>
        <div>
          <p className="text-2xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Output
          </p>
          <p
            className="text-xs text-[var(--text-secondary)] line-clamp-2 min-h-[2rem]"
            data-testid="turn-output-preview"
            title={outputText === "—" ? undefined : outputText}
          >
            {outputText}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-2xs text-[var(--text-muted)]">
        {durationMs != null && <span>{durationMs.toFixed(0)}ms</span>}
        {costCents != null && (
          <span className="font-mono">${(costCents / 100).toFixed(2)}</span>
        )}
        {outcome && <span className="capitalize">{outcome}</span>}
      </div>
      <Link
        href={openHref}
        className="mt-2 inline-block text-2xs text-[var(--accent)] hover:underline font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        Open trace
      </Link>
    </article>
  );
}
