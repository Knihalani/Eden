"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { DetailPanelShell } from "@/components/portal-os";
import { charDiff } from "@/lib/char-diff";
import { cn } from "@/lib/utils";
import {
  datasetHref,
  issueHref,
  playgroundHref,
  traceHref,
} from "@/lib/portal-cross-links";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CompareMatrix } from "./compare-matrix";
import {
  composeGradeSummary,
  deltaClassName,
  filterFailingOrRegressedDatapoints,
  gradeChipClass,
  gradeFromDatapoint,
  overallComparisonGrade,
  sortDatapointsFailingFirst,
} from "./compare-grades";
import { outputText } from "./output-text";
import {
  COMPARE_LAYOUTS,
  GRADE_LABELS,
  type CompareLayout,
  type CompareMeta,
  type Datapoint,
  type DiffMode,
  type ExperimentRow,
} from "./types";

type ComparePanelProps = {
  selectedRow: ExperimentRow | null;
  baselineRow: ExperimentRow | null;
  effectiveBaselineId?: string;
  baselineCandidates: ExperimentRow[];
  summary: Record<string, number> | null;
  datapoints: Datapoint[];
  compareMeta: CompareMeta | null;
  summaryLoading: boolean;
  compareError: string | null;
  layout: CompareLayout;
  diffMode: DiffMode;
  failuresOnly: boolean;
  diffOpen: string | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onSetBaseline: (id: string | undefined) => void;
  onSetLayout: (layout: CompareLayout) => void;
  onSetDiffMode: (mode: DiffMode) => void;
  onSetFailuresOnly: (next: boolean) => void;
  onSetDiffOpen: (key: string | null) => void;
  onRetryCompare: () => void;
};

function DiffSidePanel({
  datapoint,
  diffMode,
  onClose,
}: {
  datapoint: Datapoint;
  diffMode: DiffMode;
  onClose: () => void;
}) {
  const left =
    diffMode === "expected-output"
      ? outputText(datapoint.expected_output ?? datapoint.input_data)
      : outputText(datapoint.control_output);
  const right = outputText(datapoint.treatment_output);
  const leftLabel =
    diffMode === "expected-output" ? "Expected" : "Baseline";
  const rightLabel =
    diffMode === "expected-output" ? "Output" : "Comparison";
  const diff = charDiff(left, right);

  return (
    <aside
      className={cn(
        "overflow-auto border-[var(--border-subtle)]",
        "mt-3 border-t pt-3",
        "md:mt-0 md:max-h-full md:w-80 md:min-w-[18rem] md:shrink-0 md:self-stretch md:border-l md:border-t-0 md:pl-3 md:pt-0 md:sticky md:top-0",
      )}
      data-wave-e4-diff="panel"
      data-wave-e6-diff="rail"
      data-testid="compare-diff-panel"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-[var(--text-secondary)]">
          Diff · {leftLabel} ↔ {rightLabel}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={onClose}
          data-wave-e4-diff="close"
        >
          Close
        </Button>
      </div>
      {diff.equal ? (
        <p className="text-xs text-[var(--text-muted)]">Identical</p>
      ) : (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--bg-base)] p-2 text-xs md:max-h-[min(70vh,32rem)]">
          <span className="text-[var(--text-muted)]">{diff.commonPrefix}</span>
          <span className="bg-[var(--error-bg)] line-through">
            {diff.leftOnly}
          </span>
          <span className="bg-[var(--success-bg)]">{diff.rightOnly}</span>
          <span className="text-[var(--text-muted)]">{diff.commonSuffix}</span>
        </pre>
      )}
    </aside>
  );
}

function SummaryLayout({
  summary,
  datapoints,
}: {
  summary: Record<string, number> | null;
  datapoints: Datapoint[];
}) {
  const grades = composeGradeSummary(summary, datapoints);
  const overall = overallComparisonGrade(grades);
  return (
    <div data-wave-e4-layout="summary" data-testid="compare-summary-layout">
      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm text-[var(--text-muted)]">Overall</span>
        <span
          className={cn(
            "rounded border px-2 py-1 text-xs font-medium",
            gradeChipClass(overall),
          )}
          data-wave-e4-grade="overall"
        >
          {GRADE_LABELS[overall]}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
        {(Object.keys(GRADE_LABELS) as Array<keyof typeof GRADE_LABELS>).map(
          (g) => (
            <div
              key={g}
              className={cn(
                "rounded border p-3",
                gradeChipClass(g),
              )}
              data-wave-e4-grade={g}
            >
              <div className="text-xs opacity-80">{GRADE_LABELS[g]}</div>
              <div className="text-lg font-semibold text-[var(--text-primary)]">
                {grades[g]}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function ListLayout({
  datapoints,
  diffOpen,
  onOpenDiff,
}: {
  datapoints: Datapoint[];
  diffOpen: string | null;
  onOpenDiff: (key: string) => void;
}) {
  const sorted = sortDatapointsFailingFirst(datapoints);
  return (
    <div data-wave-e4-layout="list" data-testid="compare-list-layout">
      <div
        className="mb-2 hidden grid-cols-[minmax(0,1fr)_5rem_5rem_4rem] gap-2 px-2 text-xs font-medium text-[var(--text-muted)] sm:grid"
        data-testid="compare-score-headers"
      >
        <span>Case</span>
        <span className="text-right">Baseline</span>
        <span className="text-right">Treatment</span>
        <span className="text-right">Δ</span>
      </div>
      <ul
        className="max-h-[50vh] space-y-2 overflow-auto"
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
          return (
            <li
              key={key}
              className="rounded border border-[var(--border-default)] p-2 text-xs"
            >
              <div className="mb-1 grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_5rem_5rem_4rem] sm:items-center sm:gap-2">
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
                <span className="font-mono text-right tabular-nums text-[var(--text-secondary)]">
                  {controlScore != null ? controlScore.toFixed(3) : "—"}
                </span>
                <span className="font-mono text-right tabular-nums text-[var(--text-secondary)]">
                  {treatmentScore != null ? treatmentScore.toFixed(3) : "—"}
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
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ComparePanel({
  selectedRow,
  baselineRow,
  effectiveBaselineId,
  baselineCandidates,
  summary,
  datapoints,
  compareMeta,
  summaryLoading,
  compareError,
  layout,
  diffMode,
  failuresOnly,
  diffOpen,
  onClose,
  onPrev,
  onNext,
  onSetBaseline,
  onSetLayout,
  onSetDiffMode,
  onSetFailuresOnly,
  onSetDiffOpen,
  onRetryCompare,
}: ComparePanelProps) {
  const listGridDatapoints = failuresOnly
    ? filterFailingOrRegressedDatapoints(datapoints)
    : datapoints;
  const activeDiffDp =
    diffOpen != null && diffOpen !== ""
      ? datapoints.find((dp, idx) => String(dp.row_id || idx) === diffOpen)
      : undefined;
  const railOpen = Boolean(activeDiffDp);

  return (
    <DetailPanelShell
      open
      onClose={onClose}
      title={selectedRow?.name ?? "Experiment"}
      onPrev={onPrev}
      onNext={onNext}
      headerActions={
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {selectedRow?.dataset_id ? (
            <Link
              href={datasetHref(selectedRow.dataset_id)}
              className="text-[var(--accent)] hover:underline"
            >
              Dataset
            </Link>
          ) : null}
          <Link
            href={playgroundHref()}
            className="text-[var(--text-muted)] hover:underline"
          >
            Playground
          </Link>
          {selectedRow?.source_issue_id ? (
            <Link
              href={issueHref(selectedRow.source_issue_id)}
              className="text-[var(--text-muted)] hover:underline"
            >
              Source issue
            </Link>
          ) : null}
        </div>
      }
    >
      {summaryLoading ? (
        <div className="flex items-center justify-center p-8 text-sm text-[var(--text-muted)]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading compare…
        </div>
      ) : compareError ? (
        <ErrorState
          title="Could not load compare"
          message={compareError}
          className="m-4"
          action={
            <Button variant="outline" size="sm" onClick={onRetryCompare}>
              Try again
            </Button>
          }
        />
      ) : summary || datapoints.length > 0 ? (
        <div
          className="flex h-full flex-col"
          data-wave-e4-compare="panel"
          data-wave-e6-compare="panel"
          data-wave-e6-keyboard="compare"
          data-testid="compare-panel"
        >
          <div className="space-y-space-3 p-space-4">
            <div
              className="flex flex-wrap items-end gap-3"
              data-wave-e4-baseline="picker"
            >
              <div className="min-w-[10rem] flex-1">
                <label
                  className="mb-1 block text-[11px] text-[var(--text-muted)]"
                  htmlFor="compare-baseline-select"
                >
                  Baseline
                </label>
                <Select
                  value={effectiveBaselineId ?? "__none__"}
                  onValueChange={(v) =>
                    onSetBaseline(v === "__none__" ? undefined : v)
                  }
                >
                  <SelectTrigger
                    id="compare-baseline-select"
                    className="h-8"
                    data-testid="compare-baseline"
                    data-wave-e4-baseline="select"
                  >
                    <SelectValue placeholder="Select baseline" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No baseline</SelectItem>
                    {baselineCandidates.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="pb-1 text-xs text-[var(--text-muted)]">
                {baselineRow ? (
                  <>
                    vs{" "}
                    <span className="font-medium text-[var(--text-secondary)]">
                      {selectedRow?.name ?? "—"}
                    </span>
                  </>
                ) : (
                  "Pick a baseline for score deltas."
                )}
              </p>
            </div>

            {compareMeta?.synthetic ? (
              <div
                className="rounded border border-[var(--warning)]/40 bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning)]"
                role="status"
              >
                Heuristic stub scores — not a live model eval
                {compareMeta.method ? ` (${compareMeta.method})` : ""}.
              </div>
            ) : null}

            <div
              className="flex flex-wrap items-center gap-2"
              data-wave-e4-layouts="toggle"
              role="group"
              aria-label="Compare layout"
            >
              {COMPARE_LAYOUTS.map((l) => (
                <Button
                  key={l}
                  type="button"
                  size="sm"
                  variant={layout === l ? "default" : "outline"}
                  className="h-7 capitalize"
                  data-wave-e4-layout-tab={l}
                  aria-pressed={layout === l}
                  onClick={() => onSetLayout(l)}
                >
                  {l === "summary"
                    ? "Summary"
                    : l === "list"
                      ? "List"
                      : "Grid"}
                </Button>
              ))}
            </div>

            <div
              className="flex flex-wrap items-center gap-2"
              data-wave-e6-failures="filter"
              role="group"
              aria-label="Datapoint filter"
            >
              <span className="text-[11px] text-[var(--text-muted)]">
                Show
              </span>
              <Button
                type="button"
                size="sm"
                variant={!failuresOnly ? "default" : "outline"}
                className="h-7"
                aria-pressed={!failuresOnly}
                onClick={() => onSetFailuresOnly(false)}
              >
                All
              </Button>
              <Button
                type="button"
                size="sm"
                variant={failuresOnly ? "default" : "outline"}
                className="h-7"
                data-wave-e6-failures="only"
                aria-pressed={failuresOnly}
                onClick={() => onSetFailuresOnly(true)}
              >
                Failures
              </Button>
            </div>

            <div
              className="flex flex-wrap items-center gap-2"
              data-wave-e4-diff="mode"
            >
              <span className="text-[11px] text-[var(--text-muted)]">
                Diff mode
              </span>
              <Button
                type="button"
                size="sm"
                variant={
                  diffMode === "base-comparison" ? "default" : "outline"
                }
                className="h-7"
                data-wave-e4-diff-mode="base-comparison"
                onClick={() => onSetDiffMode("base-comparison")}
              >
                Base ↔ Comparison
              </Button>
              <Button
                type="button"
                size="sm"
                variant={
                  diffMode === "expected-output" ? "default" : "outline"
                }
                className="h-7"
                data-wave-e4-diff-mode="expected-output"
                onClick={() => onSetDiffMode("expected-output")}
              >
                Expected ↔ Output
              </Button>
            </div>

            <h3 className="text-sm font-medium">
              {layout === "summary"
                ? "Compare summary"
                : layout === "list"
                  ? "Side-by-side scores"
                  : "Case × run matrix"}
            </h3>

            <div
              className={cn(
                railOpen && "md:flex md:flex-row md:items-start md:gap-3",
              )}
            >
              <div className={cn("min-w-0", railOpen && "md:flex-1")}>
                {layout === "summary" ? (
                  <SummaryLayout summary={summary} datapoints={datapoints} />
                ) : layout === "list" ? (
                  <ListLayout
                    datapoints={listGridDatapoints}
                    diffOpen={diffOpen}
                    onOpenDiff={(key) => onSetDiffOpen(key || null)}
                  />
                ) : (
                  <CompareMatrix
                    datapoints={listGridDatapoints}
                    summary={summary}
                    treatment={selectedRow}
                    baseline={baselineRow}
                    diffOpen={diffOpen}
                    onOpenDiff={(key) => onSetDiffOpen(key || null)}
                  />
                )}
              </div>

              {activeDiffDp ? (
                <DiffSidePanel
                  datapoint={activeDiffDp}
                  diffMode={diffMode}
                  onClose={() => onSetDiffOpen(null)}
                />
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <p className="p-4 text-sm text-[var(--text-muted)]">
          No compare data yet. Run the experiment first.
        </p>
      )}
    </DetailPanelShell>
  );
}
