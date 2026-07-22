"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { CompareGradeHeader } from "@/components/evals/compare-grade-header";
import { ExperimentDiffToggle } from "@/components/evals/experiment-diff-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deltaClassName,
  GRADE_LABELS,
  gradeChipClass,
  gradeFromDatapoint,
  overallComparisonGrade,
  composeGradeSummary,
  type ComparisonGrade,
} from "@/lib/compare-grades";
import { EVALS_COMPARE_LAYOUTS, type EvalsCompareLayout } from "@/lib/evals-url";
import { cn } from "@/lib/utils";
import type { ExperimentsTabState } from "../_hooks/use-experiments-tab";

export type ExperimentComparePanelProps = {
  tab: ExperimentsTabState;
  canMutate: boolean;
};

function outputPreview(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value.slice(0, 160);
  try {
    return JSON.stringify(value).slice(0, 160);
  } catch {
    return String(value);
  }
}

const GRADE_FILTERS: Array<ComparisonGrade | "all"> = [
  "all",
  "improve",
  "regress",
  "tradeoff",
  "tie",
];

export function ExperimentComparePanel({
  tab,
  canMutate: _canMutate,
}: ExperimentComparePanelProps) {
  const t = useTranslations("evals");
  const {
    experiments,
    baselineId,
    compareId,
    layout,
    diffOn,
    gradeFilter,
    summary,
    gradedDatapoints,
    datapoints,
    baselineCandidates,
    setBaseline,
    setCompare,
    setLayout,
    setDiff,
    setGrade,
  } = tab;

  const grades = composeGradeSummary(summary, datapoints);
  const overall = overallComparisonGrade(grades);
  const showImproveExit = overall === "regress" || overall === "tradeoff";

  const improveHref = `/improve?experimentId=${encodeURIComponent(
    compareId ?? "",
  )}&baselineId=${encodeURIComponent(baselineId ?? "")}`;

  return (
    <div className="space-y-4" data-testid="experiment-compare-panel">
      <div className="flex flex-wrap items-end gap-2" data-testid="compare-toolbar">
        <div className="min-w-[9rem]">
          <label className="mb-1 block text-xs text-[var(--text-muted)]">
            {t("compare.baseline")}
          </label>
          <Select
            value={baselineId ?? "__none__"}
            onValueChange={(v) =>
              setBaseline(v === "__none__" ? undefined : v)
            }
          >
            <SelectTrigger aria-label={t("compare.baseline")}>
              <SelectValue placeholder={t("compare.baselinePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">
                {t("compare.baselineNone")}
              </SelectItem>
              {baselineCandidates.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-[9rem]">
          <label className="mb-1 block text-xs text-[var(--text-muted)]">
            {t("compare.compare")}
          </label>
          <Select
            value={compareId ?? ""}
            onValueChange={(v) => setCompare(v || undefined)}
          >
            <SelectTrigger aria-label={t("compare.compare")}>
              <SelectValue placeholder={t("compare.comparePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {experiments.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap gap-1" role="group" aria-label={t("compare.layoutLabel")}>
          {EVALS_COMPARE_LAYOUTS.map((opt) => (
            <Button
              key={opt}
              type="button"
              size="sm"
              variant={layout === opt ? "default" : "secondary"}
              className="min-h-11 capitalize"
              onClick={() => setLayout(opt as EvalsCompareLayout)}
            >
              {t(`compare.layout.${opt}`)}
            </Button>
          ))}
        </div>

        <ExperimentDiffToggle
          checked={diffOn}
          onChange={setDiff}
          disabled={!baselineId}
        />
      </div>

      {!baselineId ? (
        <Panel tone="flat" padding="sm">
          <p className="m-0 text-sm text-[var(--text-secondary)]">
            {t("compare.needBaseline")}
          </p>
        </Panel>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {GRADE_FILTERS.map((g) => {
          const active =
            g === "all" ? !gradeFilter : gradeFilter === g;
          return (
            <button
              key={g}
              type="button"
              className={cn(
                "min-h-11 rounded-md border px-2.5 text-xs font-medium",
                active
                  ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--accent)]"
                  : "border-[var(--border-default)] text-[var(--text-muted)]",
              )}
              onClick={() => setGrade(g === "all" ? undefined : g)}
            >
              {g === "all" ? t("compare.gradeAll") : GRADE_LABELS[g]}
            </button>
          );
        })}
      </div>

      <CompareGradeHeader summary={summary} datapoints={datapoints} />

      {showImproveExit ? (
        <Button asChild size="sm" className="min-h-11">
          <Link href={improveHref}>{t("compare.openImprove")}</Link>
        </Button>
      ) : null}

      {layout === "summary" ? (
        <div
          className="grid grid-cols-2 gap-2 md:grid-cols-4"
          data-testid="compare-summary-layout"
        >
          {(Object.keys(GRADE_LABELS) as ComparisonGrade[]).map((g) => (
            <Panel key={g} tone="flat" padding="md" className={gradeChipClass(g)}>
              <div className="text-xs opacity-80">{GRADE_LABELS[g]}</div>
              <div className="text-lg font-semibold text-[var(--text-primary)]">
                {grades[g]}
              </div>
            </Panel>
          ))}
        </div>
      ) : null}

      {(layout === "list" || layout === "grid" || layout === "summary") && (
        <ul
          className={cn(
            layout === "grid"
              ? "grid gap-2 sm:grid-cols-2"
              : "space-y-2",
            layout === "summary" && "mt-2",
          )}
          data-testid="compare-datapoints"
        >
          {gradedDatapoints.map((dp, idx) => {
            const g = gradeFromDatapoint(dp);
            const delta = Number(dp.score_delta ?? 0);
            const key = dp.row_id ?? String(idx);
            return (
              <li
                key={key}
                className="rounded-md border border-[var(--border-subtle)] p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn("rounded-md", gradeChipClass(g))}
                  >
                    {GRADE_LABELS[g]}
                  </Badge>
                  <span className={cn("text-sm font-medium", deltaClassName(delta))}>
                    Δ {delta > 0 ? "+" : ""}
                    {delta.toFixed(3)}
                  </span>
                  {dp.trace_id ? (
                    <Link
                      href={`/traces?traceId=${encodeURIComponent(dp.trace_id)}&mode=scores`}
                      className="text-xs text-[var(--accent)] underline-offset-2 hover:underline"
                    >
                      {t("case.sourceTrace")}
                    </Link>
                  ) : null}
                  {g === "regress" ? (
                    <Link
                      href={improveHref}
                      className="text-xs text-[var(--error)] underline-offset-2 hover:underline"
                    >
                      {t("compare.regressImprove")}
                    </Link>
                  ) : null}
                </div>
                <p className="mt-2 m-0 text-sm text-[var(--text-primary)]">
                  {outputPreview(dp.input_data)}
                </p>
                {diffOn ? (
                  <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                    <div>
                      <span className="text-[var(--text-muted)]">
                        {t("compare.baselineOut")}:{" "}
                      </span>
                      {outputPreview(dp.control_output)}
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">
                        {t("compare.treatmentOut")}:{" "}
                      </span>
                      {outputPreview(dp.treatment_output)}
                    </div>
                  </div>
                ) : null}
                <div className="mt-1 flex gap-3 text-xs text-[var(--text-muted)]">
                  <span>
                    {t("compare.baselineScore")}:{" "}
                    {dp.control_score?.toFixed?.(3) ?? "—"}
                  </span>
                  <span>
                    {t("compare.treatmentScore")}:{" "}
                    {dp.treatment_score?.toFixed?.(3) ?? "—"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {gradedDatapoints.length === 0 ? (
        <p className="m-0 text-sm text-[var(--text-muted)]">
          {t("compare.noCases")}
        </p>
      ) : null}
    </div>
  );
}
