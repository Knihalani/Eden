"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  budgetStatusFromSpend,
  defaultDriverId,
  formatSpend,
  primaryFleetSpend24h,
  type CostBudgetFixture,
} from "@/lab/fixtures/cost";
import { PageHeader } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  BudgetChip,
  CostModeNav,
  parseCostMode,
  type CostMode,
} from "@/lab/cost/cost-chrome";
import dynamic from "next/dynamic";
import { catalogAgents, patchPortalCatalog } from "@/lib/portal-catalog";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey, queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { budgetApi } from "@/lib/api/budget";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";

const costFallback = (
  <div className="flex min-h-[12rem] flex-1 items-center justify-center px-5">
    <p className="type-meta">Loading…</p>
  </div>
);

const CostSpendView = dynamic(
  () =>
    import("@/lab/cost/cost-spend-view").then((m) => ({
      default: m.CostSpendView,
    })),
  { ssr: false, loading: () => costFallback },
);
const CostDriversView = dynamic(
  () =>
    import("@/lab/cost/cost-drivers-view").then((m) => ({
      default: m.CostDriversView,
    })),
  { ssr: false, loading: () => costFallback },
);

const BUDGET_QUERY_KEY = (orgId: string | null) =>
  queryKey("cost", orgId, "budget");

function LabCostInner() {
  const searchParams = useSearchParams();
  const paramMode = searchParams.get("mode");
  const paramId = searchParams.get("id");
  const paramAgent = searchParams.get("agent");

  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const agentsQuery = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
    SHELL_QUERY,
  );
  useEffect(() => {
    if (agentsQuery.data === undefined) return;
    patchPortalCatalog({ agents: agentsQuery.data });
  }, [agentsQuery.data]);
  const driversQuery = useOrgQuery(
    queryKeys.portal.costDrivers(orgId),
    orgId,
    () => portalApi.costDrivers(orgId!),
    SHELL_QUERY,
  );
  const budgetQuery = useOrgQuery(
    BUDGET_QUERY_KEY(orgId),
    orgId,
    () => budgetApi.get(orgId!),
    SHELL_QUERY,
  );

  const { agentId, agent: scopeAgent, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();

  const [mode, setMode] = useState<CostMode>(() => parseCostMode(paramMode));
  const [driverId, setDriverId] = useState("");

  const drivers = driversQuery.data ?? [];

  const budget: CostBudgetFixture = useMemo(() => {
    const rollup = budgetQuery.data?.data?.rollup;
    const spentUsd =
      rollup?.cost_used_usd != null ? Number(rollup.cost_used_usd) : 0;
    const limitUsd =
      rollup?.cost_hard_limit_usd != null
        ? Number(rollup.cost_hard_limit_usd)
        : 0;
    return {
      id: "bud_org_24h",
      name: "Org · 24h",
      scope: "org",
      limitUsd,
      spentUsd,
      period: "24h",
      status: budgetStatusFromSpend(spentUsd, limitUsd),
    };
  }, [budgetQuery.data]);

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) {
      setAgentId(paramAgent);
    }
  }, [paramAgent, agentId, setAgentId]);

  useEffect(() => {
    setMode(parseCostMode(paramMode));
  }, [paramMode]);

  // Keep Drivers selection inside the current agent scope.
  useEffect(() => {
    if (mode !== "drivers") return;
    const rows =
      agentId === "all"
        ? drivers
        : drivers.filter((d) => d.agentId === agentId);
    const next =
      rows.find((d) => d.id === paramId)?.id ??
      rows.find((d) => d.estSaveUsd > 0)?.id ??
      rows[0]?.id ??
      "";
    if (next && next !== driverId) setDriverId(next);
    else if (!next && driverId) setDriverId("");
     
  }, [agentId, mode, drivers, paramId]);

  const changeMode = useCallback(
    (next: CostMode) => {
      setMode(next);
      if (next === "spend") {
        patchQuery({ mode: null, id: null });
      } else {
        const id = defaultDriverId(agentId);
        setDriverId(id);
        patchQuery({ mode: "drivers", id: id || null });
      }
    },
    [patchQuery, agentId],
  );

  const filterAgent = useCallback(
    (id: string) => {
      setAgentId(id);
    },
    [setAgentId],
  );

  const selectDriver = useCallback(
    (id: string) => {
      setDriverId(id);
      setMode("drivers");
      patchQuery({ mode: "drivers", id });
    },
    [patchQuery],
  );

  const scopeCounts = useMemo(() => {
    const map: Record<string, number> = {
      all: drivers.length,
    };
    for (const a of catalogAgents()) {
      map[a.id] = drivers.filter((d) => d.agentId === a.id).length;
    }
    return map;
  }, [drivers]);

  const isLoading = driversQuery.isLoading || budgetQuery.isLoading;
  const isError = driversQuery.isError || budgetQuery.isError;

  if (isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Cost" />
        <QueryLoadingPanel label="Loading cost…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Cost" />
        <QueryErrorPanel
          error={driversQuery.error ?? budgetQuery.error}
          onRetry={() => {
            void driversQuery.refetch();
            void budgetQuery.refetch();
          }}
        />
      </div>
    );
  }

  // One primary spend figure — catalog/telemetry only. Gateway budget is a
  // separate rollup shown inside Spend mode; never compete in the header.
  const primary =
    agentId === "all"
      ? primaryFleetSpend24h()
      : {
          usd: scopeAgent?.costUsd24h ?? null,
          estimated: false,
          sourceLabel: "Telemetry · 24h",
        };
  const meta = (
    <span className="type-meta inline-flex flex-wrap items-center gap-2">
      <span>
        {scopeAgent ? scopeAgent.name : "All agents"} ·{" "}
        {primary.estimated ? "est. " : ""}
        {formatSpend(primary.usd)} / 24h
        <span className="text-[var(--text-muted)]">
          {" "}
          · {primary.sourceLabel}
        </span>
      </span>
      {agentId === "all" && budget.limitUsd > 0 ? (
        <BudgetChip status={budget.status} />
      ) : null}
    </span>
  );

  return (
    <div className="ds-page">
      <PageHeader
        title="Cost"
        meta={meta}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5">
              <span className="sr-only">Agent</span>
              <select
                className="ds-input !h-8 !w-auto max-w-[10rem] !py-0 !text-[0.75rem]"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                aria-label="Filter by agent"
              >
                <option value="all">
                  All agents
                  {scopeCounts.all != null ? ` (${scopeCounts.all})` : ""}
                </option>
                {catalogAgents().map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {scopeCounts[a.id] != null
                      ? ` (${scopeCounts[a.id]})`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <CostModeNav value={mode} onChange={changeMode} />
          </div>
        }
      />

      {mode === "spend" ? (
        <CostSpendView
          agentId={agentId}
          budget={budget}
          spendUsd={primary.usd}
          spendEstimated={primary.estimated}
          spendSourceLabel={primary.sourceLabel}
          onFilterAgent={filterAgent}
          onGoDrivers={() => changeMode("drivers")}
        />
      ) : (
        <CostDriversView
          agentId={agentId}
          selectedId={driverId}
          onSelect={selectDriver}
        />
      )}
    </div>
  );
}

export default function LabCostPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader
            title="Cost"
            meta={<span className="type-meta">Loading…</span>}
          />
        </div>
      }
    >
      <LabCostInner />
    </Suspense>
  );
}
