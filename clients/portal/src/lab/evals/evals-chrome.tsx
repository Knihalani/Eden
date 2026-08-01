"use client";

import { StatusChip } from "@/components/ds/primitives";
import type { CompareGrade } from "@/lab/fixtures/evals";
import { formatDelta } from "@/lab/fixtures/evals";
import { cn } from "@/lib/utils";

export function gradeLabel(grade: CompareGrade): string {
  if (grade === "improve") return "better";
  if (grade === "regress") return "worse";
  if (grade === "tradeoff") return "mixed";
  return "same";
}

export function CompareGradeChip({ grade }: { grade: CompareGrade }) {
  const tone =
    grade === "improve" ? "ok" : grade === "regress" ? "fail" : "neutral";
  return <StatusChip tone={tone}>{gradeLabel(grade)}</StatusChip>;
}

export function Delta({
  value,
  invertGood,
  suffix = "",
}: {
  value: number;
  invertGood?: boolean;
  suffix?: string;
}) {
  const good = invertGood ? value < -0.0001 : value > 0.0001;
  const bad = invertGood ? value > 0.0001 : value < -0.0001;
  return (
    <span
      className={cn(
        "type-mono tabular-nums !text-[0.6875rem]",
        good && "!text-[var(--success)]",
        bad && "!text-[var(--error)]",
        !good && !bad && "!text-[var(--text-muted)]",
      )}
    >
      {formatDelta(value)}
      {suffix}
    </span>
  );
}

export type EvalsMode = "compare" | "datasets" | "playground";

export function parseEvalsMode(tab: string | null, mode: string | null): EvalsMode {
  if (mode === "datasets" || mode === "playground" || mode === "compare") {
    return mode;
  }
  if (tab === "datasets") return "datasets";
  if (tab === "playgrounds" || tab === "playground" || tab === "studio") {
    return "playground";
  }
  if (tab === "experiments" || tab === "eval" || tab === "synthetic") {
    return "compare";
  }
  // Labeling is not a live mode — land on Datasets (closest Evaluate surface).
  if (tab === "labeling") return "datasets";
  return "compare";
}

export function EvalsModeNav({
  value,
  onChange,
}: {
  value: EvalsMode;
  onChange: (next: EvalsMode) => void;
}) {
  return (
    <div role="tablist" aria-label="Evals mode" className="flex gap-1">
      {(
        [
          ["compare", "Results"],
          ["datasets", "Datasets"],
          ["playground", "Try"],
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
