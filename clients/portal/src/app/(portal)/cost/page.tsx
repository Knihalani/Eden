"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  budgetStatusFromSpend,
  defaultDriverId,
  fleetSpend24h,
  formatSpend,
  totalDriverSaveUsd,
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
import { catalogAgents } from "@/lib/portal-catalog";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey, queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { api } from "@/lib/api/resources";
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
  { loading: () => costFallback },
);
const CostDriversView = dynamic(
  () =>
    import("@/lab/cost/cost-drivers-view").then((m) => ({
      default: m.CostDriversView,
    })),
  { loading: () => costFallback },
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
  const driversQuery = useOrgQuery(
    queryKeys.portal.costDrivers(orgId),
    orgId,
    () => portalApi.costDrivers(orgId!),
  );
  const budgetQuery = useOrgQuery(
    BUDGET_QUERY_KEY(orgId),
    orgId,
    () => api.getBudget(orgId!),
  );

  const { agentId, agent: scopeAgent, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();

  const [mode, setMode] = useState<CostMode>(() => parseCostMode(paramMode));
  const [driverId, setDriverId] = useState("");

  const drivers = driversQuery.data ?? [];

  const budget: CostBudgetFixture = useMemo(() => {
    const rollup = budgetQuery.data?.data?.rollup;
    const spentUsd = rollup?.cost_used_usd ?? 0;
    const limitUsd = rollup?.cost_hard_limit_usd ?? 0;
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

  const spend =
    agentId === "all"
      ? fleetSpend24h()
      : (scopeAgent?.costUsd24h ?? 0);
  const saveHint = totalDriverSaveUsd(agentId);
  const meta = (
    <span className="type-meta inline-flex flex-wrap items-center gap-2">
      <span>
        {scopeAgent ? scopeAgent.name : "All agents"} · {formatSpend(spend)} /
        24h
        {saveHint > 0 ? (
          <>
            {" "}
            ·{" "}
            <span className="text-[var(--success)]">
              −{formatSpend(saveHint)} drivers
            </span>
          </>
        ) : null}
      </span>
      {agentId === "all" ? <BudgetChip status={budget.status} /> : null}
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
