"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useApiQuery } from "@/hooks/use-api-query";
import { useLiveTraceStream } from "@/hooks/use-live-trace-stream";
import { api } from "@/lib/api";
import {
  buildSpanTree,
  buildTranscriptRows,
} from "@/lib/observability/build-transcript-rows";
import { resolveTimelineSteps } from "@/lib/observability/timeline-sync";
import type { TranscriptRow } from "@/lib/observability/types";
import {
  useTraceTimeline,
  useTraceTree,
} from "@/app/(portal)/observability/_lib/use-observability-data";
import { markEden } from "@/lib/perf";
import type { DetailMode } from "./types";

const DETAIL_STALE_TIME = 60_000;

export type TraceViewerMeta = {
  duration_ms: number;
  span_count: number;
  outcome: string | null;
  model?: string;
  cost_cents?: number | null;
  session_id?: string | null;
  agent_id?: string | null;
  user_id?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  tags?: string[] | null;
};

export function useTraceViewerData(opts: {
  traceId: string;
  mode: DetailMode;
  ganttStripOpen?: boolean;
}) {
  const { traceId, mode, ganttStripOpen = false } = opts;
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const searchParams = useSearchParams();
  const liveOptIn = searchParams.get("live") === "1";

  useEffect(() => {
    markEden("eden:panel_open", "trace");
  }, [traceId]);

  const listQuery = useApiQuery(
    ["observability", "trace-meta", orgId, traceId],
    () => {
      if (!orgId || !traceId) throw new Error("orgId + traceId required");
      return api.listObservabilityTraces(orgId, { trace_id: traceId, limit: 1 });
    },
    { enabled: Boolean(orgId && traceId), staleTime: DETAIL_STALE_TIME },
  );

  const treeQuery = useTraceTree(orgId, traceId);

  const needTimeline = mode === "timeline" || (mode === "transcript" && ganttStripOpen);
  const timelineQuery = useTraceTimeline(needTimeline ? orgId : undefined, needTimeline ? traceId : null);

  const [liveRows, setLiveRows] = useState<TranscriptRow[]>([]);

  const roots = useMemo(() => {
    const raw = treeQuery.data?.root_spans;
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  }, [treeQuery.data?.root_spans]);

  const rows = useMemo(() => {
    const built = buildTranscriptRows(roots, { lazyToolPayloads: true });
    if (liveRows.length === 0) return built;
    const known = new Set(built.map((r) => r.span_id));
    return [...built, ...liveRows.filter((r) => !known.has(r.span_id))];
  }, [roots, liveRows]);

  const treeRows = useMemo(() => buildSpanTree(roots), [roots]);

  const trace = listQuery.data?.traces?.[0] as
    | {
        duration_ms?: number;
        span_count?: number;
        outcome?: string | null;
        model?: string;
        cost_cents?: number | null;
        agent_session_id?: string;
        session_id?: string;
        agent_id?: string | null;
        user_id?: string | null;
        input_tokens?: number | null;
        output_tokens?: number | null;
        tags?: string[] | null;
      }
    | undefined;

  const tree = treeQuery.data;
  const notFound =
    !listQuery.isLoading &&
    !treeQuery.isLoading &&
    !listQuery.isError &&
    !treeQuery.isError &&
    !trace &&
    roots.length === 0;

  const meta: TraceViewerMeta | null = useMemo(() => {
    if (notFound) return null;
    if (!trace && roots.length === 0 && !tree) return null;
    return {
      duration_ms: tree?.total_duration_ms ?? trace?.duration_ms ?? 0,
      span_count: tree?.span_count ?? trace?.span_count ?? 0,
      outcome: tree?.outcome ?? trace?.outcome ?? null,
      model: trace?.model ?? undefined,
      cost_cents: trace?.cost_cents ?? null,
      session_id: trace?.agent_session_id ?? trace?.session_id ?? null,
      agent_id: trace?.agent_id ?? null,
      user_id: trace?.user_id ?? null,
      input_tokens: trace?.input_tokens ?? null,
      output_tokens: trace?.output_tokens ?? null,
      tags: trace?.tags ?? null,
    };
  }, [notFound, trace, tree, roots.length]);

  const sessionId = meta?.session_id ?? null;
  const outcomeRaw = meta?.outcome?.trim().toLowerCase() ?? "";
  const outcomeInFlight =
    meta != null &&
    (outcomeRaw === "" ||
      outcomeRaw === "running" ||
      outcomeRaw === "pending" ||
      outcomeRaw === "in_flight" ||
      outcomeRaw === "in-flight");

  const liveStream = useLiveTraceStream({
    orgId,
    sessionId,
    enabled: Boolean(orgId && sessionId && meta && (liveOptIn || outcomeInFlight)),
  });

  useEffect(() => {
    setLiveRows([]);
  }, [traceId]);

  useEffect(() => {
    if (!liveStream.live || liveStream.events.length === 0) return;
    const last = liveStream.events[liveStream.events.length - 1];
    if (!last || (last.type !== "span_end" && last.type !== "span_start")) return;
    const spanId = typeof last.span_id === "string" ? last.span_id : null;
    if (!spanId) return;
    setLiveRows((prev) => {
      if (prev.some((r) => r.span_id === spanId)) return prev;
      return [
        ...prev,
        {
          span_id: spanId,
          name: String(last.name ?? "live.span"),
          timestamp:
            typeof last.timestamp === "string"
              ? last.timestamp
              : new Date().toISOString(),
          duration_ms: Number(
            (last.attributes as { duration_ms?: number } | undefined)?.duration_ms ?? 0,
          ),
          event_type: "tool",
          outcome: last.status === "error" ? "error" : null,
        } as TranscriptRow,
      ];
    });
  }, [liveStream.events, liveStream.live]);

  const timelineSteps = useMemo(
    () => resolveTimelineSteps(timelineQuery.data?.steps, rows),
    [timelineQuery.data?.steps, rows],
  );
  const timelineTotalMs =
    timelineQuery.data?.total_duration_ms ??
    meta?.duration_ms ??
    Math.max(1, ...timelineSteps.map((s) => s.end_ms), 1);

  const totalTokens =
    meta?.input_tokens != null && meta?.output_tokens != null
      ? {
          input: meta.input_tokens,
          output: meta.output_tokens,
          total: meta.input_tokens + meta.output_tokens,
        }
      : undefined;

  const phase: "loading" | "ready" | "error" | "not_found" = (() => {
    if (listQuery.isLoading || treeQuery.isLoading) return "loading";
    if (listQuery.isError || treeQuery.isError) return "error";
    if (notFound) return "not_found";
    if (meta) return "ready";
    return "loading";
  })();

  const error =
    listQuery.error?.message ??
    treeQuery.error?.message ??
    (notFound ? "Trace not found" : null);

  return {
    orgId,
    currentOrg,
    phase,
    error,
    meta,
    rows,
    treeRows,
    totalTokens,
    sessionId,
    liveStream,
    timelineQuery,
    timelineSteps,
    timelineTotalMs,
  };
}
