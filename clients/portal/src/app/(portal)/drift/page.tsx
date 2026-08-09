"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Activity, RotateCcw } from "lucide-react";
import { PageHeader, StatusChip } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { driftApi, type DriftReport } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useLabToast } from "@/lab/lab-toast";

function pct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

/**
 * `/drift` — PSI-based output/embedding drift detection (FEAT-89).
 *
 * Backs the predictive drift backend (`predictive/drift.py` +
 * `insights/drift_reports.py`): pick an agent, see per-dimension PSI
 * vs baseline, flag dimensions past the threshold, and force a
 * recompute. This is the "Phoenix/Datadog parity" capability that had
 * zero portal surface before this page.
 */
function DriftInner() {
  const searchParams = useSearchParams();
  const paramAgent = searchParams.get("agent");

  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { pushToast } = useLabToast();
  const [agentId, setAgentId] = useState<string>(() => paramAgent ?? "");

  const agentsQuery = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
    SHELL_QUERY,
  );

  // Auto-select the first agent when none chosen yet.
  const agents = agentsQuery.data ?? [];
  useEffect(() => {
    if (paramAgent) setAgentId(paramAgent);
  }, [paramAgent]);
  useEffect(() => {
    if (!agentId && agents.length > 0) setAgentId(agents[0].id);
  }, [agentId, agents]);

  const reportQuery = useOrgQuery(
    queryKeys.portal.drift(orgId, agentId),
    orgId,
    () => driftApi.report(orgId!, agentId),
    { ...SHELL_QUERY, enabled: Boolean(orgId && agentId) },
  );

  const recompute = useOrgMutation(
    async (aid: string) => driftApi.compute(orgId!, aid),
    {
      onSuccess: () => {
        pushToast({ title: "Drift recomputed", tone: "ok" });
        void reportQuery.refetch();
      },
      onError: (err: Error) => {
        pushToast({ title: "Recompute failed", body: err.message, tone: "fail" });
      },
    },
  );

  const report: DriftReport | null = reportQuery.data?.data?.report ?? null;
  const flaggedCount = useMemo(
    () => (report?.dimensions ?? []).filter((d) => d.flagged).length,
    [report],
  );

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Drift"
        message="Select a workspace to view drift detection."
      />
    );
  }

  const meta = (
    <span className="type-meta">
      {agents.length} agent{agents.length === 1 ? "" : "s"} ·{" "}
      {report ? `${flaggedCount} flagged dimension${flaggedCount === 1 ? "" : "s"}` : "no report yet"}
    </span>
  );

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Drift"
        meta={meta}
        actions={
          <button
            type="button"
            className="ds-btn ds-btn-outline ds-btn-sm"
            disabled={!agentId || recompute.isPending}
            onClick={() => void recompute.mutateAsync(agentId)}
          >
            <RotateCcw className="h-4 w-4" />
            Recompute
          </button>
        }
      />

      <div className="border-b border-[var(--line)] px-4 py-3 sm:px-5">
        <label
          htmlFor="drift-agent"
          className="type-meta mb-1 block text-[var(--text-muted)]"
        >
          Agent
        </label>
        <select
          id="drift-agent"
          className="ds-input h-9 w-full max-w-sm"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          {agents.length === 0 && <option value="">No agents</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
        {!agentId ? (
          <EmptyState title="Pick an agent" body="Select an agent to load its drift report." />
        ) : reportQuery.isLoading ? (
          <QueryLoadingPanel label="Loading drift report…" />
        ) : reportQuery.isError ? (
          <QueryErrorPanel
            error={reportQuery.error}
            onRetry={() => void reportQuery.refetch()}
          />
        ) : !report ? (
          <EmptyState
            title="No drift report"
            body="No baseline exists for this agent yet — run Recompute to generate one."
          />
        ) : (
          <>
            <div className="ds-panel mb-4 p-4">
              <div className="flex items-start gap-3">
                <Activity className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" />
                <div>
                  <h3 className="type-ui">Summary</h3>
                  <p className="mt-1 text-sm text-[var(--text-muted)]">
                    {report.plain_english_summary}
                  </p>
                  <p className="type-meta mt-1 text-[var(--text-faint)]">
                    {report.report_period_start?.slice(0, 10) ?? "—"} →{" "}
                    {report.report_period_end?.slice(0, 10) ?? "—"}
                  </p>
                </div>
              </div>
            </div>

            <h3 className="type-ui mb-2 text-[var(--text-muted)]">
              Dimensions (PSI vs baseline)
            </h3>
            <div className="ds-panel overflow-x-auto">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--line)] text-[var(--text-muted)]">
                    <th className="px-4 py-2 font-normal">Dimension</th>
                    <th className="px-4 py-2 font-normal">PSI</th>
                    <th className="px-4 py-2 font-normal">Δ mean</th>
                    <th className="px-4 py-2 font-normal">Samples</th>
                    <th className="px-4 py-2 font-normal">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {report.dimensions.map((d) => (
                    <tr
                      key={d.dimension}
                      className="border-b border-[var(--line)] last:border-b-0"
                    >
                      <td className="px-4 py-2">{d.dimension}</td>
                      <td className="px-4 py-2 font-mono text-xs">{d.psi.toFixed(4)}</td>
                      <td className="px-4 py-2 font-mono text-xs">{pct(d.delta_pct)}</td>
                      <td className="px-4 py-2 text-[var(--text-muted)]">{d.sample_count}</td>
                      <td className="px-4 py-2">
                        <StatusChip tone={d.flagged ? "fail" : "live"}>
                          {d.flagged ? "flagged" : "stable"}
                        </StatusChip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function DriftPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page flex min-h-0 flex-1 items-center justify-center">
          <p className="type-meta">Loading drift…</p>
        </div>
      }
    >
      <DriftInner />
    </Suspense>
  );
}
