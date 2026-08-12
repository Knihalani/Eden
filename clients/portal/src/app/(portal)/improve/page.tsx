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
import { patchPortalCatalog } from "@/lib/portal-catalog";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey, queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { improvePlansApi } from "@/lib/api/resources";
import { isGithubPermissionsMissing } from "@/lib/improve-feature";
import { SHELL_QUERY } from "@/lib/portal-query";
import {
  InlineLoading,
  LoadingFallback,
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { LocalDraftBanner } from "@/components/shell/local-draft-banner";
import { useLabToast } from "@/lab/lab-toast";
import { NudgesPromotionsPanel } from "@/components/improve/nudges-promotions-panel";
import { CanaryCockpit } from "@/components/improve/canary-cockpit";

const improveFallback = <LoadingFallback label="Loading improve plans…" />;

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
const PlanDetailEnrichment = dynamic(
  () =>
    import("@/components/improve/plan-detail-enrichment").then((m) => ({
      default: m.PlanDetailEnrichment,
    })),
  { loading: () => null },
);

function LabImproveInner() {
  const searchParams = useSearchParams();
  const paramMode = searchParams.get("mode");
  const paramTab = searchParams.get("tab");
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
  // M13: live cockpit dual queue (Fix now / Improve later columns).
  const queueQuery = useOrgQuery(
    queryKeys.portal.improveQueue(orgId),
    orgId,
    async () => {
      const envelope = await improvePlansApi.getQueue(orgId!);
      return envelope.data?.items ?? [];
    },
    SHELL_QUERY,
  );
  const livePlans = plansQuery.data ?? [];
  const queueItems = queueQuery.data ?? [];

  const { agentId, agent: scopeAgent, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();

  const [extraPlans, setExtraPlans] = useState<ImprovePlanFixture[]>([]);
  const [mode, setMode] = useState<ImproveMode>(() =>
    parseImproveMode(
      paramMode,
      Boolean(paramId || paramBaseline || paramCompare || paramIssue),
      paramTab,
    ),
  );
  const [planId, setPlanId] = useState("");
  const handledHandoff = useRef<string | null>(null);

  const allPlans = useMemo(() => {
    const extraIds = new Set(extraPlans.map((p) => p.id));
    return [
      ...extraPlans,
      ...livePlans.filter((p) => !extraIds.has(p.id)),
    ];
  }, [extraPlans, livePlans]);

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
      paramTab,
    );
    setMode(nextMode);
  }, [paramMode, paramTab, paramId, paramBaseline, paramCompare, paramIssue]);

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
    async (
      id: string,
      status: ImprovePlanFixture["status"],
      reason?: string,
    ) => {
      if (!orgId) return;

      if (status === "done") {
        try {
          await improvePlansApi.approvePlan(orgId, id);
          await queryClient.invalidateQueries({
            queryKey: queryKeys.portal.improvePlans(orgId),
          });
          await queryClient.invalidateQueries({
            queryKey: queryKeys.portal.improveQueue(orgId),
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
          await improvePlansApi.rejectPlan(orgId, id, reason);
          await queryClient.invalidateQueries({
            queryKey: queryKeys.portal.improvePlans(orgId),
          });
          await queryClient.invalidateQueries({
            queryKey: queryKeys.portal.improveQueue(orgId),
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

      // Portal fixture has no ``snoozed`` status (API snoozed → blocked in
      // portal mapping). Intermediate statuses (needs_you / in_progress /
      // verify) have no mutation — do not apply a local overlay.
    },
    [orgId, queryClient, pushToast],
  );

  const mergePlan = useCallback(
    async (id: string) => {
      if (!orgId) return;
      try {
        await improvePlansApi.mergePlan(orgId, id);
        await queryClient.invalidateQueries({
          queryKey: queryKeys.portal.improvePlans(orgId),
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.portal.improveQueue(orgId),
        });
        await queryClient.invalidateQueries({
          queryKey: queryKey("improvePlanDetail", orgId, id),
        });
        pushToast({ title: "PR merged", tone: "ok" });
      } catch (err) {
        pushToast({
          title: "Merge failed",
          body: err instanceof Error ? err.message : String(err),
          tone: "fail",
        });
      }
    },
    [orgId, queryClient, pushToast],
  );

  const revertPlan = useCallback(
    async (id: string) => {
      if (!orgId) return;
      try {
        const envelope = await improvePlansApi.revertPlan(orgId, id);
        const data = envelope.data;
        await queryClient.invalidateQueries({
          queryKey: queryKeys.portal.improvePlans(orgId),
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.portal.improveQueue(orgId),
        });
        await queryClient.invalidateQueries({
          queryKey: queryKey("improvePlanDetail", orgId, id),
        });
        const revertId = data?.revert_plan_id;
        if (revertId) {
          await queryClient.invalidateQueries({
            queryKey: queryKey("improvePlanDetail", orgId, revertId),
          });
          setPlanId(revertId);
          setMode("plan");
          patchQuery({ mode: "plan", id: revertId });
        }
        pushToast({
          title: data?.auto_merged ? "Revert merged" : "Revert PR opened",
          body: data?.message,
          tone: "ok",
        });
      } catch (err) {
        pushToast({
          title: "Revert failed",
          body: err instanceof Error ? err.message : String(err),
          tone: "fail",
        });
      }
    },
    [orgId, queryClient, pushToast, patchQuery],
  );

  const scopeCounts = useMemo(() => {
    const map: Record<string, number> = { all: allPlans.length };
    for (const a of agentsQuery.data ?? []) {
      map[a.id] = allPlans.filter((p) => p.agentId === a.id).length;
    }
    return map;
  }, [allPlans, agentsQuery.data]);

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Improve"
        message="Select a workspace to view improve plans."
      />
    );
  }

  if (
    plansQuery.isLoading ||
    (mode === "queue" && queueQuery.isLoading && queueQuery.data === undefined)
  ) {
    return (
      <div className="ds-page">
        <PageHeader title="Improve" />
        <QueryLoadingPanel
          label={
            mode === "queue" && !plansQuery.isLoading
              ? "Loading improve queue…"
              : "Loading improve plans…"
          }
        />
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

  if (mode === "queue" && queueQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Improve" />
        <QueryErrorPanel
          error={queueQuery.error}
          onRetry={() => void queueQuery.refetch()}
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
                {(agentsQuery.data ?? []).map((a) => (
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

      {extraPlans.length > 0 ? (
        <LocalDraftBanner>
          Deep-link draft plans are local until you Approve or Reject — those
          actions hit the API on real server plans.
        </LocalDraftBanner>
      ) : null}

      {mode === "queue" ? (
        <>
          <ImproveQueueView
            agentId={agentId}
            plans={allPlans}
            queueItems={queueItems}
            selectedId={planId}
            onSelect={setPlanId}
            onOpenPlan={openPlan}
          />
          <NudgesPromotionsPanel orgId={orgId} agentId={agentId} />
          <CanaryCockpit orgId={orgId} />
        </>
      ) : (
        <>
          <ImprovePlanView
            plan={selectedPlan}
            hasPlans={allPlans.length > 0}
            onStatus={setStatus}
            onMerge={mergePlan}
            onRevert={revertPlan}
            onBack={() => changeMode("queue")}
          />
          {selectedPlan ? (
            <PlanDetailEnrichment
              orgId={orgId}
              plan={selectedPlan}
              isDraft={!livePlans.some((p) => p.id === selectedPlan.id)}
            />
          ) : null}
        </>
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
            meta={<InlineLoading label="Loading improve plans" />}
          />
          <LoadingFallback label="Loading improve plans…" rows={4} />
        </div>
      }
    >
      <LabImproveInner />
    </Suspense>
  );
}
