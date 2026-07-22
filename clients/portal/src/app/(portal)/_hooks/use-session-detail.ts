"use client";

import { useMemo } from "react";
import { api, agentSessionsApi } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useOrg } from "@/hooks/use-org";
import { queryKeys } from "@/lib/query-keys";
import type { Diagnosis } from "@/lib/agent-health";
import {
  mapTraceToRow,
  type TraceListRow,
} from "@/app/(portal)/_hooks/use-traces-hub-data";

export type SessionTurnRow = {
  traceId: string;
  index: number;
  startedAt: string | null;
  outcome: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  preview: string | null;
};

export function useSessionDetail(sessionId: string | undefined) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const enabled = Boolean(sessionId);

  const sessionQuery = useOrgQuery(
    queryKeys.agents.session(orgId, sessionId),
    orgId,
    () => agentSessionsApi.get(orgId!, sessionId!),
    { enabled },
  );

  const session = sessionQuery.data?.data?.session;
  const traceIds = session?.trace_ids ?? [];
  const traceIdsKey = traceIds.join(",");

  const turnsQuery = useOrgQuery(
    queryKeys.agents.sessionTraces(orgId, sessionId, traceIdsKey),
    orgId,
    async () => {
      if (traceIds.length === 0) return [] as TraceListRow[];
      const results = await Promise.all(
        traceIds.map((id) =>
          api
            .listObservabilityTraces(orgId!, { trace_id: id, limit: 1 })
            .then((r) => r.traces[0] ?? null)
            .catch(() => null),
        ),
      );
      return results
        .filter((t): t is NonNullable<typeof t> => t != null)
        .map((t) => mapTraceToRow(t));
    },
    { enabled: enabled && traceIds.length > 0 },
  );

  const turns: SessionTurnRow[] = useMemo(() => {
    const byId = new Map((turnsQuery.data ?? []).map((t) => [t.traceId, t]));
    return traceIds.map((id, index) => {
      const row = byId.get(id);
      return {
        traceId: id,
        index: index + 1,
        startedAt: row?.startedAt ?? null,
        outcome: row?.outcome ?? null,
        latencyMs: row?.latencyMs ?? null,
        totalTokens: row?.totalTokens ?? null,
        costUsd: row?.costUsd ?? null,
        preview: row?.errorSummary ?? row?.inputPreview ?? null,
      };
    });
  }, [traceIds, turnsQuery.data]);

  const aggregates = useMemo(() => {
    let latencyMs: number | null = null;
    let totalTokens: number | null = null;
    let costUsd: number | null = null;
    let anyLat = false;
    let anyTok = false;
    let anyCost = false;
    for (const t of turns) {
      if (t.latencyMs != null) {
        latencyMs = (latencyMs ?? 0) + t.latencyMs;
        anyLat = true;
      }
      if (t.totalTokens != null) {
        totalTokens = (totalTokens ?? 0) + t.totalTokens;
        anyTok = true;
      }
      if (t.costUsd != null) {
        costUsd = (costUsd ?? 0) + t.costUsd;
        anyCost = true;
      }
    }
    return {
      latencyMs: anyLat ? latencyMs : null,
      totalTokens: anyTok ? totalTokens : null,
      costUsd: anyCost ? costUsd : null,
    };
  }, [turns]);

  const failingTurn = turns.find((t) => {
    const o = (t.outcome ?? "").toLowerCase();
    return (
      o === "error" ||
      o === "failure" ||
      o === "fail" ||
      o === "failed" ||
      o === "crash" ||
      o === "timeout"
    );
  });

  const diagnosis: Diagnosis = useMemo(() => {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    if (failingTurn?.traceId) params.set("traceId", failingTurn.traceId);
    if (session?.agent_id) params.set("agentId", session.agent_id);
    const qs = params.toString();
    return {
      openIssueCount: 0,
      errorTraceCount: failingTurn ? 1 : session?.success === false ? 1 : 0,
      worstAgentId: session?.agent_id ?? undefined,
      worstAgentName: session?.agent_id ?? undefined,
      windowHours: 24,
      primaryHref: qs ? `/issues?${qs}` : "/issues",
    };
  }, [sessionId, failingTurn, session?.agent_id, session?.success]);

  const notFound =
    enabled &&
    !sessionQuery.isLoading &&
    Boolean(sessionQuery.error) &&
    !session;

  const zeroTurns =
    enabled &&
    !sessionQuery.isLoading &&
    Boolean(session) &&
    traceIds.length === 0;

  return {
    session,
    turns,
    aggregates,
    diagnosis,
    hasError: Boolean(failingTurn) || session?.success === false,
    errorSummary:
      failingTurn?.preview ?? session?.failure_reason ?? null,
    loading: sessionQuery.isLoading,
    turnsLoading: turnsQuery.isLoading,
    error: sessionQuery.error,
    turnsError: turnsQuery.error,
    notFound,
    zeroTurns,
    refetch: () => {
      void sessionQuery.refetch();
      void turnsQuery.refetch();
    },
  };
}
