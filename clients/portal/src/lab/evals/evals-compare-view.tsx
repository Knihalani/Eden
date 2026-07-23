"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  compareExperiments,
  completedExperimentsForDataset,
  formatScore,
  resolveExperiment,
  type CaseCompareRow,
  type CompareGrade,
  type DatasetCaseFixture,
  type DatasetFixture,
  type ExperimentCaseResult,
  type ExperimentFixture,
} from "@/lab/fixtures/evals";
import { formatDuration, formatUsd } from "@/lab/fixtures/traces";
import { EmptyState, FilterChips } from "@/lab/lab-ui";
import { CompareGradeChip, Delta } from "@/lab/evals/evals-chrome";
import { cn } from "@/lib/utils";

export type CompareLayout = "summary" | "list" | "grid";

function verdictCopy(grade: CompareGrade, compareName: string): string {
  if (grade === "improve") return `${compareName} is better`;
  if (grade === "regress") return `${compareName} is worse`;
  if (grade === "tradeoff") return `${compareName} is mixed`;
  return `${compareName} is unchanged`;
}

export function EvalsCompareView({
  baselineId,
  compareId,
  layout,
  gradeFilter,
  diff,
  focusCaseId,
  datasets,
  extraExperiments = [],
  extraResults = [],
  extraCases = [],
  onBaseline,
  onCompare,
  onDatasetChange,
  onGoDatasets,
  onGoPlayground,
  onLayout,
  onGrade,
  onDiff,
  onFocusCase,
}: {
  baselineId: string;
  compareId: string;
  layout: CompareLayout;
  gradeFilter: CompareGrade | "all";
  diff: boolean;
  focusCaseId: string | null;
  datasets: DatasetFixture[];
  extraExperiments?: ExperimentFixture[];
  extraResults?: ExperimentCaseResult[];
  extraCases?: DatasetCaseFixture[];
  onBaseline: (id: string) => void;
  onCompare: (id: string) => void;
  onDatasetChange: (datasetId: string) => void;
  onGoDatasets: () => void;
  onGoPlayground: () => void;
  onLayout: (layout: CompareLayout) => void;
  onGrade: (g: CompareGrade | "all") => void;
  onDiff: (v: boolean) => void;
  onFocusCase: (id: string | null) => void;
}) {
  const baseline = resolveExperiment(baselineId, extraExperiments);
  const compare = resolveExperiment(compareId, extraExperiments);
  const datasetId = compare?.datasetId ?? baseline?.datasetId ?? "";

  const experiments = useMemo(
    () => completedExperimentsForDataset(datasetId, extraExperiments),
    [datasetId, extraExperiments],
  );

  const { summary, rows } = useMemo(
    () =>
      compareExperiments(baselineId, compareId, {
        experiments: extraExperiments,
        results: extraResults,
        cases: extraCases,
      }),
    [baselineId, compareId, extraExperiments, extraResults, extraCases],
  );

  const filtered = useMemo(() => {
    let list =
      gradeFilter === "all"
        ? rows
        : rows.filter((r) => r.grade === gradeFilter);
    list = [...list].sort((a, b) => {
      const rank = (g: CompareGrade) =>
        g === "regress" ? 0 : g === "tradeoff" ? 1 : g === "improve" ? 2 : 3;
      return rank(a.grade) - rank(b.grade);
    });
    return list;
  }, [rows, gradeFilter]);

  const focus = focusCaseId
    ? (rows.find((r) => r.caseId === focusCaseId) ?? null)
    : null;

  const clearFilters = () => onGrade("all");

  const setCompareKeepingDataset = (id: string) => {
    onCompare(id);
    const next = resolveExperiment(id, extraExperiments);
    if (!next) return;
    const stillValid = experiments.some(
      (e) => e.id === baselineId && e.datasetId === next.datasetId,
    );
    if (!stillValid || baselineId === id) {
      const peer =
        next.suggestedBaselineId && next.suggestedBaselineId !== id
          ? next.suggestedBaselineId
          : experiments.find((e) => e.id !== id)?.id;
      if (peer) onBaseline(peer);
    }
  };

  const swapPair = () => {
    if (baselineId === compareId) return;
    onBaseline(compareId);
    onCompare(baselineId);
  };

  const improveHref = `/improve?baselineId=${baselineId}&compareId=${compareId}${
    focusCaseId ? `&case=${focusCaseId}` : ""
  }`;

  const onlineAbHref = `/compare?from=evals&baselineId=${baselineId}&compareId=${compareId}`;

  const runLabel = (e: ExperimentFixture) => {
    const score = formatScore(Object.values(e.avgScores)[0] ?? 0);
    return `${e.name} · ${score} · ${e.createdAt}`;
  };

  if (experiments.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-3 sm:px-6">
          <label className="flex items-center gap-1.5">
            <span className="type-label">Dataset</span>
            <select
              className="ds-input min-w-[10rem] max-w-[16rem] !h-8 !py-0 !text-[0.75rem]"
              value={datasetId}
              onChange={(e) => onDatasetChange(e.target.value)}
              aria-label="Dataset"
            >
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <EmptyState
          compact
          title="No completed runs"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                onClick={onGoDatasets}
              >
                Datasets
              </button>
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={onGoPlayground}
              >
                Try
              </button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-[var(--line)] px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <CompareGradeChip grade={summary.overallGrade} />
              <p className="type-ui truncate text-[var(--text)]">
                {verdictCopy(
                  summary.overallGrade,
                  compare?.name ?? "Newer run",
                )}
              </p>
            </div>
            <p className="type-meta mt-1">
              <Delta value={summary.scoreDelta} /> score
              <span className="mx-1.5 text-[var(--text-faint)]">·</span>
              <Delta value={summary.latencyDelta} invertGood /> ms
              <span className="mx-1.5 text-[var(--text-faint)]">·</span>
              <Delta value={summary.costDelta} invertGood /> $
              <span className="mx-1.5 text-[var(--text-faint)]">·</span>
              <span className="text-[var(--success)]">
                {summary.improveCount}↑
              </span>{" "}
              <span className="text-[var(--error)]">
                {summary.regressCount}↓
              </span>
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {(summary.overallGrade === "improve" ||
              summary.overallGrade === "tradeoff") && (
              <Link
                href={onlineAbHref}
                className="ds-btn ds-btn-sm"
              >
                Online A/B
              </Link>
            )}
            {(summary.overallGrade === "regress" ||
              summary.overallGrade === "tradeoff") && (
              <Link
                href={improveHref}
                className="ds-btn ds-btn-primary ds-btn-sm"
              >
                Improve
              </Link>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            <span className="type-label">Dataset</span>
            <select
              className="ds-input min-w-[9rem] max-w-[14rem] !h-8 !py-0 !text-[0.75rem]"
              value={datasetId}
              onChange={(e) => onDatasetChange(e.target.value)}
              aria-label="Dataset"
            >
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.caseIds.length}
                </option>
              ))}
            </select>
          </label>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-[var(--line)]" aria-hidden />
          <label className="flex min-w-0 items-center gap-1.5">
            <span className="type-label">Older</span>
            <select
              className="ds-input max-w-[18rem] min-w-[10rem] !h-8 !py-0 !text-[0.75rem]"
              value={baselineId}
              onChange={(e) => onBaseline(e.target.value)}
              aria-label="Older run"
            >
              {experiments.map((e) => (
                <option key={e.id} value={e.id} disabled={e.id === compareId}>
                  {runLabel(e)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={swapPair}
            aria-label="Swap older and newer"
            title="Swap"
          >
            ⇄
          </button>
          <label className="flex min-w-0 items-center gap-1.5">
            <span className="type-label">Newer</span>
            <select
              className="ds-input max-w-[18rem] min-w-[10rem] !h-8 !py-0 !text-[0.75rem]"
              value={compareId}
              onChange={(e) => setCompareKeepingDataset(e.target.value)}
              aria-label="Newer run"
            >
              {experiments.map((e) => (
                <option key={e.id} value={e.id} disabled={e.id === baselineId}>
                  {runLabel(e)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <FilterChips
            value={layout}
            onChange={onLayout}
            options={[
              { id: "summary", label: "Overview" },
              { id: "list", label: "Cases" },
              { id: "grid", label: "Table" },
            ]}
          />
          {layout !== "summary" ? (
            <>
              <span
                className="mx-0.5 h-4 w-px shrink-0 bg-[var(--line)]"
                aria-hidden
              />
              <button
                type="button"
                className="ds-tab"
                aria-pressed={diff}
                onClick={() => onDiff(!diff)}
              >
                Diff
              </button>
              <FilterChips
                value={gradeFilter}
                onChange={onGrade}
                scroll
                options={[
                  { id: "all", label: "All", count: rows.length },
                  {
                    id: "improve",
                    label: "Better",
                    count: summary.improveCount,
                  },
                  {
                    id: "regress",
                    label: "Worse",
                    count: summary.regressCount,
                  },
                  {
                    id: "tradeoff",
                    label: "Mixed",
                    count: summary.tradeoffCount,
                  },
                  { id: "tie", label: "Same", count: summary.tieCount },
                ]}
              />
            </>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {layout === "summary" ? (
          <SummaryBody
            baseline={baseline}
            compare={compare}
            regress={summary.regressCount}
            onShowWorse={() => {
              onLayout("list");
              onGrade("regress");
            }}
          />
        ) : null}

        {layout === "list" ? (
          filtered.length === 0 ? (
            <EmptyState
              compact
              title="No matches"
              action={
                gradeFilter !== "all" ? (
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm"
                    onClick={clearFilters}
                  >
                    Clear
                  </button>
                ) : undefined
              }
            />
          ) : (
            <ul>
              {filtered.map((row) => (
                <li key={row.caseId}>
                  <button
                    type="button"
                    onClick={() =>
                      onFocusCase(
                        focusCaseId === row.caseId ? null : row.caseId,
                      )
                    }
                    className={cn(
                      "flex w-full flex-col gap-1.5 border-b border-[var(--line)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)] sm:px-6",
                      focusCaseId === row.caseId && "bg-[var(--accent-muted)]",
                      row.grade === "regress" &&
                        focusCaseId !== row.caseId &&
                        "bg-[var(--error-muted)]",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <CompareGradeChip grade={row.grade} />
                      <span className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
                        {row.input}
                      </span>
                      <Delta value={row.scoreDelta} />
                    </div>
                    {diff ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <p className="type-body line-clamp-3">
                          <span className="text-[var(--text-faint)]">
                            older ·{" "}
                          </span>
                          {row.baseline?.output ?? "—"}
                        </p>
                        <p
                          className={cn(
                            "type-body line-clamp-3",
                            row.grade === "regress" && "text-[var(--error)]",
                            row.grade === "improve" && "text-[var(--success)]",
                          )}
                        >
                          <span className="text-[var(--text-faint)]">
                            newer ·{" "}
                          </span>
                          {row.compare?.output ?? "—"}
                        </p>
                      </div>
                    ) : (
                      <p className="type-body line-clamp-2">
                        {row.compare?.output ?? row.baseline?.output ?? "—"}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {layout === "grid" ? (
          <GridBody
            rows={filtered}
            focusCaseId={focusCaseId}
            onFocusCase={onFocusCase}
            diff={diff}
            onClearFilters={
              gradeFilter !== "all" ? clearFilters : undefined
            }
          />
        ) : null}
      </div>

      {focus ? (
        <CaseDock
          row={focus}
          improveHref={improveHref}
          onClose={() => onFocusCase(null)}
        />
      ) : null}
    </div>
  );
}

function SummaryBody({
  baseline,
  compare,
  regress,
  onShowWorse,
}: {
  baseline?: ExperimentFixture;
  compare?: ExperimentFixture;
  regress: number;
  onShowWorse?: () => void;
}) {
  return (
    <div className="space-y-5 px-4 py-5 sm:px-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <ExpPlain title="Older" exp={baseline} />
        <ExpPlain title="Newer" exp={compare} />
      </div>
      {regress > 0 && onShowWorse ? (
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm"
          onClick={onShowWorse}
        >
          Worse cases · {regress}
        </button>
      ) : null}
    </div>
  );
}

function ExpPlain({
  title,
  exp,
}: {
  title: string;
  exp?: ExperimentFixture;
}) {
  if (!exp) return null;
  const primary = Object.values(exp.avgScores)[0] ?? 0;
  return (
    <div>
      <p className="type-label">{title}</p>
      <p className="type-ui mt-1 text-[var(--text)]">{exp.name}</p>
      <p className="type-value mt-1.5 !text-[0.6875rem]">
        {formatScore(primary)} · {formatDuration(exp.latencyMs)} ·{" "}
        {formatUsd(exp.costUsd, 3)}
      </p>
    </div>
  );
}

function GridBody({
  rows,
  focusCaseId,
  onFocusCase,
  diff,
  onClearFilters,
}: {
  rows: CaseCompareRow[];
  focusCaseId: string | null;
  onFocusCase: (id: string | null) => void;
  diff: boolean;
  onClearFilters?: () => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        title="No matches"
        action={
          onClearFilters ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={onClearFilters}
            >
              Clear
            </button>
          ) : undefined
        }
      />
    );
  }
  return (
    <div className="overflow-x-auto px-4 py-3 sm:px-6">
      <table className="w-full min-w-[40rem] border-collapse text-left">
        <thead>
          <tr className="border-b border-[var(--line)]">
            <th className="type-label py-2 pr-3 font-normal">Case</th>
            <th className="type-label py-2 pr-3 font-normal">Result</th>
            <th className="type-label py-2 pr-3 font-normal">Older</th>
            <th className="type-label py-2 pr-3 font-normal">Newer</th>
            <th className="type-label py-2 font-normal">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.caseId}
              tabIndex={0}
              className={cn(
                "cursor-pointer border-b border-[var(--line)] hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--accent-muted)] focus-visible:outline-none",
                focusCaseId === row.caseId && "bg-[var(--accent-muted)]",
                row.grade === "regress" &&
                  focusCaseId !== row.caseId &&
                  "bg-[var(--error-muted)]",
              )}
              onClick={() =>
                onFocusCase(focusCaseId === row.caseId ? null : row.caseId)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onFocusCase(focusCaseId === row.caseId ? null : row.caseId);
                }
              }}
            >
              <td className="type-ui max-w-[14rem] truncate py-2.5 pr-3 text-[var(--text)]">
                {row.input}
              </td>
              <td className="py-2.5 pr-3">
                <CompareGradeChip grade={row.grade} />
              </td>
              <td className="type-meta max-w-[12rem] truncate py-2.5 pr-3">
                {diff
                  ? (row.baseline?.output ?? "—")
                  : row.baseline?.error
                    ? "fail"
                    : formatScore(
                        Object.values(row.baseline?.scores ?? {})[0] ?? 0,
                      )}
              </td>
              <td className="type-meta max-w-[12rem] truncate py-2.5 pr-3">
                {diff
                  ? (row.compare?.output ?? "—")
                  : row.compare?.error
                    ? "fail"
                    : formatScore(
                        Object.values(row.compare?.scores ?? {})[0] ?? 0,
                      )}
              </td>
              <td className="py-2.5">
                <Delta value={row.scoreDelta} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CaseDock({
  row,
  improveHref,
  onClose,
}: {
  row: CaseCompareRow;
  improveHref: string;
  onClose: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CompareGradeChip grade={row.grade} />
            <p className="type-ui text-[var(--text)]">{row.input}</p>
          </div>
          {row.expected ? (
            <p className="type-meta mt-1">{row.expected}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          {row.sourceTraceId ? (
            <Link
              href={`/traces?id=${row.sourceTraceId}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Trace
            </Link>
          ) : null}
          {(row.grade === "regress" || row.grade === "tradeoff") && (
            <Link
              href={improveHref}
              className="ds-btn ds-btn-primary ds-btn-sm"
            >
              Improve
            </Link>
          )}
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="type-label mb-1">Older</p>
          <p className="type-mono whitespace-pre-wrap !text-[0.75rem] !text-[var(--text-secondary)]">
            {row.baseline?.output ?? "—"}
          </p>
        </div>
        <div>
          <p className="type-label mb-1">Newer</p>
          <p className="type-mono whitespace-pre-wrap !text-[0.75rem] !text-[var(--text-secondary)]">
            {row.compare?.output ?? "—"}
          </p>
        </div>
      </div>
    </div>
  );
}
