import { agentById, type AgentFixture } from "@/lab/fixtures/agents";
import {
  TRACE_LIST,
  formatDuration,
  formatTokens,
  formatUsd,
  traceById,
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
  costUsd: number;
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

function metricsFromTraces(traces: TraceFixture[]) {
  return {
    turnCount: traces.length,
    durationMs: traces.reduce((s, t) => s + t.durationMs, 0),
    totalTokens: traces.reduce((s, t) => s + t.tokens, 0),
    costUsd: traces.reduce((s, t) => s + t.costUsd, 0),
  };
}

function outcomeFromTraces(traces: TraceFixture[]): SessionOutcome {
  const hasError = traces.some((t) => t.severity === "error" || t.status === "error");
  const hasWarn = traces.some((t) => t.severity === "warn");
  const allOk = traces.every(
    (t) => t.severity === "none" && t.status === "ok",
  );
  if (hasError && traces.some((t) => t.severity === "none" || t.status === "ok")) {
    return "mixed";
  }
  if (hasError) return "error";
  if (hasWarn) return "mixed";
  if (allOk) return "ok";
  return "mixed";
}

function buildSession(
  partial: Omit<
    SessionFixture,
    "turnCount" | "durationMs" | "totalTokens" | "costUsd" | "outcome"
  > & { outcome?: SessionOutcome },
): SessionFixture {
  const traces = partial.traceIds
    .map((id) => traceById(id))
    .filter((t): t is TraceFixture => Boolean(t));
  const metrics = metricsFromTraces(traces);
  return {
    ...partial,
    ...metrics,
    outcome: partial.outcome ?? outcomeFromTraces(traces),
  };
}

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
    .map((id) => liveTraces().find((t) => t.id === id))
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

export function sessionForTraceId(
  sessionId: string | undefined,
): SessionFixture | undefined {
  if (!sessionId) return undefined;
  return sessionById(sessionId);
}

export function issuesForSession(session: SessionFixture): IssueFixture[] {
  return session.relatedIssueIds
    .map((id) => liveIssues().find((i) => i.id === id))
    .filter((i): i is IssueFixture => Boolean(i));
}

export function sessionsForAgent(agentId: string): SessionFixture[] {
  return liveSessions().filter((s) => s.agentId === agentId);
}

export { formatDuration, formatTokens, formatUsd };
