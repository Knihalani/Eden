"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { FlaskConical, Play, Loader2, ArrowUpRight, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import {
  playgroundApi,
  datasetsApi,
  type PersistedPlayground,
  type Dataset,
} from "@/lib/api";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { CoreResourcePage } from "@/components/portal-os";
import { EmptyState } from "@/components/ui/empty-state";

type RunMatrix = {
  run_id?: string;
  cost_usd?: number;
  matrix?: Array<{
    row_id: string;
    input?: string;
    grade?: string;
    score_delta?: number;
    tasks?: Array<{ label?: string; model?: string; response?: string; cost_usd?: number }>;
  }>;
};

function PlaygroundsInner() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const searchParams = useSearchParams();
  const router = useRouter();
  const embedded = useEmbeddedSurface();
  const [playgrounds, setPlaygrounds] = useState<PersistedPlayground[]>([]);
  const [active, setActive] = useState<PersistedPlayground | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [userPrompt, setUserPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunMatrix | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    const [pg, ds] = await Promise.all([
      playgroundApi.list(currentOrg.id),
      datasetsApi.list(currentOrg.id),
    ]);
    setPlaygrounds(pg.playgrounds || []);
    setDatasets(ds.datasets || []);
    if (!active && pg.playgrounds?.[0]) setActive(pg.playgrounds[0]);
  }, [currentOrg?.id, active]);

  useEffect(() => {
    void load().catch((e) => toast.error(e instanceof Error ? e.message : "Load failed"));
    // Intentionally org-scoped only — `load` closes over `active` and would loop.
  }, [currentOrg?.id]);

  // Open-from-span: ?trace_id=&span_id=
  useEffect(() => {
    const traceId = searchParams.get("trace_id");
    if (!traceId || !currentOrg?.id) return;
    const spanId = searchParams.get("span_id") || undefined;
    void (async () => {
      try {
        const res = await playgroundApi.fromSpan(currentOrg.id, {
          trace_id: traceId,
          span_id: spanId,
          messages: [{ role: "user", content: `Replay from trace ${traceId}` }],
        });
        setActive(res.playground);
        setPlaygrounds((prev) => [res.playground, ...prev]);
        toast.success("Playground created from span");
        router.replace("/evals?tab=playgrounds");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "from-span failed");
      }
    })();
  }, [searchParams, currentOrg?.id]);

  const createNew = async () => {
    if (!currentOrg?.id) return;
    setBusy(true);
    try {
      const res = await playgroundApi.create(currentOrg.id, {
        name: `Playground ${new Date().toLocaleString()}`,
        config: {
          tasks: [
            { id: "task_a", label: "A", system: "", user: "{{user}}", model: "t1", tools: [] },
            { id: "task_b", label: "B", system: "", user: "{{user}}", model: "t2", tools: [] },
          ],
          scorers: [{ name: "exact_match" }],
        },
      });
      setActive(res.playground);
      await load();
      toast.success("Playground saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const bindDataset = async (datasetId: string) => {
    if (!currentOrg?.id || !active) return;
    const cfg = { ...(active.config || {}), dataset_id: datasetId || null };
    const res = await playgroundApi.patch(currentOrg.id, active.id, { config: cfg });
    setActive(res.playground);
    toast.success(datasetId ? "Dataset bound" : "Dataset unbound");
  };

  const runMatrix = async () => {
    if (!currentOrg?.id || !active) return;
    setBusy(true);
    try {
      let datasetRows: Array<Record<string, unknown>> | undefined;
      const dsId = active.config?.dataset_id as string | undefined;
      if (dsId) {
        const detail = await datasetsApi.get(currentOrg.id, dsId);
        datasetRows = (detail.rows || []).slice(0, 20).map((r) => ({
          id: r.id,
          input: String(r.values?.input ?? r.values?.prompt ?? userPrompt),
          expected_output: String(r.values?.expected_output ?? r.values?.expected ?? ""),
        }));
      }
      const res = await playgroundApi.runPersisted(currentOrg.id, active.id, {
        params: { user: userPrompt },
        dataset_rows: datasetRows,
      });
      setRun(res.run as RunMatrix);
      toast.success(`Run complete · $${Number(res.run.cost_usd ?? 0).toFixed(4)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Run failed");
    } finally {
      setBusy(false);
    }
  };

  const promote = async () => {
    if (!currentOrg?.id || !active) return;
    const dsId = active.config?.dataset_id as string | undefined;
    if (!dsId) {
      toast.error("Bind a dataset before promoting to experiment");
      return;
    }
    try {
      const res = await playgroundApi.promoteExperiment(currentOrg.id, active.id, {
        dataset_id: dsId,
      });
      const expId = String(res.experiment?.id || "");
      toast.success("Promoted to experiment");
      router.push(
        expId ? `/evals?tab=experiments&experimentId=${expId}` : "/evals?tab=experiments",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Promote failed");
    }
  };

  if (!currentOrg) return <NoOrgState feature="Playground" />;

  const boundDatasetId = (active?.config?.dataset_id as string) || "";
  const canPromote = Boolean(boundDatasetId);
  const canRun = Boolean(userPrompt.trim() || boundDatasetId);
  const runDisabledReason = !canRun
    ? "Enter a user message or bind a dataset to run"
    : undefined;
  const promoteDisabledReason = !canPromote
    ? "Bind a dataset before promoting to an experiment"
    : undefined;

  const primaryActions =
    playgrounds.length === 0 && !busy ? null : (
      <>
        <Button className="min-h-11" onClick={createNew} disabled={busy} loading={busy}>
          New playground
        </Button>
        {!embedded ? (
          <Button asChild variant="outline" className="min-h-11">
            <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
              Docs quickstart
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          </Button>
        ) : null}
      </>
    );

  return (
    <CoreResourcePage
      size="wide"
      header={
        <PageHeader
          eyebrow="Evaluate"
          title="Prompt playground"
          subtitle="Compare prompts side-by-side, bind a dataset, then promote to an offline experiment."
          icon={FlaskConical}
          actions={primaryActions}
        />
      }
      table={
        <>
          {!embedded ? (
            <p className="mb-4 text-sm text-[var(--text-muted)]">
              Offline Evaluate only.{" "}
              <Link
                href="/evals?tab=datasets"
                className="text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Datasets
              </Link>
              {" · "}
              <Link
                href="/evals?tab=experiments"
                className="text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Experiments
              </Link>
              .
            </p>
          ) : null}

          {!playgrounds.length && !busy ? (
            <EmptyState
              icon={FlaskConical}
              title="No playgrounds yet"
              description={U20_EMPTY_COPY.playground}
              variant="plain"
              className="mb-4"
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button className="min-h-11" onClick={createNew} disabled={busy}>
                    Create playground
                  </Button>
                  <Button asChild variant="outline" className="min-h-11">
                    <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                      Docs quickstart
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </a>
                  </Button>
                </div>
              }
            />
          ) : null}

          {playgrounds.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Saved playgrounds">
              {playgrounds.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setActive(p)}
                  aria-pressed={active?.id === p.id}
                  className={`min-h-11 rounded border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                    active?.id === p.id
                      ? "border-[var(--accent)] text-[var(--accent)]"
                      : "border-[var(--border-default)] text-[var(--text-muted)]"
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          ) : null}

          {active ? (
            <Card className="mb-4 space-y-3 p-4">
              <FormField label="User message" htmlFor="pg-user">
                <textarea
                  id="pg-user"
                  className="mt-1 min-h-[100px] w-full rounded-md border border-[var(--border-default)] bg-[var(--surface-raised)] p-2 text-sm"
                  value={userPrompt}
                  onChange={(e) => setUserPrompt(e.target.value)}
                  placeholder="Paste span input or draft prompt…"
                />
              </FormField>
              <FormField label="Bind dataset" htmlFor="pg-ds">
                <select
                  id="pg-ds"
                  className="mt-1 min-h-11 w-full rounded-md border border-[var(--border-default)] bg-[var(--surface-raised)] p-2 text-sm"
                  value={boundDatasetId}
                  onChange={(e) => void bindDataset(e.target.value)}
                >
                  <option value="">None (adhoc run)</option>
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                {datasets.length === 0 ? (
                  <p className="mt-1.5 text-xs text-[var(--text-muted)]">
                    <Link
                      href="/evals?tab=datasets"
                      className="text-[var(--accent)] underline-offset-2 hover:underline"
                    >
                      Create a dataset
                    </Link>{" "}
                    to enable promote → experiment.
                  </p>
                ) : null}
              </FormField>
              <div className="flex flex-wrap items-center gap-2">
                <span title={runDisabledReason} className="inline-flex">
                  <Button
                    className="min-h-11"
                    onClick={runMatrix}
                    disabled={busy || !canRun}
                    loading={busy}
                    aria-disabled={busy || !canRun}
                    aria-describedby={!canRun ? "pg-run-reason" : undefined}
                  >
                    <Play className="h-3.5 w-3.5" /> Run matrix
                  </Button>
                </span>
                <span title={promoteDisabledReason} className="inline-flex">
                  <Button
                    className="min-h-11"
                    variant="outline"
                    onClick={promote}
                    disabled={busy || !canPromote}
                    aria-disabled={busy || !canPromote}
                    aria-describedby={!canPromote ? "pg-promote-reason" : undefined}
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" /> Promote → experiment
                  </Button>
                </span>
              </div>
              {!canRun ? (
                <p id="pg-run-reason" className="text-xs text-[var(--text-muted)]">
                  {runDisabledReason}
                </p>
              ) : null}
              {!canPromote ? (
                <p id="pg-promote-reason" className="text-xs text-[var(--text-muted)]">
                  {promoteDisabledReason}
                </p>
              ) : null}
            </Card>
          ) : null}

          {run ? (
            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">Matrix results</span>
                <span className="text-[var(--text-muted)]">
                  cost_usd ${Number(run.cost_usd ?? 0).toFixed(4)}
                </span>
              </div>
              {(run.matrix || []).map((row) => (
                <div key={row.row_id} className="rounded border border-[var(--border-default)] p-3">
                  <div className="mb-2 flex gap-3 text-xs text-[var(--text-muted)]">
                    <span>grade: {row.grade}</span>
                    <span>Δ {Number(row.score_delta ?? 0).toFixed(3)}</span>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {(row.tasks || []).map((t, i) => (
                      <div key={i} className="rounded bg-[var(--surface-raised)] p-2">
                        <div className="mb-1 text-xs font-medium">
                          {t.label || t.model} · ${Number(t.cost_usd ?? 0).toFixed(4)}
                        </div>
                        <pre className="whitespace-pre-wrap text-xs">{t.response}</pre>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </Card>
          ) : null}
        </>
      }
    />
  );
}

export default function PlaygroundsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <PlaygroundsInner />
    </Suspense>
  );
}
