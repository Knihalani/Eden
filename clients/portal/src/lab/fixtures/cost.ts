import { AGENT_LIST, type AgentFixture } from "@/lab/fixtures/agents";
import {
  TRACE_LIST,
  formatUsd,
  type TraceFixture,
} from "@/lab/fixtures/traces";
import {
  catalogAgents,
  catalogCostDrivers,
  catalogTraces,
} from "@/lib/portal-catalog";
import {
  BUDGET_PRESSURE_RATIO,
  budgetIsPressure,
  budgetRatio,
  budgetStatusFromSpend,
  type BudgetStatus,
} from "@/lab/home-budget";

export type { BudgetStatus };
export {
  BUDGET_PRESSURE_RATIO,
  budgetIsPressure,
  budgetRatio,
  budgetStatusFromSpend,
};

export type CostBudgetFixture = {
  id: string;
  name: string;
  scope: "org" | "agent";
  agentId?: string;
  limitUsd: number;
  spentUsd: number;
  period: "24h" | "7d";
  status: BudgetStatus;
};

export type CostDriverKind =
  | "tool_fanout"
  | "model_swap"
  | "token_loop"
  | "eval_regress"
  | "healthy";

export type CostDriverFixture = {
  id: string;
  title: string;
  summary: string;
  kind: CostDriverKind;
  agentId: string;
  estSaveUsd: number;
  confidence: "high" | "med";
  traceIds: string[];
  primaryAction: "open_traces" | "open_improve" | "open_evals" | "open_agent";
  improvePlanId?: string;
  baselineId?: string;
  compareId?: string;
};

function liveAgents(): AgentFixture[] {
  const live = catalogAgents();
  return live.length > 0 ? live : AGENT_LIST;
}

function liveTraces(): TraceFixture[] {
  const live = catalogTraces();
  return live.length > 0 ? live : TRACE_LIST;
}

/** Sum of known agent costs; null when every agent cost is unknown. */
export function fleetSpend24h(): number | null {
  const known = liveAgents()
    .map((a) => a.costUsd24h)
    .filter((c): c is number => c != null && Number.isFinite(c));
  const fromAgents =
    known.length > 0 ? known.reduce((s, c) => s + c, 0) : null;
  const fromTraces = liveTraces().reduce((s, t) => s + (t.costUsd ?? 0), 0);
  if (fromAgents != null) return Math.max(fromAgents, fromTraces);
  return liveTraces().length > 0 ? fromTraces : null;
}

export function fleetRuns24h(): number {
  return liveAgents().reduce((s, a) => s + a.runs24h, 0);
}

export function avgCostPerRun(): number | null {
  const runs = fleetRuns24h();
  const spend = fleetSpend24h();
  if (!runs || spend == null) return null;
  return spend / runs;
}

const ORG_BUDGET_LIMIT = 0;
// Fixture fallback only — live Cost page uses gateway budget rollup.
const ORG_BUDGET_SPENT = 0;

export const COST_BUDGET: CostBudgetFixture = {
  id: "bud_org_24h",
  name: "Org · 24h",
  scope: "org",
  limitUsd: ORG_BUDGET_LIMIT,
  spentUsd: ORG_BUDGET_SPENT,
  period: "24h",
  status: budgetStatusFromSpend(ORG_BUDGET_SPENT, ORG_BUDGET_LIMIT),
};

export const COST_DRIVERS: CostDriverFixture[] = [];

function liveDrivers(): CostDriverFixture[] {
  const live = catalogCostDrivers();
  return live.length > 0 ? live : COST_DRIVERS;
}

export function agentsBySpend(): AgentFixture[] {
  return [...liveAgents()].sort((a, b) => {
    // Unknown costs sort last (not as $0).
    const ac = a.costUsd24h;
    const bc = b.costUsd24h;
    if (ac == null && bc == null) return 0;
    if (ac == null) return 1;
    if (bc == null) return -1;
    return bc - ac;
  });
}

export function costlyTraces(
  agentId: string | "all" = "all",
  limit = 8,
): TraceFixture[] {
  const list =
    agentId === "all"
      ? liveTraces()
      : liveTraces().filter((t) => t.agentId === agentId);
  return [...list]
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1))
    .slice(0, limit);
}

export function driverById(id: string): CostDriverFixture | undefined {
  return liveDrivers().find((d) => d.id === id);
}

export function driversForAgent(
  agentId: string | "all",
): CostDriverFixture[] {
  const rows =
    agentId === "all"
      ? liveDrivers()
      : liveDrivers().filter((d) => d.agentId === agentId);
  return [...rows].sort((a, b) => b.estSaveUsd - a.estSaveUsd);
}

export function budgetStatusLabel(status: BudgetStatus): string {
  if (status === "unset") return "no limit";
  if (status === "breach") return "over";
  if (status === "warn") return "near limit";
  return "on track";
}

export function driverKindLabel(kind: CostDriverKind): string {
  if (kind === "tool_fanout") return "tools";
  if (kind === "model_swap") return "model";
  if (kind === "token_loop") return "tokens";
  if (kind === "healthy") return "healthy";
  return "evals";
}

export function formatSpend(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return formatUsd(n, n < 1 ? 3 : 2);
}

export function defaultDriverId(agentId: string | "all" = "all"): string {
  const rows = driversForAgent(agentId);
  return rows.find((d) => d.estSaveUsd > 0)?.id ?? rows[0]?.id ?? "";
}

export function totalDriverSaveUsd(agentId: string | "all" = "all"): number {
  return driversForAgent(agentId).reduce((s, d) => s + d.estSaveUsd, 0);
}
