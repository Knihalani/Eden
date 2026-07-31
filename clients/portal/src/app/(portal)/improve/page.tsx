"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  defaultPlanId,
  planFromCompare,
  planFromIssue,
  type ImprovePlanFixture,
} from "@/lab/fixtures/improve";
import { PageHeader } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  ImproveModeNav,
  parseImproveMode,
  type ImproveMode,
} from "@/lab/improve/improve-chrome";
import dynamic from "next/dynamic";
import { catalogAgents, patchPortalCatalog } from "@/lib/portal-catalog";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { improvePlansApi } from "@/lib/api/resources";
import { isGithubPermissionsMissing } from "@/lib/improve-feature";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { useLabToast } from "@/lab/lab-toast";

const improveFallback = (
  <div className="flex min-h-[12rem] flex-1 items-center justify-center px-5">
    <p className="type-meta">Loading…</p>
  </div>
);

const ImproveQueueView = dynamic(
  () =>
    import("@/lab/improve/improve-queue-view").then((m) => ({
      default: m.ImproveQueueView,
    })),
  { loading: () => improveFallback },
);
const ImprovePlanView = dynamic(
  () =>
    import("@/lab/improve/improve-plan-view").then((m) => ({
      default: m.ImprovePlanView,
    })),
  { loading: () => improveFallback },
);

function LabImproveInner() {
  const searchParams = useSearchParams();
  const paramMode = searchParams.get("mode");
  const paramId = searchParams.get("id");
  const paramBaseline = searchParams.get("baselineId");
  const paramCompare = searchParams.get("compareId");
  const paramCase = searchParams.get("case");
  const paramIssue = searchParams.get("issue");
  const paramAgent = searchParams.get("agent");

  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
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
  const plansQuery = useOrgQuery(
    queryKeys.portal.improvePlans(orgId),
    orgId,
    () => portalApi.improvePlans(orgId!),
    SHELL_QUERY,
  );
  const livePlans = plansQuery.data ?? [];

  const { agentId, agent: scopeAgent, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();

  const [extraPlans, setExtraPlans] = useState<ImprovePlanFixture[]>([]);
  const [statusOverrides, setStatusOverrides] = useState<
    Record<string, ImprovePlanFixture["status"]>
  >({});
  const [mode, setMode] = useState<ImproveMode>(() =>
    parseImproveMode(paramMode, Boolean(paramId || paramBaseline || paramCompare || paramIssue)),
  );
  const [planId, setPlanId] = useState("");
  const handledHandoff = useRef<string | null>(null);

  const allPlans = useMemo(() => {
    const extraIds = new Set(extraPlans.map((p) => p.id));
    const merged = [
      ...extraPlans,
      ...livePlans.filter((p) => !extraIds.has(p.id)),
    ];
    return merged.map((p) =>
      statusOverrides[p.id] ? { ...p, status: statusOverrides[p.id]! } : p,
    );
  }, [extraPlans, livePlans, statusOverrides]);

  const scopedPlans = useMemo(
    () =>
      agentId === "all"
        ? allPlans
        : allPlans.filter((p) => p.agentId === agentId),
    [allPlans, agentId],
  );

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) {
      setAgentId(paramAgent);
    }
  }, [paramAgent, agentId, setAgentId]);

  useEffect(() => {
    const nextMode = parseImproveMode(
      paramMode,
      Boolean(paramId || paramBaseline || paramCompare || paramIssue),
    );
    setMode(nextMode);
  }, [paramMode, paramId, paramBaseline, paramCompare, paramIssue]);

  useEffect(() => {
    const next =
      allPlans.find((p) => p.id === paramId)?.id ??
      scopedPlans[0]?.id ??
      allPlans[0]?.id ??
      "";
    if (next && next !== planId) setPlanId(next);
    else if (!next && planId) setPlanId("");
     
  }, [paramId, allPlans, scopedPlans]);

  const selectedPlan =
    allPlans.find((p) => p.id === planId) ??
    scopedPlans[0] ??
    null;

  /** Evals / Issues deep-link → resolve or synthesize a plan. */
  useEffect(() => {
    const key = [
      paramBaseline ?? "",
      paramCompare ?? "",
      paramCase ?? "",
      paramIssue ?? "",
    ].join("|");
    if (
      (!paramBaseline && !paramCompare && !paramIssue) ||
      handledHandoff.current === key
    ) {
      return;
    }
    handledHandoff.current = key;

    const fromEval = planFromCompare(
      paramBaseline,
      paramCompare,
      paramCase,
      extraPlans,
    );
    const fromIssue = paramIssue
      ? planFromIssue(paramIssue, extraPlans)
      : null;
    const plan = fromEval ?? fromIssue;
    if (!plan) return;

    if (!livePlans.some((p) => p.id === plan.id)) {
      setExtraPlans((prev) =>
        prev.some((p) => p.id === plan.id) ? prev : [plan, ...prev],
      );
    }
    setPlanId(plan.id);
    setMode("plan");
    if (plan.agentId) setAgentId(plan.agentId);
    patchQuery({
      mode: "plan",
      id: plan.id,
      baselineId: plan.baselineId ?? paramBaseline,
      compareId: plan.compareId ?? paramCompare,
      case: paramCase,
      issue: paramIssue,
      agent: plan.agentId,
    });
  }, [
    paramBaseline,
    paramCompare,
    paramCase,
    paramIssue,
    extraPlans,
    livePlans,
    patchQuery,
    setAgentId,
  ]);

  const changeMode = useCallback(
    (next: ImproveMode) => {
      setMode(next);
      if (next === "queue") {
        patchQuery({
          mode: null,
          id: null,
          baselineId: null,
          compareId: null,
          case: null,
          issue: null,
        });
      } else {
        const id = planId || defaultPlanId();
        setPlanId(id);
        patchQuery({
          mode: "plan",
          id: id || null,
          baselineId: null,
          compareId: null,
          case: null,
          issue: null,
        });
      }
    },
    [patchQuery, planId],
  );

  const openPlan = useCallback(
    (id: string) => {
      setPlanId(id);
      setMode("plan");
      const plan = allPlans.find((p) => p.id === id);
      patchQuery({
        mode: "plan",
        id,
        baselineId: plan?.baselineId ?? null,
        compareId: plan?.compareId ?? null,
        case: plan?.caseIds[0] ?? null,
        issue: plan?.issueIds[0] ?? null,
      });
    },
    [allPlans, patchQuery],
  );

  const setStatus = useCallback(
    async (id: string, status: ImprovePlanFixture["status"]) => {
      if (!orgId) return;

      if (status === "done") {
        try {
          await improvePlansApi.approvePlan(orgId, id);
          await queryClient.invalidateQueries({
            queryKey: queryKeys.portal.improvePlans(orgId),
          });
          pushToast({ title: "Plan approved", tone: "ok" });
        } catch (err) {
          const permissionsMissing = isGithubPermissionsMissing(err);
          pushToast({
            title: permissionsMissing
              ? "GitHub App needs Contents: Read and write"
              : "Approve failed",
            body: permissionsMissing
              ? "Update Contents to Read and write on the Eden Observability App, Accept on the installation, then retry."
              : err instanceof Error
                ? err.message
                : String(err),
            tone: "fail",
          });
        }
        return;
      }

      if (status === "blocked") {
        try {
          await improvePlansApi.rejectPlan(orgId, id);
          await queryClient.invalidateQueries({
            queryKey: queryKeys.portal.improvePlans(orgId),
          });
          pushToast({ title: "Plan rejected", tone: "ok" });
        } catch (err) {
          pushToast({
            title: "Reject failed",
            body: err instanceof Error ? err.message : String(err),
            tone: "fail",
          });
        }
        return;
      }

      // Intermediate statuses have no matching mutation yet — local overlay.
      setStatusOverrides((prev) => ({ ...prev, [id]: status }));
      setExtraPlans((prev) => {
        const hit = prev.find((p) => p.id === id);
        if (hit) {
          return prev.map((p) =>
            p.id === id ? { ...p, status, updatedAt: "just now" } : p,
          );
        }
        const base = livePlans.find((p) => p.id === id);
        if (!base) return prev;
        return [{ ...base, status, updatedAt: "just now" }, ...prev];
      });
    },
    [orgId, queryClient, pushToast, livePlans],
  );

  const scopeCounts = useMemo(() => {
    const map: Record<string, number> = { all: allPlans.length };
    for (const a of catalogAgents()) {
      map[a.id] = allPlans.filter((p) => p.agentId === a.id).length;
    }
    return map;
  }, [allPlans]);

  if (plansQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Improve" />
        <QueryLoadingPanel label="Loading improve plans…" />
      </div>
    );
  }

  if (plansQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Improve" />
        <QueryErrorPanel
          error={plansQuery.error}
          onRetry={() => void plansQuery.refetch()}
        />
      </div>
    );
  }

  const needsYou = scopedPlans.filter((p) => p.status === "needs_you").length;
  const meta = (
    <span className="type-meta">
      {scopeAgent ? scopeAgent.name : "All agents"} ·{" "}
      {needsYou > 0 ? `${needsYou} need you` : `${scopedPlans.length} plans`}
    </span>
  );

  return (
    <div className="ds-page">
      <PageHeader
        title="Improve"
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
            <ImproveModeNav value={mode} onChange={changeMode} />
          </div>
        }
      />

      {mode === "queue" ? (
        <ImproveQueueView
          agentId={agentId}
          plans={allPlans}
          selectedId={planId}
          onSelect={setPlanId}
          onOpenPlan={openPlan}
        />
      ) : (
        <ImprovePlanView
          plan={selectedPlan}
          onStatus={setStatus}
          onBack={() => changeMode("queue")}
        />
      )}
    </div>
  );
}

export default function LabImprovePage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader
            title="Improve"
            meta={<span className="type-meta">Loading…</span>}
          />
        </div>
      }
    >
      <LabImproveInner />
    </Suspense>
  );
}
