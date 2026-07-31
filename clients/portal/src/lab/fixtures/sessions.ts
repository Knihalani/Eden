import { agentById, type AgentFixture } from "@/lab/fixtures/agents";
import {
  TRACE_LIST,
  formatDuration,
  formatTokens,
  formatUsd,
  type TraceFixture,
} from "@/lab/fixtures/traces";
import { ISSUE_LIST, type IssueFixture } from "@/lab/fixtures/issues";
import {
  catalogIssues,
  catalogSessions,
  catalogTraces,
} from "@/lib/portal-catalog";

export type SessionOutcome = "ok" | "error" | "mixed";

export type SessionFixture = {
  id: string;
  agentId: string;
  userId?: string;
  startedAt: string;
  endedAt?: string;
  turnCount: number;
  outcome: SessionOutcome;
  /** Wall-clock across the thread (sum of turn durations in lab fixtures). */
  durationMs: number;
  totalTokens: number;
  /** null = session spend unknown — never invent $0. */
  costUsd: number | null;
  lastErrorSummary?: string;
  diagnosis?: string;
  relatedIssueIds: string[];
  /** Ordered turns → TRACE_LIST ids */
  traceIds: string[];
};

export type SessionTurn = {
  index: number;
  of: number;
  trace: TraceFixture;
  inputPreview?: string;
  outputPreview?: string;
};

export const SESSION_LIST: SessionFixture[] = [];

function liveSessions(): SessionFixture[] {
  const live = catalogSessions();
  return live.length > 0 ? live : SESSION_LIST;
}

function liveTraces(): TraceFixture[] {
  const live = catalogTraces();
  return live.length > 0 ? live : TRACE_LIST;
}

function liveIssues(): IssueFixture[] {
  const live = catalogIssues();
  return live.length > 0 ? live : ISSUE_LIST;
}

export function sessionById(id: string): SessionFixture | undefined {
  return liveSessions().find((s) => s.id === id);
}

export function agentForSession(session: SessionFixture): AgentFixture | undefined {
  return agentById(session.agentId);
}

export function tracesForSession(session: SessionFixture): TraceFixture[] {
  return session.traceIds
    .map((id) => {
      const live = liveTraces().find((t) => t.id === id);
      if (live) return live;
      // Catalog list window may omit older turns — keep the turn visible.
      return {
        id,
        agentId: session.agentId,
        name: id,
        status: "ok" as const,
        startedAt: "",
        durationMs: 0,
        tokens: 0,
        costUsd: null,
        severity: "none" as const,
        sessionId: session.id,
        signals: { title: "", body: "" },
        steps: [],
      };
    })
    .filter((t): t is TraceFixture => Boolean(t));
}

export function turnsForSession(session: SessionFixture): SessionTurn[] {
  const traces = tracesForSession(session);
  const of = traces.length;
  return traces.map((trace, i) => {
    const first = trace.steps[0];
    const lastLlm = [...trace.steps].reverse().find((s) => s.kind === "llm");
    const last = lastLlm ?? trace.steps[trace.steps.length - 1];
    return {
      index: i + 1,
      of,
      trace,
      inputPreview: first?.inputPreview,
      outputPreview: last?.outputPreview ?? last?.errorMessage,
    };
  });
}

export function sessionForTrace(traceId: string): SessionFixture | undefined {
  return liveSessions().find((s) => s.traceIds.includes(traceId));
}

/** Prefer API `sessionId` on the trace row, then catalog reverse-lookup. */
export function resolveSessionForTrace(
  trace: { id: string; sessionId?: string | null },
  sessions?: SessionFixture[],
): SessionFixture | undefined {
  if (trace.sessionId) {
    const fromLive = sessions?.find((s) => s.id === trace.sessionId);
    if (fromLive) return fromLive;
    const byId = sessionById(trace.sessionId);
    if (byId) return byId;
  }
  if (sessions?.length) {
    const hit = sessions.find((s) => s.traceIds.includes(trace.id));
    if (hit) return hit;
  }
  return sessionForTrace(trace.id);
}

export function sessionForTraceId(
  sessionId: string | undefined,
): SessionFixture | undefined {
  if (!sessionId) return undefined;
  return sessionById(sessionId);
}

export function issuesForSession(session: SessionFixture): IssueFixture[] {
  const fromIds = session.relatedIssueIds
    .map((id) => liveIssues().find((i) => i.id === id))
    .filter((i): i is IssueFixture => Boolean(i));
  if (fromIds.length > 0) return fromIds;
  // Fallback: issues whose occurrence traces intersect this session.
  const turnIds = new Set(session.traceIds);
  return liveIssues().filter((i) =>
    i.occurrenceTraceIds.some((tid) => turnIds.has(tid)),
  );
}

export function sessionsForAgent(agentId: string): SessionFixture[] {
  return liveSessions().filter((s) => s.agentId === agentId);
}

export { formatDuration, formatTokens, formatUsd };
