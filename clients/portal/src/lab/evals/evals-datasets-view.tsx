"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentForDataset,
  casesForDataset,
  experimentsForDataset,
  formatScore,
  type DatasetCaseFixture,
  type DatasetFixture,
  type DatasetSource,
  type ExperimentFixture,
} from "@/lab/fixtures/evals";
import { AgentLink, EmptyState, FilterChips } from "@/lab/lab-ui";
import { cn } from "@/lib/utils";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";

type SourceFilter = "all" | DatasetSource;
type DetailTab = "cases" | "runs";

export function EvalsDatasetsView({
  agentId,
  datasets,
  selectedId,
  fromHint,
  focusCaseId,
  extraCases = [],
  extraExperiments = [],
  renamingId,
  onSelect,
  onCompareLatest,
  onRunExperiment,
  onOpenRun,
  onCreateDataset,
  onAddCase,
  onRenameDataset,
  onDeleteDataset,
  onUpdateCase,
  onDeleteCase,
  onTryDataset,
}: {
  agentId: string;
  datasets: DatasetFixture[];
  selectedId: string;
  fromHint: string | null;
  focusCaseId?: string | null;
  extraCases?: DatasetCaseFixture[];
  extraExperiments?: ExperimentFixture[];
  renamingId?: string | null;
  onSelect: (id: string) => void;
  onCompareLatest: (datasetId: string) => void;
  onRunExperiment: (datasetId: string) => void;
  onOpenRun: (experimentId: string) => void;
  onCreateDataset: () => void;
  onAddCase: (datasetId: string) => void;
  onRenameDataset: (id: string, name: string) => void;
  onDeleteDataset: (id: string) => void;
  onUpdateCase: (
    caseId: string,
    patch: { input?: string; expected?: string },
  ) => void;
  onDeleteCase: (datasetId: string, caseId: string) => void;
  onTryDataset: (datasetId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [detailTab, setDetailTab] = useState<DetailTab>("cases");

  useEffect(() => {
    if (focusCaseId) setDetailTab("cases");
  }, [focusCaseId]);

  const scoped = useMemo(() => {
    if (agentId === "all") return datasets;
    return datasets.filter((d) => d.agentId === agentId);
  }, [datasets, agentId]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scoped.filter((d) => {
      if (source !== "all" && d.source !== source) return false;
      if (!q) return true;
      return (
        d.name.toLowerCase().includes(q) ||
        d.id.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q)
      );
    });
  }, [scoped, query, source]);

  const selected =
    rows.find((d) => d.id === selectedId) ??
    datasets.find((d) => d.id === selectedId) ??
    rows[0];

  const sourceCounts = useMemo(() => {
    return {
      all: scoped.length,
      traces: scoped.filter((d) => d.source === "traces").length,
      issues: scoped.filter((d) => d.source === "issues").length,
      manual: scoped.filter((d) => d.source === "manual").length,
      import: scoped.filter((d) => d.source === "import").length,
    };
  }, [scoped]);

  const clearSearch = () => {
    setQuery("");
    setSource("all");
  };

  const fromHref = fromHint
    ? fromHint.startsWith("iss_")
      ? `/issues?id=${fromHint}`
      : `/traces?id=${fromHint}`
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-3 sm:px-6">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search datasets…"
          className="ds-input min-w-[10rem] flex-1 !h-8 !py-0 !text-[0.75rem] sm:max-w-xs"
          aria-label="Search datasets"
        />
        <FilterChips
          value={source}
          onChange={setSource}
          scroll
          options={[
            { id: "all", label: "All", count: sourceCounts.all },
            { id: "traces", label: "From traces", count: sourceCounts.traces },
            { id: "issues", label: "From issues", count: sourceCounts.issues },
            { id: "manual", label: "Manual", count: sourceCounts.manual },
          ]}
        />
        <button
          type="button"
          className="ds-btn ds-btn-primary ds-btn-sm ml-auto"
          onClick={onCreateDataset}
        >
          New dataset
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          compact
          title={scoped.length === 0 ? "No datasets" : "No matches"}
          body={
            scoped.length === 0 ? U20_EMPTY_COPY.datasets : undefined
          }
          action={
            scoped.length === 0 ? (
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                onClick={onCreateDataset}
              >
                New dataset
              </button>
            ) : (
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={clearSearch}
              >
                Clear
              </button>
            )
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-[1] bg-[var(--bg)]">
              <tr className="border-b border-[var(--line)]">
                <th className="type-label px-4 py-2 font-normal sm:px-6">
                  Dataset
                </th>
                <th className="type-label hidden py-2 pr-4 font-normal sm:table-cell">
                  Cases
                </th>
                <th className="type-label py-2 pr-4 font-normal sm:pr-6">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const agent = agentForDataset(d);
                const active = d.id === selected?.id;
                return (
                  <tr
                    key={d.id}
                    tabIndex={0}
                    className={cn(
                      "cursor-pointer border-b border-[var(--line)] hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--accent-muted)] focus-visible:outline-none",
                      active && "bg-[var(--accent-muted)]",
                    )}
                    onClick={() => onSelect(d.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(d.id);
                      }
                    }}
                  >
                    <td className="px-4 py-2.5 sm:px-6">
                      <p className="type-ui text-[var(--text)]">{d.name}</p>
                      <p className="type-meta mt-0.5 line-clamp-1">
                        {agent ? agent.name : "Any agent"}
                        <span className="mx-1.5 text-[var(--text-faint)]">
                          ·
                        </span>
                        {d.source === "traces"
                          ? "Traces"
                          : d.source === "issues"
                            ? "Issues"
                            : d.source}
                      </p>
                    </td>
                    <td className="type-mono hidden py-2.5 pr-4 !text-[0.6875rem] sm:table-cell">
                      {d.caseIds.length}
                    </td>
                    <td className="type-meta py-2.5 pr-4 sm:pr-6">
                      {d.updatedAt}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <DatasetDock
          dataset={selected}
          detailTab={detailTab}
          onDetailTab={setDetailTab}
          fromHint={fromHint}
          fromHref={fromHref}
          focusCaseId={focusCaseId ?? null}
          extraCases={extraCases}
          extraExperiments={extraExperiments}
          autoFocusName={renamingId === selected.id}
          onCompareLatest={() => onCompareLatest(selected.id)}
          onRunExperiment={() => onRunExperiment(selected.id)}
          onOpenRun={onOpenRun}
          onAddCase={() => onAddCase(selected.id)}
          onRename={(name) => onRenameDataset(selected.id, name)}
          onDelete={() => onDeleteDataset(selected.id)}
          onUpdateCase={onUpdateCase}
          onDeleteCase={(caseId) => onDeleteCase(selected.id, caseId)}
          onTry={() => onTryDataset(selected.id)}
        />
      ) : null}
    </div>
  );
}

function DatasetDock({
  dataset,
  detailTab,
  onDetailTab,
  fromHint,
  fromHref,
  focusCaseId,
  extraCases,
  extraExperiments,
  autoFocusName,
  onCompareLatest,
  onRunExperiment,
  onOpenRun,
  onAddCase,
  onRename,
  onDelete,
  onUpdateCase,
  onDeleteCase,
  onTry,
}: {
  dataset: DatasetFixture;
  detailTab: DetailTab;
  onDetailTab: (t: DetailTab) => void;
  fromHint: string | null;
  fromHref: string | null;
  focusCaseId: string | null;
  extraCases: DatasetCaseFixture[];
  extraExperiments: ExperimentFixture[];
  autoFocusName?: boolean;
  onCompareLatest: () => void;
  onRunExperiment: () => void;
  onOpenRun: (experimentId: string) => void;
  onAddCase: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onUpdateCase: (
    caseId: string,
    patch: { input?: string; expected?: string },
  ) => void;
  onDeleteCase: (caseId: string) => void;
  onTry: () => void;
}) {
  const agent = agentForDataset(dataset);
  const nameRef = useRef<HTMLInputElement>(null);
  const [nameDraft, setNameDraft] = useState(dataset.name);
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null);

  useEffect(() => {
    setNameDraft(dataset.name);
  }, [dataset.id, dataset.name]);

  useEffect(() => {
    if (!autoFocusName) return;
    const el = nameRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [autoFocusName, dataset.id]);

  useEffect(() => {
    if (focusCaseId) setEditingCaseId(focusCaseId);
  }, [focusCaseId]);

  const fixtureCases = casesForDataset(dataset.id);
  const local = extraCases.filter((c) => c.datasetId === dataset.id);
  const cases: DatasetCaseFixture[] = [
    ...local,
    ...fixtureCases.filter((c) => !local.some((l) => l.id === c.id)),
  ];
  // Never synthesize placeholder rows for missing caseIds — empty state
  // is honest when case content has not loaded.
  const allCases: DatasetCaseFixture[] = cases;

  const fixtureRuns = experimentsForDataset(dataset.id).filter(
    (e) => e.status === "completed",
  );
  const allRuns = [
    ...extraExperiments.filter(
      (e) => e.datasetId === dataset.id && e.status === "completed",
    ),
    ...fixtureRuns.filter((e) => !extraExperiments.some((x) => x.id === e.id)),
  ];

  const canRun = allCases.length > 0;
  const canCompare = allRuns.length > 0;

  const commitName = () => {
    const next = nameDraft.trim() || "Untitled dataset";
    if (next !== dataset.name) onRename(next);
    else setNameDraft(dataset.name);
  };

  return (
    <div className="flex max-h-[52%] min-h-[14rem] shrink-0 flex-col border-t border-[var(--line)] bg-[var(--bg-inset)]">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <input
            ref={nameRef}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                setNameDraft(dataset.name);
                e.currentTarget.blur();
              }
            }}
            className="ds-input w-full max-w-md !h-8 !border-transparent !bg-transparent !px-0 !py-0 !text-[0.875rem] !font-medium !text-[var(--text)] hover:!border-[var(--line)] focus:!border-[var(--line)] focus:!bg-[var(--bg)]"
            aria-label="Dataset name"
          />
          <p className="type-meta mt-1">
            {dataset.caseIds.length} case
            {dataset.caseIds.length === 1 ? "" : "s"}
            {" · "}
            {allRuns.length} run{allRuns.length === 1 ? "" : "s"}
            {" · "}
            <AgentLink
              agentId={agent?.id}
              name={agent?.name ?? "any agent"}
            />
            {fromHint && fromHref ? (
              <>
                {" · "}
                <Link
                  href={fromHref}
                  className="text-[var(--accent)] hover:underline"
                >
                  {fromHint}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onTry}
          >
            Try
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onAddCase}
          >
            Add case
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onCompareLatest}
            disabled={!canCompare}
          >
            Compare
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={onRunExperiment}
            disabled={!canRun}
          >
            Run
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onDelete}
            aria-label="Delete dataset"
          >
            Delete
          </button>
        </div>
      </div>

      <div
        role="tablist"
        className="flex shrink-0 gap-1 border-b border-[var(--line)] px-4 sm:px-6"
      >
        {(
          [
            ["cases", `Cases · ${allCases.length}`],
            ["runs", `Runs · ${allRuns.length}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={detailTab === id}
            className="ds-tab"
            onClick={() => onDetailTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
        {detailTab === "cases" ? (
          allCases.length === 0 ? (
            <EmptyState
              compact
              title={
                dataset.caseIds.length > 0
                  ? "Cases unavailable"
                  : "No cases"
              }
              body={
                dataset.caseIds.length > 0
                  ? "Case ids exist but content has not loaded. Add a case or refresh."
                  : undefined
              }
              action={
                <button
                  type="button"
                  className="ds-btn ds-btn-primary ds-btn-sm"
                  onClick={onAddCase}
                >
                  Add case
                </button>
              }
            />
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {allCases.map((c) => {
                const editing = editingCaseId === c.id;
                return (
                  <li
                    key={c.id}
                    className={cn(
                      "py-2.5",
                      focusCaseId === c.id &&
                        "rounded-[var(--radius)] bg-[var(--accent-muted)] -mx-2 px-2",
                    )}
                  >
                    {editing ? (
                      <div className="space-y-2">
                        <input
                          autoFocus
                          defaultValue={c.input}
                          className="ds-input w-full !h-8 !py-0 !text-[0.8125rem]"
                          aria-label="Case input"
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== c.input) {
                              onUpdateCase(c.id, { input: v });
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              (e.target as HTMLInputElement).blur();
                              setEditingCaseId(null);
                            }
                            if (e.key === "Escape") setEditingCaseId(null);
                          }}
                        />
                        <input
                          defaultValue={c.expected ?? ""}
                          placeholder="Expected (optional)"
                          className="ds-input w-full !h-8 !py-0 !text-[0.75rem]"
                          aria-label="Expected output"
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v !== (c.expected ?? "")) {
                              onUpdateCase(c.id, { expected: v || undefined });
                            }
                          }}
                        />
                        <div className="flex gap-1">
                          <button
                            type="button"
                            className="ds-btn ds-btn-ghost ds-btn-sm"
                            onClick={() => setEditingCaseId(null)}
                          >
                            Done
                          </button>
                          <button
                            type="button"
                            className="ds-btn ds-btn-ghost ds-btn-sm"
                            onClick={() => onDeleteCase(c.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="w-full text-left"
                          onClick={() => setEditingCaseId(c.id)}
                        >
                          <p className="type-ui text-[var(--text)]">{c.input}</p>
                          {c.expected ? (
                            <p className="type-body mt-1">
                              want · {c.expected}
                            </p>
                          ) : (
                            <p className="type-meta mt-1 text-[var(--text-faint)]">
                              Click to edit
                            </p>
                          )}
                        </button>
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          {c.sourceTraceId ? (
                            <Link
                              href={`/traces?id=${c.sourceTraceId}`}
                              className="type-meta text-[var(--accent)] hover:underline"
                            >
                              Trace
                            </Link>
                          ) : null}
                          {c.sourceIssueId ? (
                            <Link
                              href={`/issues?id=${c.sourceIssueId}`}
                              className="type-meta text-[var(--accent)] hover:underline"
                            >
                              Issue
                            </Link>
                          ) : null}
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
        {detailTab === "runs" ? (
          allRuns.length === 0 ? (
            <EmptyState
              compact
              title="No runs"
              action={
                <button
                  type="button"
                  className="ds-btn ds-btn-primary ds-btn-sm"
                  onClick={onRunExperiment}
                  disabled={!canRun}
                >
                  Run
                </button>
              }
            />
          ) : (
            <ul className="space-y-1">
              {[...allRuns].reverse().map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-[var(--radius)] px-1 py-2 text-left hover:bg-[var(--bg-hover)]"
                    onClick={() => onOpenRun(e.id)}
                  >
                    <span className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
                      {e.name}
                      {e.playgroundId ? (
                        <span className="type-meta ml-2 text-[var(--text-faint)]">
                          from Try
                        </span>
                      ) : null}
                    </span>
                    <span className="type-value !text-[0.6875rem]">
                      {formatScore(Object.values(e.avgScores)[0] ?? 0)}
                    </span>
                    <span className="type-meta shrink-0">{e.createdAt}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </div>
  );
}
