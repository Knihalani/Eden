"use client";

import { StatusChip } from "@/components/ds/primitives";
import {
  kindLabel,
  statusLabel,
  type ImproveKind,
  type ImproveStatus,
} from "@/lab/fixtures/improve";

export type ImproveMode = "queue" | "plan";

export function parseImproveMode(
  mode: string | null,
  hasPlanId: boolean,
): ImproveMode {
  if (mode === "plan" || mode === "queue") return mode;
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
