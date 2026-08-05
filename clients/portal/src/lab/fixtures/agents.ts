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
  /** null = unknown / no scored outcomes — never invent 0% or 100%. */
  successRate: number | null;
  errorRate: number | null;
  p50Ms: number;
  p95Ms: number;
  /** null = cost unknown (degraded metrics). */
  costUsd24h: number | null;
  tokens24h: number;
  openIssues: number;
  lastSeen: string;
  topError?: string;
  /**
   * BUG-6: raw telemetry-side agent_id labels (e.g.
   * "pydantic-ai:OpenAIChatModel()") that were reconciled into this card
   * via agent_identity_aliases instead of rendering as a separate ghost
   * card. Empty/absent for cards with no resolved aliases.
   */
  mergedIdentities?: string[];
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
  const cost = traces.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  const tokens = traces.reduce((sum, t) => sum + t.tokens, 0);
  const knownAgentCosts = agents
    .map((a) => a.costUsd24h)
    .filter((c): c is number => c != null && Number.isFinite(c));
  const agentFleetCost =
    knownAgentCosts.length > 0
      ? knownAgentCosts.reduce((sum, c) => sum + c, 0)
      : null;
  // Prefer agent-card rollup when known; otherwise traces. Never invent
  // $0 from null agent costs alone when the traces feed also has spend.
  const fleetCost =
    agentFleetCost != null
      ? Math.max(agentFleetCost, cost)
      : traces.length > 0
        ? cost
        : null;
  // One source of truth: agent card runs only. Do not inflate from the
  // traces feed — that made "N runs" disagree with "no runs yet" success.
  const fleetRuns = agents.reduce((sum, a) => sum + a.runs24h, 0);
  const agentFleetTokens = agents.reduce((sum, a) => sum + a.tokens24h, 0);
  const fleetTokens = Math.max(agentFleetTokens, tokens);
  const openIssues = agents.reduce((sum, a) => sum + a.openIssues, 0);
  const live = agents.filter((a) => a.status === "live").length;
  const idle = agents.filter((a) => a.status === "idle").length;
  const errored = agents.filter((a) => a.status === "error").length;
  const scoredRuns = agents.reduce(
    (sum, a) => sum + (a.successRate != null && a.runs24h > 0 ? a.runs24h : 0),
    0,
  );
  const successRate =
    scoredRuns > 0
      ? agents.reduce(
          (sum, a) =>
            a.successRate != null && a.runs24h > 0
              ? sum + a.successRate * a.runs24h
              : sum,
          0,
        ) / scoredRuns
      : null;
  const errorRate = successRate == null ? null : 1 - successRate;
  const avgCostPerRun =
    fleetCost != null && fleetRuns > 0 ? fleetCost / fleetRuns : null;
  const avgTokensPerRun = fleetTokens / Math.max(fleetRuns, 1);
  const p50Ms =
    fleetRuns > 0
      ? agents.reduce((sum, a) => sum + a.p50Ms * a.runs24h, 0) / fleetRuns
      : 0;
  const p95Ms = Math.max(...agents.map((a) => a.p95Ms), 0);
  const failedRuns24h =
    errorRate == null ? 0 : Math.round(fleetRuns * errorRate);
  const feedErrorRate =
    traces.length > 0 ? failures.length / traces.length : 0;

  /** Prior-period baseline for delta display — equal until live metrics wire up. */
  const prior = {
    fleetRuns,
    fleetCost,
    successRate: successRate ?? 0,
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
      spend: deltaPct(fleetCost ?? 0, prior.fleetCost ?? 0),
      success: deltaPct(successRate ?? 0, prior.successRate),
      issues: deltaPct(openIssues, Math.max(prior.openIssues, 0.01)),
      failures: deltaPct(failures.length, Math.max(prior.failures, 0.01)),
      latency: deltaPct(p50Ms, prior.p50Ms),
    },
  };
}


export { formatDuration, formatTokens, formatUsd };
