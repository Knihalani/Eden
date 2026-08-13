"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  budgetStatusFromSpend,
  formatSpend,
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
import { patchPortalCatalog } from "@/lib/portal-catalog";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { usePermissions } from "@/hooks/use-permissions";
import { queryKey, queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { budgetApi, type SamplingStatsPayload } from "@/lib/api/budget";
import { api } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import {
  InlineLoading,
  LoadingFallback,
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import {
  EditBudgetDialog,
  type BudgetFormValues,
} from "@/lab/cost/edit-budget-dialog";
import { useLabToast } from "@/lab/lab-toast";

const costFallback = <LoadingFallback label="Loading cost…" />;

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
  const paramTab = searchParams.get("tab");
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
  // Soft-load for Costliest runs — not in the Spend/Drivers loading gate.
  const tracesQuery = useOrgQuery(
    queryKeys.portal.traces(orgId),
    orgId,
    () => portalApi.traces(orgId!),
    SHELL_QUERY,
  );
  // W3-1 (1.4): soft-load — not part of the loading gate; shows only when
  // the org has sampling active. Always succeed-open (null on error).
  const samplingStatsQuery = useOrgQuery(
    queryKeys.portal.samplingStats(orgId),
    orgId,
    () => budgetApi.samplingStats(orgId!),
    { ...SHELL_QUERY, retry: false },
  );
  // W3-4: soft-load plan limits for the usage-meter panel. 503 when billing
  // is off (default) — treat any error as null so the meter is hidden.
  const planLimitsQuery = useOrgQuery(
    queryKeys.portal.planLimits(orgId),
    orgId,
    () => budgetApi.planLimits(orgId!),
    { ...SHELL_QUERY, retry: false },
  );

  const { agentId, agent: scopeAgent, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();
  const { hasPermission } = usePermissions();
  const { pushToast } = useLabToast();

  const [mode, setMode] = useState<CostMode>(() =>
    parseCostMode(paramMode, paramTab),
  );
  const [driverId, setDriverId] = useState("");
  const [budgetDialogOpen, setBudgetDialogOpen] = useState(false);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetSaveError, setBudgetSaveError] = useState<string | null>(null);

  const drivers = driversQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const traces = tracesQuery.data ?? [];

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

  const budgetFormInitial: BudgetFormValues = useMemo(() => {
    const b = budgetQuery.data?.data?.budget;
    return {
      cost_soft_limit_usd: b?.cost_soft_limit_usd ?? 0,
      cost_hard_limit_usd: b?.cost_hard_limit_usd ?? 0,
      enforcement_enabled: b?.enforcement_enabled ?? true,
      window: (b?.window as BudgetFormValues["window"]) ?? "monthly",
      action_on_exceed:
        (b?.action_on_exceed as BudgetFormValues["action_on_exceed"]) ??
        "throttle",
      alert_thresholds: b?.alert_thresholds ?? [50, 80, 100],
    };
  }, [budgetQuery.data]);

  const canEditBudget = hasPermission("billing:edit");

  const saveBudget = useCallback(
    async (values: BudgetFormValues) => {
      if (!orgId) return;
      setBudgetSaving(true);
      setBudgetSaveError(null);
      try {
        await api.upsertBudget(orgId, {
          cost_soft_limit_usd: values.cost_soft_limit_usd,
          cost_hard_limit_usd: values.cost_hard_limit_usd,
          enforcement_enabled: values.enforcement_enabled,
          window: values.window,
          action_on_exceed: values.action_on_exceed,
          threshold_alert_pct: Math.max(...values.alert_thresholds, 100),
          alert_thresholds: values.alert_thresholds,
        });
        await budgetQuery.refetch();
        setBudgetDialogOpen(false);
        pushToast({ title: "Budget saved", tone: "ok" });
      } catch (err) {
        setBudgetSaveError(err instanceof Error ? err.message : String(err));
      } finally {
        setBudgetSaving(false);
      }
    },
    [orgId, budgetQuery, pushToast],
  );

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) {
      setAgentId(paramAgent);
    }
  }, [paramAgent, agentId, setAgentId]);

  useEffect(() => {
    setMode(parseCostMode(paramMode, paramTab));
  }, [paramMode, paramTab]);

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
        const rows =
          agentId === "all"
            ? drivers
            : drivers.filter((d) => d.agentId === agentId);
        const id =
          rows.find((d) => d.estSaveUsd > 0)?.id ?? rows[0]?.id ?? "";
        setDriverId(id);
        patchQuery({ mode: "drivers", id: id || null });
      }
    },
    [patchQuery, agentId, drivers],
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
    for (const a of agents) {
      map[a.id] = drivers.filter((d) => d.agentId === a.id).length;
    }
    return map;
  }, [drivers, agents]);

  const isLoading =
    agentsQuery.isLoading || driversQuery.isLoading || budgetQuery.isLoading;
  const isError =
    agentsQuery.isError || driversQuery.isError || budgetQuery.isError;

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Cost"
        message="Select a workspace to view cost."
      />
    );
  }

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
          error={
            agentsQuery.error ?? driversQuery.error ?? budgetQuery.error
          }
          onRetry={() => {
            void agentsQuery.refetch();
            void driversQuery.refetch();
            void budgetQuery.refetch();
          }}
        />
      </div>
    );
  }

  // One primary spend figure — telemetry from agents query. Gateway budget is a
  // separate rollup shown inside Spend mode; never compete in the header.
  const known = agents
    .map((a) => a.costUsd24h)
    .filter((c): c is number => c != null && Number.isFinite(c));
  const fleetUsd = known.length > 0 ? known.reduce((s, c) => s + c, 0) : null;
  const primary =
    agentId === "all"
      ? { usd: fleetUsd, estimated: false, sourceLabel: "Telemetry · 24h" }
      : {
          usd: agents.find((a) => a.id === agentId)?.costUsd24h ?? null,
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
                {agents.map((a) => (
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
          agents={agents}
          traces={traces}
          budget={budget}
          spendUsd={primary.usd}
          spendEstimated={primary.estimated}
          spendSourceLabel={primary.sourceLabel}
          onFilterAgent={filterAgent}
          onGoDrivers={() => changeMode("drivers")}
          canEditBudget={canEditBudget}
          onEditBudget={() => {
            setBudgetSaveError(null);
            setBudgetDialogOpen(true);
          }}
          samplingStats={samplingStatsQuery.data ?? null}
          planLimits={planLimitsQuery.data ?? null}
        />
      ) : (
        <CostDriversView
          agentId={agentId}
          drivers={drivers}
          selectedId={driverId}
          onSelect={selectDriver}
        />
      )}

      {budgetDialogOpen ? (
        <EditBudgetDialog
          initial={budgetFormInitial}
          busy={budgetSaving}
          error={budgetSaveError}
          onCancel={() => setBudgetDialogOpen(false)}
          onSave={saveBudget}
        />
      ) : null}
    </div>
  );
}

export default function CostClient() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader title="Cost" meta={<InlineLoading label="Loading cost" />} />
          <LoadingFallback label="Loading cost…" rows={4} />
        </div>
      }
    >
      <LabCostInner />
    </Suspense>
  );
}
