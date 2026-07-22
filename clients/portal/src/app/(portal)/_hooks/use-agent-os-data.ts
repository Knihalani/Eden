"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { api, agentsApi, agentIssuesApi, fleetApi } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useOrg } from "@/hooks/use-org";
import { queryKeys } from "@/lib/query-keys";
import { FIRST_EVENT_WAIT } from "@/lib/portal-polish";
import {
  buildDiagnosis,
  buildNextAction,
  deriveAgentStatus,
  mapFailureRows,
  pickWorstAgent,
  type AgentOsRow,
  type Diagnosis,
  type FailureRow,
  type NextAction,
} from "@/lib/agent-health";

const DEFAULT_PAST_HOURS = 24;
const SOFT_POLL_MS = 45_000;
const LIVE_POLL_MS = 10_000;

export type UseAgentOsDataOptions = {
  /** Include fleet summary (agents list fleet tab). */
  includeFleet?: boolean;
  /** Opt-in live pulse — faster refetch. */
  live?: boolean;
  /** Force agent filter (overrides URL). */
  agentId?: string | null;
  /** Force window hours (overrides URL). */
  pastHours?: number;
};

export type AgentOsData = {
  pastHours: number;
  agentIdFilter: string | null;
  agents: AgentOsRow[];
  rawAgents: Awaited<ReturnType<typeof agentsApi.list>>["agents"];
  diagnosis: Diagnosis;
  nextAction: NextAction;
  failures: FailureRow[];
  fleetAgents: Awaited<
    ReturnType<typeof fleetApi.summary>
  >["data"]["agents"];
  isFirstRun: boolean;
  agentsLoading: boolean;
  agentsError: Error | null;
  diagnosisError: Error | null;
  diagnosisLoading: boolean;
  fleetLoading: boolean;
  fleetError: Error | null;
  refetchAll: () => void;
  tracesTotal: number;
  openIssues: Awaited<
    ReturnType<typeof agentIssuesApi.list>
  >["data"]["issues"];
};

function parsePastHours(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(168, Math.max(1, Math.round(n)));
}

export function useAgentOsData(
  options: UseAgentOsDataOptions = {},
): AgentOsData {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const searchParams = useSearchParams();

  const pastHours =
    options.pastHours ??
    parsePastHours(searchParams.get("pastHours"), DEFAULT_PAST_HOURS);
  const agentIdFilter =
    options.agentId !== undefined
      ? options.agentId
      : searchParams.get("agentId");
  const live = options.live ?? false;
  const includeFleet = options.includeFleet ?? false;

  const traceDays = Math.max(1, Math.ceil(pastHours / 24));

  const agentsQuery = useOrgQuery(
    queryKeys.agents.list(orgId, { limit: 100 }),
    orgId,
    () => agentsApi.list(orgId!, { limit: 100 }),
  );

  const summaryQuery = useOrgQuery(
    queryKeys.observability.summary(orgId, {
      window_hours: pastHours,
      agent_id: agentIdFilter ?? undefined,
    }),
    orgId,
    () =>
      api.getObservabilitySummary(orgId!, {
        window_hours: pastHours,
        agent_id: agentIdFilter ?? undefined,
      }),
  );

  const tracesQuery = useOrgQuery(
    queryKeys.observability.traces(orgId, {
      days: traceDays,
      limit: 50,
      agent_id: agentIdFilter ?? undefined,
    }),
    orgId,
    () =>
      api.listObservabilityTraces(orgId!, {
        days: traceDays,
        limit: 50,
        agent_id: agentIdFilter ?? undefined,
      }),
    {
      refetchInterval: (q) => {
        if (q.state.error) return false;
        const total = q.state.data?.total ?? q.state.data?.traces?.length ?? 0;
        if (total === 0) return FIRST_EVENT_WAIT.pollMs;
        if (live) return LIVE_POLL_MS;
        return SOFT_POLL_MS;
      },
    },
  );

  const errorTracesQuery = useOrgQuery(
    queryKeys.observability.traces(orgId, {
      days: traceDays,
      limit: 20,
      outcome: "error",
      agent_id: agentIdFilter ?? undefined,
    }),
    orgId,
    () =>
      api.listObservabilityTraces(orgId!, {
        days: traceDays,
        limit: 20,
        outcome: "error",
        agent_id: agentIdFilter ?? undefined,
      }),
  );

  const issuesQuery = useOrgQuery(
    queryKeys.issues.list(orgId, { status: "open", limit: 50 }),
    orgId,
    () => agentIssuesApi.list(orgId!, { status: "open", limit: 50 }),
  );

  const fleetQuery = useOrgQuery(
    queryKeys.fleet.summary(orgId),
    orgId,
    () => fleetApi.summary(orgId!),
    { enabled: includeFleet },
  );

  const rawAgents = agentsQuery.data?.agents ?? [];
  const traces = tracesQuery.data?.traces ?? [];
  const errorTraces = errorTracesQuery.data?.traces ?? [];
  const openIssues = issuesQuery.data?.data?.issues ?? [];
  const openIssueCount =
    issuesQuery.data?.data?.count ?? openIssues.length;
  const tracesTotal =
    tracesQuery.data?.total ?? traces.length;
  const summaryErrorRate = summaryQuery.data?.error_rate ?? null;
  const summaryCostUsd = summaryQuery.data?.total_cost_usd ?? null;

  const issuesByAgent = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of openIssues) {
      if (!issue.agent_id) continue;
      map.set(issue.agent_id, (map.get(issue.agent_id) ?? 0) + 1);
    }
    return map;
  }, [openIssues]);

  const trafficByAgent = useMemo(() => {
    const set = new Set<string>();
    for (const t of traces) {
      if (t.agent_id) set.add(t.agent_id);
    }
    return set;
  }, [traces]);

  const agents: AgentOsRow[] = useMemo(() => {
    const rows = rawAgents.map((a) => {
      const openCount = issuesByAgent.get(a.agent_id) ?? 0;
      const hasTraffic = trafficByAgent.has(a.agent_id);
      const status = deriveAgentStatus({
        lastSeenAt: a.last_seen_at,
        errorRate: hasTraffic ? summaryErrorRate : null,
        openIssueCount: openCount,
        hasTrafficInWindow: hasTraffic,
      });
      return {
        agentId: a.agent_id,
        displayName: a.name || a.agent_id,
        status,
        errorRate: hasTraffic ? summaryErrorRate : null,
        costUsd: hasTraffic ? summaryCostUsd : null,
        lastSeenAt: a.last_seen_at ?? null,
        openIssueCount: openCount,
      };
    });

    if (agentIdFilter) {
      return rows.filter((r) => r.agentId === agentIdFilter);
    }
    return rows;
  }, [
    rawAgents,
    issuesByAgent,
    trafficByAgent,
    summaryErrorRate,
    summaryCostUsd,
    agentIdFilter,
  ]);

  const worst = pickWorstAgent(agents);
  const errorTraceCount =
    errorTracesQuery.data?.total ?? errorTraces.length;

  const diagnosis = buildDiagnosis({
    openIssueCount,
    errorTraceCount,
    windowHours: pastHours,
    worstAgentId: worst?.agentId,
    worstAgentName: worst?.displayName,
    agentCount: rawAgents.length,
    traceCountEver: tracesTotal,
  });

  const nextAction = buildNextAction({
    agentCount: rawAgents.length,
    traceCountEver: tracesTotal,
    openIssueCount,
    errorTraceCount,
    worstAgentId: worst?.agentId,
    worstStatus: worst?.status,
  });

  const failures = mapFailureRows(
    errorTraces.length > 0 ? errorTraces : traces,
    5,
  );

  const isFirstRun = rawAgents.length === 0 || tracesTotal === 0;

  const diagnosisError =
    summaryQuery.error ?? errorTracesQuery.error ?? issuesQuery.error ?? null;

  const refetchAll = () => {
    void agentsQuery.refetch();
    void summaryQuery.refetch();
    void tracesQuery.refetch();
    void errorTracesQuery.refetch();
    void issuesQuery.refetch();
    if (includeFleet) void fleetQuery.refetch();
  };

  return {
    pastHours,
    agentIdFilter,
    agents,
    rawAgents,
    diagnosis,
    nextAction,
    failures,
    fleetAgents: fleetQuery.data?.data?.agents ?? [],
    isFirstRun,
    agentsLoading: agentsQuery.isLoading,
    agentsError: agentsQuery.error ?? null,
    diagnosisError,
    diagnosisLoading:
      summaryQuery.isLoading ||
      errorTracesQuery.isLoading ||
      issuesQuery.isLoading,
    fleetLoading: fleetQuery.isLoading,
    fleetError: fleetQuery.error ?? null,
    refetchAll,
    tracesTotal,
    openIssues,
  };
}
