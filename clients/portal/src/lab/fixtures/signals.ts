import { ISSUE_LIST, type IssueFixture } from "@/lab/fixtures/issues";
import { TRACE_LIST, type TraceFixture } from "@/lab/fixtures/traces";
import { agentById, type AgentFixture } from "@/lab/fixtures/agents";
import {
  catalogIssues,
  catalogSignals,
  catalogTraces,
} from "@/lib/portal-catalog";

/**
 * Signals = detectors you configure.
 * Hits show on Traces → Signals tab. Recurring hits group into Issues.
 * Optional notify routing lives on the signal.
 */

export type SignalSeverity = "critical" | "error" | "warn";
export type SignalKind = "error" | "latency" | "cost" | "policy" | "custom";

export type SignalFixture = {
  id: string;
  name: string;
  description: string;
  kind: SignalKind;
  severity: SignalSeverity;
  /** Matcher / condition expression */
  condition: string;
  /** null = all agents */
  agentId: string | null;
  enabled: boolean;
  hits24h: number;
  lastHit?: string;
  relatedIssueIds: string[];
  exampleTraceIds: string[];
};

export const SIGNAL_LIST: SignalFixture[] = [];

function liveSignals(): SignalFixture[] {
  const live = catalogSignals();
  return live.length > 0 ? (live as SignalFixture[]) : SIGNAL_LIST;
}

function liveIssues(): IssueFixture[] {
  const live = catalogIssues();
  return live.length > 0 ? (live as IssueFixture[]) : ISSUE_LIST;
}

function liveTraces(): TraceFixture[] {
  const live = catalogTraces();
  return live.length > 0 ? (live as TraceFixture[]) : TRACE_LIST;
}

export function signalById(id: string): SignalFixture | undefined {
  return liveSignals().find((s) => s.id === id);
}

export function agentForSignal(signal: SignalFixture): AgentFixture | undefined {
  return signal.agentId ? agentById(signal.agentId) : undefined;
}

export function issuesForSignal(signal: SignalFixture): IssueFixture[] {
  const issues = liveIssues();
  return signal.relatedIssueIds
    .map((id) => issues.find((i) => i.id === id))
    .filter((i): i is IssueFixture => Boolean(i));
}

export function tracesForSignal(signal: SignalFixture): TraceFixture[] {
  const traces = liveTraces();
  return signal.exampleTraceIds
    .map((id) => traces.find((t) => t.id === id))
    .filter((t): t is TraceFixture => Boolean(t));
}

export function signalsForTrace(traceId: string): SignalFixture[] {
  return liveSignals().filter((s) => s.exampleTraceIds.includes(traceId));
}

export function signalsSnapshot() {
  const all = liveSignals();
  const enabled = all.filter((s) => s.enabled);
  const hits = all.reduce((sum, s) => sum + s.hits24h, 0);
  return {
    all,
    enabled,
    enabledCount: enabled.length,
    totalCount: all.length,
    hits24h: hits,
  };
}
