"use client";

import { useEffect, useMemo, useState } from "react";
import {
  casesForDataset,
  formatScore,
  matrixForPlayground,
  type DatasetCaseFixture,
  type DatasetFixture,
  type PlaygroundFixture,
} from "@/lab/fixtures/evals";
import { StatusChip } from "@/components/ds/primitives";
import { EmptyState, SearchInput } from "@/lab/lab-ui";
import { cn } from "@/lib/utils";

export function EvalsPlaygroundView({
  agentId,
  playgrounds,
  datasets,
  selectedId,
  extraCases = [],
  onSelect,
  onCreate,
  onLinkDataset,
  onRename,
  onPromote,
}: {
  agentId: string;
  playgrounds: PlaygroundFixture[];
  datasets: DatasetFixture[];
  selectedId: string;
  extraCases?: DatasetCaseFixture[];
  onSelect: (id: string) => void;
  onCreate: () => void;
  onLinkDataset: (playgroundId: string, datasetId: string) => void;
  onRename: (playgroundId: string, name: string) => void;
  onPromote: (playground: PlaygroundFixture, prompt: string) => void;
}) {
  const scoped = useMemo(() => {
    if (agentId === "all") return playgrounds;
    return playgrounds.filter(
      (p) => !p.agentId || p.agentId === agentId,
    );
  }, [playgrounds, agentId]);

  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.datasetId ?? "").toLowerCase().includes(q),
    );
  }, [scoped, query]);

  const playground =
    filtered.find((p) => p.id === selectedId) ??
    scoped.find((p) => p.id === selectedId) ??
    filtered[0] ??
    scoped[0];

  const [ran, setRan] = useState(false);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [prompt, setPrompt] = useState(playground?.prompt ?? "");
  const [nameDraft, setNameDraft] = useState(playground?.name ?? "");

  useEffect(() => {
    setPrompt(playground?.prompt ?? "");
    setNameDraft(playground?.name ?? "");
    setRan(false);
    setFailuresOnly(false);
  }, [playground?.id, playground?.prompt, playground?.name]);

  const dirty =
    Boolean(playground?.dirty) ||
    (playground ? prompt !== playground.prompt : false) ||
    (playground ? nameDraft !== playground.name : false);

  const linkableDatasets = useMemo(() => {
    if (agentId === "all") return datasets;
    return datasets.filter((d) => !d.agentId || d.agentId === agentId);
  }, [datasets, agentId]);

  const cases = useMemo(() => {
    if (!playground?.datasetId) return [];
    const local = extraCases.filter((c) => c.datasetId === playground.datasetId);
    const fixture = casesForDataset(playground.datasetId).filter(
      (c) => !local.some((l) => l.id === c.id),
    );
    return [...local, ...fixture];
  }, [playground?.datasetId, extraCases]);
  const matrix = playground ? matrixForPlayground(playground) : [];

  const visibleCases = useMemo(() => {
    if (!failuresOnly || !playground) return cases;
    return cases.filter((c) =>
      playground.variants.some((v) => {
        const cell = matrix.find(
          (m) => m.caseId === c.id && m.variantId === v.id,
        );
        return cell && !cell.pass;
      }),
    );
  }, [cases, failuresOnly, matrix, playground]);

  if (!playground) {
    return (
      <EmptyState
        compact
        title={agentId === "all" ? "No drafts" : "No drafts for this agent"}
        action={
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={onCreate}
          >
            New draft
          </button>
        }
      />
    );
  }

  const canSave = ran && Boolean(playground.datasetId);
  const linkedName =
    linkableDatasets.find((d) => d.id === playground.datasetId)?.name ??
    playground.datasetId;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-3 sm:px-6">
        {scoped.length > 5 ? (
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search drafts…"
            ariaLabel="Search drafts"
            className="w-36"
          />
        ) : null}
        <label className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-xs">
          <span className="type-label shrink-0">Draft</span>
          <select
            className="ds-input min-w-0 flex-1 !h-8 !py-0 !text-[0.75rem]"
            value={playground.id}
            onChange={(e) => onSelect(e.target.value)}
            aria-label="Playground"
          >
            {(filtered.length ? filtered : scoped).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {dirty ? <StatusChip tone="neutral">Unsaved</StatusChip> : null}
        <label className="flex min-w-0 items-center gap-1.5">
          <span className="type-label shrink-0">Dataset</span>
          <select
            className="ds-input max-w-[12rem] !h-8 !py-0 !text-[0.75rem]"
            value={playground.datasetId ?? ""}
            onChange={(e) => {
              if (e.target.value) onLinkDataset(playground.id, e.target.value);
            }}
            aria-label="Linked dataset"
          >
            <option value="" disabled>
              Link…
            </option>
            {linkableDatasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onCreate}
          >
            New draft
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={() => setRan(true)}
            disabled={!playground.datasetId}
          >
            Run
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={() => {
              if (nameDraft.trim() && nameDraft !== playground.name) {
                onRename(playground.id, nameDraft.trim());
              }
              onPromote({ ...playground, name: nameDraft.trim() || playground.name }, prompt);
            }}
            disabled={!canSave}
          >
            Save
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-h-0 overflow-y-auto border-b border-[var(--line)] px-4 py-4 sm:px-6 lg:border-b-0 lg:border-r">
          <label className="mb-4 block">
            <span className="type-label mb-2 block">Name</span>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                const next = nameDraft.trim();
                if (next && next !== playground.name) onRename(playground.id, next);
              }}
              className="ds-input w-full !h-8 !py-0 !text-[0.8125rem]"
              aria-label="Draft name"
            />
          </label>
          <label className="block">
            <span className="type-label mb-2 block">Prompt</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={8}
              className="ds-input min-h-[10rem] w-full resize-y !py-2 !font-[family-name:var(--font-mono)] !text-[0.8125rem] !leading-relaxed"
              aria-label="Prompt"
            />
          </label>
          <p className="type-label mb-2 mt-6">Variants</p>
          <ul className="space-y-3">
            {playground.variants.map((v) => (
              <li key={v.id}>
                <p className="type-ui text-[var(--text)]">{v.label}</p>
                {v.promptSnippet ? (
                  <p className="type-meta mt-1">{v.promptSnippet}</p>
                ) : null}
              </li>
            ))}
          </ul>
          {linkedName ? (
            <p className="type-meta mt-6">Tests · {linkedName}</p>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2 sm:px-6">
            <p className="type-label">Matrix</p>
            {ran ? (
              <button
                type="button"
                className="ds-tab"
                aria-pressed={failuresOnly}
                onClick={() => setFailuresOnly((v) => !v)}
              >
                Failures
              </button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3 sm:px-6">
            {!playground.datasetId ? (
              <EmptyState compact title="Link a dataset" />
            ) : !ran ? (
              <EmptyState compact title="No results" />
            ) : visibleCases.length === 0 ? (
              <EmptyState
                compact
                title="No failures"
                action={
                  failuresOnly ? (
                    <button
                      type="button"
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                      onClick={() => setFailuresOnly(false)}
                    >
                      Show all
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <table className="w-full min-w-[24rem] border-collapse text-left">
                <thead>
                  <tr className="border-b border-[var(--line)]">
                    <th className="type-label py-2 pr-3 font-normal">Case</th>
                    {playground.variants.map((v) => (
                      <th
                        key={v.id}
                        className="type-label py-2 pr-3 font-normal"
                      >
                        {v.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleCases.map((c) => (
                    <tr key={c.id} className="border-b border-[var(--line)]">
                      <td className="type-meta max-w-[10rem] truncate py-2.5 pr-3">
                        {c.input}
                      </td>
                      {playground.variants.map((v) => {
                        const cell = matrix.find(
                          (m) => m.caseId === c.id && m.variantId === v.id,
                        );
                        const fallbackScore =
                          0.45 + ((c.id.length + v.id.length) % 50) / 100;
                        const pass = cell?.pass ?? fallbackScore >= 0.55;
                        const score = cell?.score ?? fallbackScore;
                        return (
                          <td
                            key={v.id}
                            className={cn(
                              "type-value py-2.5 pr-3 !text-[0.6875rem]",
                              !pass && "!text-[var(--error)]",
                              pass && "!text-[var(--success)]",
                            )}
                          >
                            {`${pass ? "Pass" : "Fail"} · ${formatScore(score)}`}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
