"use client";

import { useMemo } from "react";
import { api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useOrg } from "@/hooks/use-org";
import { queryKeys } from "@/lib/query-keys";
import {
  buildSpanTree,
  buildTranscriptRows,
} from "@/lib/observability/build-transcript-rows";
import type { TranscriptRow } from "@/lib/observability/types";
import type { Diagnosis } from "@/lib/agent-health";

export type TraceSummaryMetrics = {
  durationMs: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  agentId: string | null;
  startedAt: string | null;
  outcome: string | null;
  spanCount: number;
  eventCount: number;
};

export type TraceScoreRow = {
  id: string;
  name: string;
  score: number;
  rationale: string | null;
  spanId: string | null;
  scoredAt: string;
};

function isErrorOutcome(outcome: string | null | undefined): boolean {
  if (!outcome) return false;
  const o = outcome.toLowerCase();
  return (
    o === "error" ||
    o === "failure" ||
    o === "fail" ||
    o === "failed" ||
    o === "crash" ||
    o === "timeout"
  );
}

function rollupTokens(rows: TranscriptRow[]): number | null {
  let total = 0;
  let any = false;
  const walk = (list: TranscriptRow[]) => {
    for (const r of list) {
      if (r.input_tokens != null) {
        total += r.input_tokens;
        any = true;
      }
      if (r.output_tokens != null) {
        total += r.output_tokens;
        any = true;
      }
      if (r.children?.length) walk(r.children);
    }
  };
  walk(rows);
  return any ? total : null;
}

function rollupCost(rows: TranscriptRow[]): number | null {
  let total = 0;
  let any = false;
  const walk = (list: TranscriptRow[]) => {
    for (const r of list) {
      if (r.cost_usd != null) {
        total += r.cost_usd;
        any = true;
      }
      if (r.children?.length) walk(r.children);
    }
  };
  walk(rows);
  return any ? total : null;
}

export function useTraceDetail(
  traceId: string | undefined,
  opts?: { pastHours?: number; agentId?: string | null },
) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const enabled = Boolean(traceId);

  const treeQuery = useOrgQuery(
    queryKeys.observability.tree(orgId, traceId),
    orgId,
    () => api.getTraceTree(orgId!, traceId!),
    { enabled },
  );

  const timelineQuery = useOrgQuery(
    queryKeys.observability.timeline(orgId, traceId),
    orgId,
    () => api.getTraceTimeline(orgId!, traceId!),
    { enabled },
  );

  const summaryQuery = useOrgQuery(
    queryKeys.observability.trace(orgId, traceId),
    orgId,
    () => api.getTraceSummary(orgId!, traceId!),
    { enabled },
  );

  const scoresQuery = useOrgQuery(
    ["observability", "scores", orgId, traceId] as const,
    orgId,
    () => api.listJudgeScores(orgId!, { trace_id: traceId!, limit: 50 }),
    { enabled },
  );

  const listRowQuery = useOrgQuery(
    queryKeys.observability.traces(orgId, { trace_id: traceId }),
    orgId,
    () =>
      api.listObservabilityTraces(orgId!, {
        trace_id: traceId!,
        limit: 1,
      }),
    { enabled },
  );

  const transcriptRows = useMemo(() => {
    const roots = treeQuery.data?.root_spans ?? [];
    return buildTranscriptRows(roots, { lazyToolPayloads: true });
  }, [treeQuery.data?.root_spans]);

  const treeRows = useMemo(() => {
    const roots = treeQuery.data?.root_spans ?? [];
    return buildSpanTree(roots, { lazyToolPayloads: true });
  }, [treeQuery.data?.root_spans]);

  const listRow = listRowQuery.data?.traces?.[0];

  const metrics: TraceSummaryMetrics = useMemo(() => {
    const durationMs =
      treeQuery.data?.total_duration_ms ??
      timelineQuery.data?.total_duration_ms ??
      summaryQuery.data?.duration_ms ??
      listRow?.duration_ms ??
      null;
    const tokensFromTree = rollupTokens(treeRows);
    const costFromTree = rollupCost(treeRows);
    const listTokens =
      listRow?.input_tokens != null || listRow?.output_tokens != null
        ? (listRow.input_tokens ?? 0) + (listRow.output_tokens ?? 0)
        : null;
    const listCost =
      listRow?.cost_cents != null ? Number(listRow.cost_cents) / 100 : null;

    return {
      durationMs,
      totalTokens: tokensFromTree ?? listTokens,
      costUsd: costFromTree ?? listCost,
      agentId: listRow?.agent_id ?? opts?.agentId ?? null,
      startedAt:
        summaryQuery.data?.started_at ?? listRow?.started_at ?? null,
      outcome: treeQuery.data?.outcome ?? listRow?.outcome ?? null,
      spanCount: treeQuery.data?.span_count ?? listRow?.span_count ?? 0,
      eventCount: summaryQuery.data?.event_count ?? 0,
    };
  }, [
    treeQuery.data,
    timelineQuery.data,
    summaryQuery.data,
    listRow,
    treeRows,
    opts?.agentId,
  ]);

  const scores: TraceScoreRow[] = useMemo(() => {
    return (scoresQuery.data?.scores ?? []).map((s) => ({
      id: s.judge_run_id,
      name: s.judge_name,
      score: s.score,
      rationale: s.rationale ?? null,
      spanId: s.span_id ?? null,
      scoredAt: s.scored_at,
    }));
  }, [scoresQuery.data?.scores]);

  const errorSpan = transcriptRows.find((r) => isErrorOutcome(r.outcome));
  const hasError = isErrorOutcome(metrics.outcome) || Boolean(errorSpan);

  const diagnosis: Diagnosis = useMemo(() => {
    const issueParams = new URLSearchParams();
    if (traceId) issueParams.set("traceId", traceId);
    if (errorSpan?.span_id) issueParams.set("spanId", errorSpan.span_id);
    if (metrics.agentId) issueParams.set("agentId", metrics.agentId);
    const qs = issueParams.toString();
    return {
      openIssueCount: 0,
      errorTraceCount: hasError ? 1 : 0,
      worstAgentId: metrics.agentId ?? undefined,
      worstAgentName: metrics.agentId ?? undefined,
      windowHours: opts?.pastHours ?? 24,
      primaryHref: qs ? `/issues?${qs}` : "/issues",
    };
  }, [traceId, errorSpan?.span_id, metrics.agentId, hasError, opts?.pastHours]);

  const notFound =
    enabled &&
    !treeQuery.isLoading &&
    !listRowQuery.isLoading &&
    Boolean(treeQuery.error || listRowQuery.error) &&
    !treeQuery.data &&
    !(listRowQuery.data?.traces?.length);

  return {
    transcriptRows,
    treeRows,
    timeline: timelineQuery.data,
    summary: summaryQuery.data,
    metrics,
    scores,
    diagnosis,
    hasError,
    errorSpanId: errorSpan?.span_id ?? null,
    errorSummary: errorSpan?.name ?? listRow?.error ?? null,
    loading:
      treeQuery.isLoading ||
      timelineQuery.isLoading ||
      summaryQuery.isLoading ||
      listRowQuery.isLoading,
    error: treeQuery.error ?? timelineQuery.error ?? summaryQuery.error,
    scoresLoading: scoresQuery.isLoading,
    scoresError: scoresQuery.error,
    notFound,
    refetch: () => {
      void treeQuery.refetch();
      void timelineQuery.refetch();
      void summaryQuery.refetch();
      void scoresQuery.refetch();
      void listRowQuery.refetch();
    },
  };
}
