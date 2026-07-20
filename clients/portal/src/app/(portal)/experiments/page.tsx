"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import Link from "next/link";
import { BarChart3, FlaskConical, Play, RefreshCw, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { offlineExperimentsApi } from "@/lib/api";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import {
  CoreResourcePage,
  DetailPanelShell,
  useResourceUrlState,
  InfiniteDataTable,
  ResourceOsToolbar,
} from "@/components/portal-os";
import { usePagePerf } from "@/lib/perf";
import { CrossLinkBar } from "@/components/portal-os/CrossLinkBar";
import { datasetHref, issueHref, playgroundHref } from "@/lib/portal-cross-links";
import { charDiff } from "@/lib/char-diff";
import { ErrorState } from "@/components/ui/error-state";
import {
  interpretOfflineRunResult,
  isTerminalExperimentStatus,
} from "@/lib/eval-run-outcome";

type ExperimentRow = {
  id: string;
  name: string;
  dataset_id: string;
  status: string;
  source_issue_id?: string | null;
  created_at: string;
};

type Datapoint = {
  row_id?: string;
  grade?: string;
  score_delta?: number;
  control_output?: Record<string, unknown> | string;
  treatment_output?: Record<string, unknown> | string;
  input_data?: Record<string, unknown> | string;
};

function outputText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as { output?: string };
      return String(parsed.output ?? v);
    } catch {
      return v;
    }
  }
  if (typeof v === "object" && v && "output" in v) {
    return String((v as { output?: unknown }).output ?? JSON.stringify(v));
  }
  return JSON.stringify(v);
}

function ExperimentsPageInner() {
  const { currentOrg } = useOrg();
  usePagePerf("/experiments");
  const toast = useToast();
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const experimentId = urlState.experimentId;
  const [rows, setRows] = useState<ExperimentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [datapoints, setDatapoints] = useState<Datapoint[]>([]);
  const [compareMeta, setCompareMeta] = useState<{
    synthetic?: boolean;
    method?: string;
  } | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [diffOpen, setDiffOpen] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await offlineExperimentsApi.list(currentOrg.id);
      setRows((res.experiments as ExperimentRow[]) || []);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load experiments";
      setLoadError(message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const loadCompare = useCallback(
    async (id: string, baselineId?: string) => {
      if (!currentOrg?.id) return;
      setSummaryLoading(true);
      setCompareError(null);
      try {
        const res = await offlineExperimentsApi.compare(currentOrg.id, id, baselineId);
        setSummary((res.compare?.summary as Record<string, number>) || null);
        setDatapoints((res.compare?.datapoints as Datapoint[]) || []);
        setCompareMeta({
          synthetic: Boolean(res.compare?.synthetic),
          method: typeof res.compare?.method === "string" ? res.compare.method : undefined,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Compare failed";
        setCompareError(message);
        setSummary(null);
        setDatapoints([]);
        setCompareMeta(null);
      } finally {
        setSummaryLoading(false);
      }
    },
    [currentOrg?.id],
  );

  useEffect(() => {
    if (!experimentId || !currentOrg?.id) {
      setSummary(null);
      setDatapoints([]);
      setCompareMeta(null);
      setCompareError(null);
      return;
    }
    const baseline =
      selected.size === 2
        ? [...selected].find((id) => id !== experimentId)
        : undefined;
    void loadCompare(experimentId, baseline);
  }, [experimentId, currentOrg?.id, loadCompare, selected]);

  const pollUntilTerminal = useCallback(
    async (id: string): Promise<"completed" | "failed" | "timeout"> => {
      if (!currentOrg?.id) return "timeout";
      const maxAttempts = 30;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, 1000));
        const res = await offlineExperimentsApi.list(currentOrg.id);
        const experiments = (res.experiments as ExperimentRow[]) || [];
        setRows(experiments);
        const row = experiments.find((e) => e.id === id);
        if (!row) continue;
        if (row.status === "completed") return "completed";
        if (row.status === "failed") return "failed";
        if (isTerminalExperimentStatus(row.status)) {
          return "failed";
        }
      }
      return "timeout";
    },
    [currentOrg?.id],
  );

  const runExperiment = async (id: string) => {
    if (!currentOrg?.id || runningId) return;
    setRunningId(id);
    setRunError(null);
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status: "running" } : r)),
    );
    try {
      const res = await offlineExperimentsApi.run(currentOrg.id, id);
      const outcome = interpretOfflineRunResult(res.result);
      if (outcome.kind === "in_progress") {
        const terminal = await pollUntilTerminal(id);
        if (terminal === "completed") {
          toast.success(
            outcome.synthetic
              ? "Heuristic stub run finished — not a live model eval"
              : "Experiment completed",
          );
        } else if (terminal === "failed") {
          const message = "Experiment run failed";
          setRunError(message);
          toast.error(message);
        } else {
          const message = "Timed out waiting for experiment status";
          setRunError(message);
          toast.error(message);
        }
      } else if (outcome.kind === "completed") {
        toast.success(outcome.message);
      } else {
        setRunError(outcome.message);
        toast.error(outcome.message);
      }
      await load();
      setUrlState({ experimentId: id });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Run failed";
      setRunError(message);
      toast.error(message);
      await load();
    } finally {
      setRunningId(null);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        if (next.size >= 2) next.clear();
        next.add(id);
      }
      return next;
    });
  };

  const compareSelected = () => {
    const ids = [...selected];
    if (ids.length < 2) {
      toast.error("Select exactly two experiments");
      return;
    }
    setUrlState({ experimentId: ids[0] });
  };

  const selectedRow = experimentId ? rows.find((r) => r.id === experimentId) ?? null : null;
  const selectedIndex = experimentId ? rows.findIndex((r) => r.id === experimentId) : -1;

  if (!currentOrg) return <NoOrgState feature="Experiments" />;

  return (
    <CoreResourcePage
      size="wide"
      header={
        <PageHeader
          eyebrow="Evaluate"
          title="Offline experiments"
          subtitle="Multi-select compare · grades · character diff."
          icon={BarChart3}
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={selected.size !== 2}
                onClick={compareSelected}
              >
                Compare selected ({selected.size}/2)
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/evals?tab=playgrounds">Open playground</Link>
              </Button>
              <Button onClick={load} variant="outline" size="sm" disabled={loading} loading={loading}>
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
            </>
          }
        />
      }
      toolbar={
        <ResourceOsToolbar
          resourceKey="experiments"
          exportRows={rows.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            dataset_id: r.dataset_id,
          }))}
          exportFilename="experiments.csv"
        />
      }
      table={
        <Card className="p-2">
          {runError && !loading ? (
            <ErrorState
              title="Could not start run"
              message={runError}
              className="mb-2"
              action={
                <Button onClick={() => setRunError(null)} variant="outline" size="sm">
                  Dismiss
                </Button>
              }
            />
          ) : null}
          {loadError && !loading ? (
            <ErrorState
              title="Could not load experiments"
              message={loadError}
              action={
                <Button onClick={load} variant="outline" size="sm">
                  Try again
                </Button>
              }
            />
          ) : (
            <InfiniteDataTable
              loading={loading}
              rows={rows}
              rowKey={(r) => r.id}
              emptyTitle="No experiments yet"
              emptyDescription={U20_EMPTY_COPY.experiments}
              emptyIcon={FlaskConical}
              emptyAction={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button asChild size="sm">
                    <Link href="/evals?tab=datasets">Open datasets</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/evals?tab=playgrounds">Open playground</Link>
                  </Button>
                </div>
              }
              columns={[
                {
                  key: "select",
                  header: "",
                  cell: (r) => (
                    <Checkbox
                      checked={selected.has(r.id)}
                      onCheckedChange={() => toggleSelect(r.id)}
                      aria-label={`Select ${r.name}`}
                    />
                  ),
                },
                { key: "name", header: "Name", cell: (r) => r.name },
                { key: "status", header: "Status", cell: (r) => r.status },
                {
                  key: "dataset",
                  header: "Dataset",
                  cell: (r) => (
                    <Link href={`/datasets/${r.dataset_id}`} className="text-[var(--accent)] hover:underline">
                      {r.dataset_id.slice(0, 8)}…
                    </Link>
                  ),
                },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  cell: (r) => (
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Boolean(runningId)}
                        loading={runningId === r.id}
                        onClick={() => runExperiment(r.id)}
                      >
                        <Play className="h-3 w-3" /> {runningId === r.id ? "Running…" : "Run"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setUrlState({ experimentId: r.id })}>
                        Compare
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </Card>
      }
      detail={
        experimentId ? (
          <DetailPanelShell
            open
            onClose={() => {
              setUrlState({ experimentId: undefined });
              setSummary(null);
              setDatapoints([]);
              setCompareMeta(null);
              setCompareError(null);
            }}
            title={selectedRow?.name ?? "Experiment"}
            onPrev={
              selectedIndex > 0
                ? () => setUrlState({ experimentId: rows[selectedIndex - 1]!.id })
                : undefined
            }
            onNext={
              selectedIndex >= 0 && selectedIndex < rows.length - 1
                ? () => setUrlState({ experimentId: rows[selectedIndex + 1]!.id })
                : undefined
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (!experimentId) return;
                      const baseline =
                        selected.size === 2
                          ? [...selected].find((id) => id !== experimentId)
                          : undefined;
                      void loadCompare(experimentId, baseline);
                    }}
                  >
                    Try again
                  </Button>
                }
              />
            ) : summary ? (
              <div className="flex h-full flex-col">
                <CrossLinkBar
                  links={[
                    ...(selectedRow?.dataset_id
                      ? [{ label: "Dataset", href: datasetHref(selectedRow.dataset_id) }]
                      : []),
                    { label: "Playground", href: playgroundHref() },
                    ...(selectedRow?.source_issue_id
                      ? [{ label: "Source issue", href: issueHref(selectedRow.source_issue_id) }]
                      : []),
                  ]}
                />
                <div className="p-4">
                  {compareMeta?.synthetic ? (
                    <div
                      className="mb-3 rounded border border-[var(--warning)]/40 bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning)]"
                      role="status"
                    >
                      Heuristic stub scores — not a live model eval
                      {compareMeta.method ? ` (${compareMeta.method})` : ""}.
                    </div>
                  ) : null}
                  <h3 className="mb-3 text-sm font-medium">Compare summary</h3>
                  <div className="mb-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                    {Object.entries(summary).map(([grade, count]) => (
                      <div key={grade} className="rounded border border-[var(--border-default)] p-2">
                        <div className="capitalize text-[var(--text-muted)]">{grade}</div>
                        <div className="text-lg font-semibold">{count}</div>
                      </div>
                    ))}
                  </div>
                  <h3 className="mb-2 text-sm font-medium">Datapoints</h3>
                  <ul className="max-h-[50vh] space-y-2 overflow-auto">
                    {datapoints.map((dp, idx) => {
                      const control = outputText(dp.control_output);
                      const treatment = outputText(dp.treatment_output);
                      const diff = charDiff(control, treatment);
                      const key = String(dp.row_id || idx);
                      return (
                        <li
                          key={key}
                          className="rounded border border-[var(--border-default)] p-2 text-xs"
                        >
                          <div className="mb-1 flex flex-wrap gap-2">
                            <span className="font-medium capitalize">{dp.grade || "—"}</span>
                            <span className="text-[var(--text-muted)]">
                              Δ {Number(dp.score_delta ?? 0).toFixed(3)}
                            </span>
                            <button
                              type="button"
                              className="text-[var(--accent)] hover:underline"
                              onClick={() => setDiffOpen(diffOpen === key ? null : key)}
                            >
                              {diff.equal ? "identical" : "char diff"}
                            </button>
                          </div>
                          {diffOpen === key && !diff.equal ? (
                            <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-raised)] p-2">
                              <span className="text-[var(--text-muted)]">{diff.commonPrefix}</span>
                              <span className="bg-[var(--error-bg)] line-through">{diff.leftOnly}</span>
                              <span className="bg-[var(--success-bg)]">{diff.rightOnly}</span>
                              <span className="text-[var(--text-muted)]">{diff.commonSuffix}</span>
                            </pre>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="p-4 text-sm text-[var(--text-muted)]">
                No compare data yet. Run the experiment first.
              </p>
            )}
          </DetailPanelShell>
        ) : null
      }
    />
  );
}

export default function ExperimentsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <ExperimentsPageInner />
    </Suspense>
  );
}
