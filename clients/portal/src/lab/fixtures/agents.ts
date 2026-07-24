import {
  TRACE_LIST,
  type TraceFixture,
  formatDuration,
  formatTokens,
  formatUsd,
} from "@/lab/fixtures/traces";
import {
  catalogAgents,
  catalogTraces,
} from "@/lib/portal-catalog";

export type AgentFixture = {
  id: string;
  name: string;
  purpose: string;
  status: "live" | "idle" | "error";
  env: string;
  model: string;
  runs24h: number;
  successRate: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  costUsd24h: number;
  tokens24h: number;
  openIssues: number;
  lastSeen: string;
  topError?: string;
};

/** Empty seed — live rows come from portal catalog / React Query. */
export const AGENT_LIST: AgentFixture[] = [];

function liveAgents(): AgentFixture[] {
  const live = catalogAgents();
  return live.length > 0 ? live : AGENT_LIST;
}

function liveTraces(): TraceFixture[] {
  const live = catalogTraces();
  return live.length > 0 ? live : TRACE_LIST;
}

export function agentById(id: string): AgentFixture | undefined {
  return liveAgents().find((a) => a.id === id);
}

export function agentForTrace(trace: TraceFixture): AgentFixture | undefined {
  return agentById(trace.agentId);
}

export function tracesForAgent(agentId: string): TraceFixture[] {
  return liveTraces().filter((t) => t.agentId === agentId);
}

export function attentionItems(traces: TraceFixture[] = liveTraces()): TraceFixture[] {
  return traces
    .filter((t) => t.severity === "error" || t.severity === "warn")
    .sort((a, b) => {
      const rank = { error: 0, warn: 1, none: 2 } as const;
      return rank[a.severity] - rank[b.severity];
    });
}

export function homeSnapshot(
  agents: AgentFixture[] = liveAgents(),
  traces: TraceFixture[] = liveTraces(),
) {
  const failures = traces.filter((t) => t.status === "error");
  const warnings = traces.filter((t) => t.severity === "warn");
  const ok = traces.filter((t) => t.status === "ok" && t.severity === "none");
  const cost = traces.reduce((sum, t) => sum + t.costUsd, 0);
  const tokens = traces.reduce((sum, t) => sum + t.tokens, 0);
  const fleetCost = agents.reduce((sum, a) => sum + a.costUsd24h, 0);
  // Prefer registry fleet counts; fall back to live traces so SDK-only
  // orgs still show non-zero Runs before agents are registered.
  const fleetRunsFromAgents = agents.reduce((sum, a) => sum + a.runs24h, 0);
  const fleetRuns =
    fleetRunsFromAgents > 0 ? fleetRunsFromAgents : traces.length;
  const fleetTokens = agents.reduce((sum, a) => sum + a.tokens24h, 0);
  const openIssues = agents.reduce((sum, a) => sum + a.openIssues, 0);
  const live = agents.filter((a) => a.status === "live").length;
  const idle = agents.filter((a) => a.status === "idle").length;
  const errored = agents.filter((a) => a.status === "error").length;
  const successRate =
    fleetRuns > 0
      ? agents.reduce((sum, a) => sum + a.successRate * a.runs24h, 0) / fleetRuns
      : 1;
  const errorRate = 1 - successRate;
  const avgCostPerRun = fleetCost / Math.max(fleetRuns, 1);
  const avgTokensPerRun = fleetTokens / Math.max(fleetRuns, 1);
  const p50Ms =
    fleetRuns > 0
      ? agents.reduce((sum, a) => sum + a.p50Ms * a.runs24h, 0) / fleetRuns
      : 0;
  const p95Ms = Math.max(...agents.map((a) => a.p95Ms), 0);
  const failedRuns24h = Math.round(fleetRuns * errorRate);
  const feedErrorRate =
    traces.length > 0 ? failures.length / traces.length : 0;

  /** Prior-period baseline for delta display — equal until live metrics wire up. */
  const prior = {
    fleetRuns,
    fleetCost,
    successRate,
    openIssues,
    failures: failures.length,
    p50Ms,
  };

  function deltaPct(current: number, previous: number) {
    if (previous === 0) return current === 0 ? 0 : 100;
    return ((current - previous) / previous) * 100;
  }

  return {
    failures,
    warnings,
    attention: attentionItems(traces),
    ok,
    recent: traces,
    cost,
    tokens,
    fleetCost,
    fleetRuns,
    fleetTokens,
    openIssues,
    live,
    idle,
    errored,
    successRate,
    errorRate,
    avgCostPerRun,
    avgTokensPerRun,
    p50Ms,
    p95Ms,
    failedRuns24h,
    feedErrorRate,
    agents: agents.length,
    deltas: {
      runs: deltaPct(fleetRuns, prior.fleetRuns),
      spend: deltaPct(fleetCost, prior.fleetCost),
      success: deltaPct(successRate, prior.successRate),
      issues: deltaPct(openIssues, Math.max(prior.openIssues, 0.01)),
      failures: deltaPct(failures.length, Math.max(prior.failures, 0.01)),
      latency: deltaPct(p50Ms, prior.p50Ms),
    },
  };
}


export { formatDuration, formatTokens, formatUsd };
