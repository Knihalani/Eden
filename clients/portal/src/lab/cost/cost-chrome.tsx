"use client";

import { StatusChip } from "@/components/ds/primitives";
import {
  budgetStatusLabel,
  driverKindLabel,
  type BudgetStatus,
  type CostDriverKind,
} from "@/lab/fixtures/cost";

export type CostMode = "spend" | "drivers";

export function parseCostMode(
  mode: string | null,
  /** Legacy `?tab=` from soft-lands / bookmarks. */
  tab: string | null = null,
): CostMode {
  if (mode === "drivers" || mode === "spend") return mode;
  if (
    tab === "drivers" ||
    tab === "outcomes" ||
    tab === "advisor" ||
    tab === "forecast"
  ) {
    return tab === "forecast" ? "spend" : "drivers";
  }
  if (tab === "budget" || tab === "spend") return "spend";
  return "spend";
}

export function CostModeNav({
  value,
  onChange,
}: {
  value: CostMode;
  onChange: (next: CostMode) => void;
}) {
  return (
    <div role="tablist" aria-label="Cost mode" className="flex gap-1">
      {(
        [
          ["spend", "Spend"],
          ["drivers", "Drivers"],
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

export function BudgetChip({ status }: { status: BudgetStatus }) {
  if (status === "unset") {
    return <StatusChip tone="neutral">{budgetStatusLabel(status)}</StatusChip>;
  }
  const tone = status === "ok" ? "ok" : "fail";
  return <StatusChip tone={tone}>{budgetStatusLabel(status)}</StatusChip>;
}

export function DriverKindChip({ kind }: { kind: CostDriverKind }) {
  return <StatusChip tone="neutral">{driverKindLabel(kind)}</StatusChip>;
}
