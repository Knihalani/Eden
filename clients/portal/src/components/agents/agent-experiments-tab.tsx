"use client";

/**
 * Agent detail — Experiments tab.
 *
 * Offline experiments API (backend src/eden/api/routes/experiments_offline.py):
 *   GET  /orgs/{org}/experiments/offline                    → list
 *   POST /orgs/{org}/experiments/offline/{id}/run           → run
 *   GET  /orgs/{org}/experiments/offline/{id}/compare       → compare
 * via the existing `offlineExperimentsApi` namespace in resources.ts.
 */

import { useState } from "react";
import { EmptyState } from "@/lab/lab-ui";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey } from "@/lib/query-keys";
import { offlineExperimentsApi } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { useLabToast } from "@/lab/lab-toast";
import { formatRelativeTime } from "@/lib/format";

type ExperimentRow = Record<string, unknown>;

function str(row: ExperimentRow, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v ? v : null;
}

function expId(row: ExperimentRow): string {
  return str(row, "id") ?? str(row, "experiment_id") ?? "";
}

type CompareResult = {
  summary?: Record<string, number>;
  datapoints?: Array<Record<string, unknown>>;
  baseline_experiment_id?: string | null;
  synthetic?: boolean;
  method?: string;
};

export function AgentExperimentsTab({
  orgId,
  agentId,
}: {
  orgId: string | null;
  agentId: string;
}) {
  const { pushToast } = useLabToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [compareFor, setCompareFor] = useState<string | null>(null);
  const [compare, setCompare] = useState<CompareResult | null>(null);

  const listQuery = useOrgQuery(
    queryKey("offlineExperiments", orgId),
    orgId,
    () => offlineExperimentsApi.list(orgId!),
    SHELL_QUERY,
  );

  const experiments = listQuery.data?.experiments ?? [];
  // Experiments carry the agent in config when seeded from an agent
  // surface — scope when present, show all otherwise (org-wide list).
  const scoped = experiments.filter((e) => {
    const config = e.config as Record<string, unknown> | undefined;
    const eAgent =
      (typeof config?.agent_id === "string" ? config.agent_id : null) ??
      str(e, "agent_id");
    return !eAgent || eAgent === agentId;
  });

  const runExperiment = async (id: string) => {
    if (!orgId || !id) return;
    setBusyId(id);
    try {
      const res = await offlineExperimentsApi.run(orgId, id);
      pushToast({
        title: "Experiment run started",
        body:
          res.result?.status || res.result?.rows != null
            ? `${res.result?.status ?? "ok"}${res.result?.rows != null ? ` · ${res.result.rows} rows` : ""}`
            : undefined,
        tone: "ok",
      });
      await listQuery.refetch();
    } catch (err) {
      pushToast({
        title: "Couldn't run experiment",
        body: err instanceof Error ? err.message : String(err),
        tone: "fail",
      });
    } finally {
      setBusyId(null);
    }
  };

  const compareExperiment = async (id: string) => {
    if (!orgId || !id) return;
    setBusyId(id);
    setCompareFor(id);
    setCompare(null);
    try {
      const res = await offlineExperimentsApi.compare(orgId, id);
      setCompare(res.compare ?? {});
    } catch (err) {
      setCompareFor(null);
      pushToast({
        title: "Couldn't compare experiment",
        body: err instanceof Error ? err.message : String(err),
        tone: "fail",
      });
    } finally {
      setBusyId(null);
    }
  };

  if (listQuery.isLoading) {
    return <QueryLoadingPanel label="Loading experiments…" />;
  }

  if (listQuery.isError) {
    return (
      <div className="p-5">
        <QueryErrorPanel
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
        />
      </div>
    );
  }

  if (scoped.length === 0) {
    return (
      <EmptyState
        title="No experiments yet"
        body="Offline experiments run a dataset against this agent's configuration. Seed one from Evals or the API."
        compact
      />
    );
  }

  return (
    <div className="space-y-3 p-4 sm:p-5">
      <div className="px-1">
        <h3 className="type-ui">Offline experiments</h3>
        <p className="type-meta mt-0.5">
          {scoped.length} experiment{scoped.length === 1 ? "" : "s"} · run
          against saved datasets, then compare to a baseline
        </p>
      </div>
      <ul className="divide-y divide-[var(--line)] border border-[var(--line)]">
        {scoped.map((e) => {
          const id = expId(e);
          const name = str(e, "name") ?? id;
          const status = str(e, "status");
          const createdAt = str(e, "created_at");
          const isBusy = busyId === id;
          return (
            <li key={id || name} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="type-ui min-w-0 truncate">{name}</p>
                  <p className="type-meta mt-0.5">
                    {status ? <>{status} · </> : null}
                    {createdAt ? (
                      <>created {formatRelativeTime(createdAt)} · </>
                    ) : null}
                    <span className="font-mono text-[0.7rem]">{id.slice(0, 12)}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className="ds-btn ds-btn-outline ds-btn-sm"
                    disabled={isBusy || !id}
                    onClick={() => void runExperiment(id)}
                  >
                    {isBusy ? "Working…" : "Run"}
                  </button>
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm"
                    disabled={isBusy || !id}
                    onClick={() => void compareExperiment(id)}
                  >
                    Compare
                  </button>
                </div>
              </div>
              {compareFor === id && compare ? (
                <div className="mt-2 border border-[var(--line)] bg-[var(--bg-inset)] px-3 py-2">
                  {compare.summary && Object.keys(compare.summary).length > 0 ? (
                    <p className="type-meta">
                      {Object.entries(compare.summary)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ")}
                      {compare.baseline_experiment_id ? (
                        <> · vs {String(compare.baseline_experiment_id).slice(0, 12)}</>
                      ) : null}
                    </p>
                  ) : (
                    <p className="type-meta">
                      No comparison data yet — run this experiment (and a
                      baseline) first.
                    </p>
                  )}
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm mt-1"
                    onClick={() => {
                      setCompareFor(null);
                      setCompare(null);
                    }}
                  >
                    Hide
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
