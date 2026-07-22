"use client";

import { useMemo } from "react";
import { api, agentSessionsApi, type ObservabilityTrace } from "@/lib/api";
import type { AgentSessionRecord } from "@/lib/api/resources";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useOrg } from "@/hooks/use-org";
import { useObservabilityStream } from "@/hooks/use-observability-stream";
import { queryKeys } from "@/lib/query-keys";
import type { ObserveUrlState } from "@/lib/observe-url";

const DEFAULT_PAST_HOURS = 24;
const LIST_LIMIT = 100;
const SOFT_POLL_MS = 45_000;
const LIVE_POLL_MS = 10_000;

export type TraceListRow = {
  traceId: string;
  agentId: string | null;
  sessionId: string | null;
  startedAt: string | null;
  outcome: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  inputPreview: string | null;
  errorSummary: string | null;
  spanCount: number;
  realm: string | null;
  tags: string[];
  isLive?: boolean;
};

export type SpanListRow = {
  spanId: string;
  traceId: string;
  name: string;
  outcome: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  preview: string | null;
  agentId: string | null;
};

export type SessionListRow = {
  sessionId: string;
  agentId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  turnCount: number;
  outcome: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  lastErrorSummary: string | null;
  traceIds: string[];
};

function parsePastHours(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(168, Math.max(1, Math.round(n)));
}

function costUsdFromTrace(t: ObservabilityTrace): number | null {
  if (t.cost_cents == null) return null;
  const n = Number(t.cost_cents);
  return Number.isFinite(n) ? n / 100 : null;
}

function totalTokensFromTrace(t: ObservabilityTrace): number | null {
  const input = t.input_tokens ?? null;
  const output = t.output_tokens ?? null;
  if (input == null && output == null) return null;
  return (input ?? 0) + (output ?? 0);
}

export function mapTraceToRow(
  t: ObservabilityTrace,
  opts?: { isLive?: boolean },
): TraceListRow {
  return {
    traceId: t.trace_id,
    agentId: t.agent_id ?? null,
    sessionId: t.session_id ?? t.agent_session_id ?? null,
    startedAt: t.started_at ?? null,
    outcome: t.outcome ?? null,
    latencyMs: t.duration_ms ?? null,
    totalTokens: totalTokensFromTrace(t),
    costUsd: costUsdFromTrace(t),
    inputPreview: t.model ?? null,
    errorSummary: t.error ?? null,
    spanCount: t.span_count ?? 0,
    realm: t.realm ?? null,
    tags: t.tags ?? [],
    isLive: opts?.isLive,
  };
}

function mapSessionToRow(s: AgentSessionRecord): SessionListRow {
  const outcome =
    s.success === false
      ? "error"
      : s.success === true
        ? "ok"
        : "unknown";
  return {
    sessionId: s.id,
    agentId: s.agent_id ?? null,
    startedAt: s.started_at ?? null,
    endedAt: s.ended_at ?? null,
    turnCount: s.trace_ids?.length ?? 0,
    outcome,
    latencyMs: null,
    totalTokens: null,
    costUsd: null,
    lastErrorSummary: s.failure_reason ?? null,
    traceIds: s.trace_ids ?? [],
  };
}

function matchesOutcome(
  outcome: string | null | undefined,
  filter: string | undefined,
): boolean {
  if (!filter) return true;
  const o = (outcome ?? "unknown").toLowerCase();
  if (filter === "error") {
    return (
      o === "error" ||
      o === "failure" ||
      o === "fail" ||
      o === "failed" ||
      o === "crash" ||
      o === "timeout"
    );
  }
  if (filter === "ok") {
    return o === "ok" || o === "success" || o === "succeeded";
  }
  if (filter === "unknown") {
    return o === "unknown" || o === "" || outcome == null;
  }
  return true;
}

function matchesFacet(tags: string[], facet: string | undefined): boolean {
  if (!facet) return true;
  const needle = `facet:${facet}`;
  return tags.some(
    (t) =>
      t === facet ||
      t === needle ||
      t.toLowerCase().includes(facet.toLowerCase()),
  );
}

function matchesQuery(row: TraceListRow, q: string | undefined): boolean {
  if (!q?.trim()) return true;
  const needle = q.trim().toLowerCase();
  return (
    row.traceId.toLowerCase().includes(needle) ||
    (row.agentId?.toLowerCase().includes(needle) ?? false) ||
    (row.errorSummary?.toLowerCase().includes(needle) ?? false) ||
    (row.inputPreview?.toLowerCase().includes(needle) ?? false) ||
    (row.sessionId?.toLowerCase().includes(needle) ?? false)
  );
}

export function useTracesHubData(state: ObserveUrlState) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const pastHours = parsePastHours(state.pastHours, DEFAULT_PAST_HOURS);
  const traceDays = Math.max(1, Math.ceil(pastHours / 24));
  const live = state.live === "1";
  const pollMs = live ? LIVE_POLL_MS : SOFT_POLL_MS;

  const listFilters = {
    days: traceDays,
    limit: LIST_LIMIT,
    agent_id: state.agentId,
    outcome: state.outcome,
    realm: state.realm,
  };

  const tracesQuery = useOrgQuery(
    queryKeys.observability.traces(orgId, listFilters),
    orgId,
    () =>
      api.listObservabilityTraces(orgId!, {
        days: traceDays,
        limit: LIST_LIMIT,
        agent_id: state.agentId,
        outcome:
          state.outcome === "error"
            ? "error"
            : state.outcome === "ok"
              ? "success"
              : state.outcome,
        realm: state.realm,
      }),
    { refetchInterval: pollMs },
  );

  const sessionsQuery = useOrgQuery(
    queryKeys.agents.sessions(orgId, {
      agent_id: state.agentId,
      limit: LIST_LIMIT,
    }),
    orgId,
    () =>
      agentSessionsApi.list(orgId!, {
        agent_id: state.agentId,
        limit: LIST_LIMIT,
      }),
    {
      enabled: state.view === "sessions",
      refetchInterval: state.view === "sessions" ? pollMs : false,
    },
  );

  const spansQuery = useOrgQuery(
    queryKeys.observability.spans(orgId, {
      q: state.q ?? "",
      agent: state.agentId,
      outcome: state.outcome,
      days: traceDays,
    }),
    orgId,
    () =>
      api.searchSpans(orgId!, {
        q: state.q,
        agent: state.agentId,
        outcome:
          state.outcome === "ok"
            ? "success"
            : state.outcome === "error"
              ? "error"
              : state.outcome,
        per_page: LIST_LIMIT,
        page: 1,
      }),
    {
      enabled: state.view === "spans",
      refetchInterval: state.view === "spans" ? pollMs : false,
    },
  );

  const stream = useObservabilityStream({
    orgId: orgId ?? "",
    maxEvents: 40,
    enabled: Boolean(orgId) && live,
  });

  const traces = useMemo(() => {
    const base = (tracesQuery.data?.traces ?? []).map((t) => mapTraceToRow(t));
    const byId = new Map(base.map((r) => [r.traceId, r]));
    if (live) {
      for (const ev of stream.events) {
        const existing = byId.get(ev.trace_id);
        const mapped = mapTraceToRow(
          {
            trace_id: ev.trace_id,
            tenant_id: "",
            realm: ev.realm,
            outcome: ev.outcome,
            span_count: ev.span_count,
            duration_ms: ev.duration_ms,
            agent_id: ev.agent_id,
            started_at: ev.started_at,
            streaming_metrics: ev.streaming_metrics,
          },
          { isLive: true },
        );
        byId.set(ev.trace_id, existing ? { ...existing, ...mapped, isLive: true } : mapped);
      }
    }
    let rows = Array.from(byId.values());
    rows = rows.filter(
      (r) =>
        matchesOutcome(r.outcome, state.outcome) &&
        matchesFacet(r.tags, state.facet) &&
        matchesQuery(r, state.q),
    );
    rows.sort((a, b) => {
      const ta = a.startedAt ? Date.parse(a.startedAt) : 0;
      const tb = b.startedAt ? Date.parse(b.startedAt) : 0;
      return tb - ta;
    });
    return rows;
  }, [
    tracesQuery.data?.traces,
    live,
    stream.events,
    state.outcome,
    state.facet,
    state.q,
  ]);

  const spans = useMemo((): SpanListRow[] => {
    const hits = spansQuery.data?.hits ?? [];
    return hits.map((h) => {
      const latency =
        typeof h.duration_ms === "number"
          ? h.duration_ms
          : typeof h.latency_ms === "number"
            ? h.latency_ms
            : null;
      const tokens =
        typeof h.total_tokens === "number"
          ? h.total_tokens
          : typeof h.input_tokens === "number" || typeof h.output_tokens === "number"
            ? Number(h.input_tokens ?? 0) + Number(h.output_tokens ?? 0)
            : null;
      const cost =
        typeof h.cost_usd === "number"
          ? h.cost_usd
          : typeof h.cost_cents === "number"
            ? Number(h.cost_cents) / 100
            : null;
      return {
        spanId: String(h.span_id ?? h.trace_id),
        traceId: String(h.trace_id),
        name: String(h.name ?? h.snippet ?? h.preview ?? h.span_id ?? "span"),
        outcome: (h.outcome as string | null | undefined) ?? null,
        latencyMs: latency,
        totalTokens: tokens,
        costUsd: cost,
        preview: (h.preview as string | undefined) ?? (h.snippet as string | undefined) ?? null,
        agentId: (h.agent_id as string | null | undefined) ?? state.agentId ?? null,
      };
    });
  }, [spansQuery.data?.hits, state.agentId]);

  const sessions = useMemo(() => {
    const list = sessionsQuery.data?.data?.sessions ?? [];
    let rows = list.map(mapSessionToRow);
    if (state.q?.trim()) {
      const needle = state.q.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.sessionId.toLowerCase().includes(needle) ||
          (r.agentId?.toLowerCase().includes(needle) ?? false) ||
          (r.lastErrorSummary?.toLowerCase().includes(needle) ?? false),
      );
    }
    if (state.outcome) {
      rows = rows.filter((r) => matchesOutcome(r.outcome, state.outcome));
    }
    rows.sort((a, b) => {
      const ta = a.startedAt ? Date.parse(a.startedAt) : 0;
      const tb = b.startedAt ? Date.parse(b.startedAt) : 0;
      return tb - ta;
    });
    return rows;
  }, [sessionsQuery.data?.data?.sessions, state.q, state.outcome]);

  const tracesTotal = tracesQuery.data?.total ?? traces.length;
  const filtersActive = Boolean(
    state.q?.trim() ||
      state.outcome ||
      state.agentId ||
      state.realm ||
      state.facet ||
      state.filter ||
      (state.pastHours && state.pastHours !== String(DEFAULT_PAST_HOURS)),
  );

  const isFirstRun =
    !tracesQuery.isLoading &&
    !tracesQuery.error &&
    (tracesQuery.data?.total ?? 0) === 0 &&
    !filtersActive;

  return {
    pastHours,
    traces,
    spans,
    sessions,
    tracesTotal,
    filtersActive,
    isFirstRun,
    tracesLoading: tracesQuery.isLoading,
    tracesError: tracesQuery.error,
    spansLoading: spansQuery.isLoading,
    spansError: spansQuery.error,
    sessionsLoading: sessionsQuery.isLoading,
    sessionsError: sessionsQuery.error,
    liveConnected: stream.connected,
    liveFailed: stream.failed,
    refetchAll: () => {
      void tracesQuery.refetch();
      void spansQuery.refetch();
      void sessionsQuery.refetch();
    },
  };
}
