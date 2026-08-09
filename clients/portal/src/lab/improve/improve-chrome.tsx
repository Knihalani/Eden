"use client";

import { StatusChip } from "@/components/ds/primitives";
import {
  kindLabel,
  statusLabel,
  type ImproveKind,
  type ImproveStatus,
} from "@/lab/fixtures/improve";
import { autonomyTierChipLabel } from "@/lib/autonomy-tier";
import { cn } from "@/lib/utils";

export type ImproveMode = "queue" | "plan";

export function parseImproveMode(
  mode: string | null,
  hasPlanId: boolean,
  /** Legacy `?tab=` deep-links from next.config / citations. */
  tab: string | null = null,
): ImproveMode {
  if (mode === "plan" || mode === "queue") return mode;
  // Legacy tabs that never shipped as modes → sensible Improve leaf.
  if (
    tab === "plans" ||
    tab === "plan" ||
    tab === "history" ||
    tab === "ledger" ||
    tab === "promotions"
  ) {
    return tab === "plans" || tab === "plan" ? "plan" : "queue";
  }
  if (tab === "artifacts" || tab === "queue") return "queue";
  if (hasPlanId) return "plan";
  return "queue";
}

export function ImproveStatusChip({ status }: { status: ImproveStatus }) {
  const tone =
    status === "done"
      ? "ok"
      : status === "needs_you" || status === "blocked"
        ? "fail"
        : "neutral";
  return <StatusChip tone={tone}>{statusLabel(status)}</StatusChip>;
}

export function ImproveKindChip({ kind }: { kind: ImproveKind }) {
  return <StatusChip tone="neutral">{kindLabel(kind)}</StatusChip>;
}

export function AutonomyTierChip({
  tierApplied,
  className,
}: {
  tierApplied?: string | null;
  className?: string;
}) {
  const label = autonomyTierChipLabel(tierApplied);
  if (!label) return null;
  const level = label.replace("Autonomy T", "");
  const tone =
    level === "4" ? "fail" : level === "3" ? "neutral" : "ok";
  return (
    <span className={cn(className)}>
      <StatusChip tone={tone}>{label}</StatusChip>
    </span>
  );
}

export function ImproveModeNav({
  value,
  onChange,
}: {
  value: ImproveMode;
  onChange: (next: ImproveMode) => void;
}) {
  return (
    <div role="tablist" aria-label="Improve mode" className="flex gap-1">
      {(
        [
          ["queue", "Queue"],
          ["plan", "Plan"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          className="ds-tab"
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
