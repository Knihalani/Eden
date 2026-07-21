"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { traceHref } from "@/lib/portal-cross-links";
import {
  composeGradeSummary,
  deltaClassName,
  gradeChipClass,
  gradeFromDatapoint,
  overallComparisonGrade,
  sortDatapointsFailingFirst,
} from "./compare-grades";
import { outputText } from "./output-text";
import { GRADE_LABELS, type Datapoint, type ExperimentRow } from "./types";

export const WAVE_E4_COMPARE_MATRIX_UI = true;

type CompareMatrixProps = {
  datapoints: Datapoint[];
  summary: Record<string, number> | null;
  treatment: ExperimentRow | null;
  baseline: ExperimentRow | null;
  onOpenDiff: (key: string) => void;
  diffOpen: string | null;
};

/**
 * Case × run grid — Promptfoo/Braintrust energy; failing-first default.
 */
export function CompareMatrix({
  datapoints,
  summary,
  treatment,
  baseline,
  onOpenDiff,
  diffOpen,
}: CompareMatrixProps) {
  const grades = composeGradeSummary(summary, datapoints);
  const overall = overallComparisonGrade(grades);
  const sorted = sortDatapointsFailingFirst(datapoints);

  return (
    <div
      data-wave-e4-layout="grid"
      data-wave-e4-matrix="case-x-run"
      data-testid="compare-matrix"
      className="flex flex-col gap-space-3"
    >
      <div
        className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_4.5rem] gap-2 border-b border-[var(--border-subtle)] pb-2 text-xs font-medium text-[var(--text-muted)]"
        data-wave-e4-matrix="header"
        data-testid="compare-score-headers"
      >
        <span>Case</span>
        <span className="truncate" title={baseline?.name}>
          {baseline?.name ?? "Baseline"}
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate" title={treatment?.name}>
            {treatment?.name ?? "Treatment"}
          </span>
          <span
            className={cn(
              "shrink-0 rounded border px-1.5 py-1 text-[10px] font-medium capitalize",
              gradeChipClass(overall),
            )}
            data-wave-e4-grade="overall"
          >
            {GRADE_LABELS[overall]}
          </span>
        </div>
        <span className="text-right">Δ</span>
      </div>

      <div
        className="mb-1 flex flex-wrap gap-2"
        data-wave-e4-matrix="aggregates"
        data-testid="compare-grade-chips"
      >
        {(Object.keys(GRADE_LABELS) as Array<keyof typeof GRADE_LABELS>).map(
          (g) => (
            <span
              key={g}
              className={cn(
                "rounded border px-2 py-1 text-[11px]",
                gradeChipClass(g),
              )}
              data-wave-e4-grade={g}
            >
              {GRADE_LABELS[g]} {grades[g]}
            </span>
          ),
        )}
      </div>

      <ul
        className="max-h-[55vh] space-y-1.5 overflow-auto"
        data-testid="compare-datapoints"
      >
        {sorted.map((dp, idx) => {
          const key = String(dp.row_id || idx);
          const grade = gradeFromDatapoint(dp);
          const delta = Number(dp.score_delta ?? 0);
          const controlScore =
            dp.control_score != null ? Number(dp.control_score) : null;
          const treatmentScore =
            dp.treatment_score != null
              ? Number(dp.treatment_score)
              : controlScore != null
                ? controlScore + delta
                : null;
          const failing = grade === "regress" || delta < -0.001;
          return (
            <li
              key={key}
              data-wave-e4-matrix-row={key}
              data-failing={failing ? "true" : "false"}
              className={cn(
                "grid grid-cols-1 gap-1 rounded border border-[var(--border-default)] p-2 text-xs sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_4.5rem] sm:items-center sm:gap-2",
                failing && "border-[var(--error)]/30",
              )}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "rounded border px-1.5 py-1 text-[10px] font-medium",
                    gradeChipClass(grade),
                  )}
                  data-wave-e4-grade="cell"
                >
                  {GRADE_LABELS[grade]}
                </span>
                <span className="truncate text-[var(--text-muted)]">
                  {dp.row_id
                    ? String(dp.row_id).slice(0, 12)
                    : `row ${idx + 1}`}
                </span>
                {dp.trace_id ? (
                  <Link
                    href={traceHref(dp.trace_id)}
                    className="text-[var(--accent)] hover:underline"
                  >
                    Trace
                  </Link>
                ) : null}
                <button
                  type="button"
                  className="text-[var(--accent)] hover:underline"
                  data-wave-e4-diff="open"
                  onClick={() => onOpenDiff(diffOpen === key ? "" : key)}
                >
                  Diff
                </button>
              </div>
              <span className="font-mono tabular-nums text-[var(--text-secondary)]">
                {controlScore != null ? controlScore.toFixed(3) : "—"}
                <span className="mt-0.5 block truncate text-[10px] text-[var(--text-faint)]">
                  {outputText(dp.control_output).slice(0, 48) || "—"}
                </span>
              </span>
              <span className="font-mono tabular-nums text-[var(--text-secondary)]">
                {treatmentScore != null ? treatmentScore.toFixed(3) : "—"}
                <span className="mt-0.5 block truncate text-[10px] text-[var(--text-faint)]">
                  {outputText(dp.treatment_output).slice(0, 48) || "—"}
                </span>
              </span>
              <span
                className={cn(
                  "font-mono text-right tabular-nums",
                  deltaClassName(delta),
                )}
                data-wave-e4-delta={
                  delta > 0.001 ? "up" : delta < -0.001 ? "down" : "flat"
                }
              >
                {delta > 0 ? "+" : ""}
                {delta.toFixed(3)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
