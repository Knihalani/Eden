/**
 * Client-side agent health derivation for Dashboard + Agents (Phase 2).
 * No FastAPI changes — compose from agents / summary / traces / issues.
 */

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock,
  Moon,
  type LucideIcon,
} from "lucide-react";
import type { StatusDescriptor } from "@/lib/types";

export type AgentHealthStatus =
  | "healthy"
  | "degraded"
  | "failing"
  | "idle"
  | "silent"
  | "unknown";

export type NextActionKind =
  | "connect"
  | "review_failures"
  | "open_issue"
  | "create_plan"
  | "healthy";

export type Diagnosis = {
  openIssueCount: number;
  errorTraceCount: number;
  worstAgentId?: string;
  worstAgentName?: string;
  windowHours: number;
  primaryHref: string;
};

export type NextAction = {
  kind: NextActionKind;
  href: string;
  labelKey: string;
};

export type FailureRow = {
  traceId: string;
  agentId: string | null;
  summary: string;
  outcome: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  startedAt: string | null;
};

export type AgentOsRow = {
  agentId: string;
  displayName: string;
  status: AgentHealthStatus;
  errorRate: number | null;
  costUsd: number | null;
  lastSeenAt: string | null;
  openIssueCount: number;
};

/** StatusBadge descriptors for agent health — do not merge into job STATUS. */
export const AGENT_HEALTH_STATUSES: Record<AgentHealthStatus, StatusDescriptor> = {
  healthy: {
    label: "Healthy",
    className: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
    icon: CheckCircle2 as LucideIcon,
  },
  degraded: {
    label: "Degraded",
    className: "bg-[var(--warning-bg)] text-[var(--warning)]",
    icon: AlertTriangle as LucideIcon,
  },
  failing: {
    label: "Failing",
    className: "bg-[var(--error-bg)] text-[var(--error)]",
    icon: AlertCircle as LucideIcon,
  },
  idle: {
    label: "Idle",
    className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
    icon: Moon as LucideIcon,
  },
  silent: {
    label: "Silent",
    className: "bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
    icon: Clock as LucideIcon,
  },
  unknown: {
    label: "Unknown",
    className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
    icon: Circle as LucideIcon,
  },
};

const SILENT_MS = 24 * 60 * 60 * 1000;
const FAILING_ERROR_RATE = 0.1;
const DEGRADED_ERROR_RATE = 0.02;

export function deriveAgentStatus(input: {
  lastSeenAt: string | null | undefined;
  errorRate: number | null | undefined;
  openIssueCount: number;
  hasTrafficInWindow: boolean;
  nowMs?: number;
}): AgentHealthStatus {
  const now = input.nowMs ?? Date.now();
  const lastSeenMs = input.lastSeenAt
    ? Date.parse(input.lastSeenAt)
    : Number.NaN;
  const hasLastSeen = Number.isFinite(lastSeenMs);

  if (!hasLastSeen && !input.hasTrafficInWindow) {
    return "unknown";
  }

  if (hasLastSeen && now - lastSeenMs > SILENT_MS && !input.hasTrafficInWindow) {
    return "silent";
  }

  if (!input.hasTrafficInWindow) {
    return "idle";
  }

  const rate = input.errorRate ?? 0;
  const issues = input.openIssueCount;

  if (rate >= FAILING_ERROR_RATE || issues >= 3) {
    return "failing";
  }
  if (rate >= DEGRADED_ERROR_RATE || issues >= 1) {
    return "degraded";
  }
  return "healthy";
}

export function buildDiagnosis(input: {
  openIssueCount: number;
  errorTraceCount: number;
  windowHours: number;
  worstAgentId?: string | null;
  worstAgentName?: string | null;
  agentCount: number;
  traceCountEver: number;
}): Diagnosis {
  const worstAgentId = input.worstAgentId ?? undefined;
  const worstAgentName = input.worstAgentName ?? undefined;

  let primaryHref = "/traces";
  if (input.agentCount === 0 || input.traceCountEver === 0) {
    primaryHref = "/agents/connect";
  } else if (input.openIssueCount > 0 && worstAgentId) {
    primaryHref = `/issues?agentId=${encodeURIComponent(worstAgentId)}`;
  } else if (input.openIssueCount > 0) {
    primaryHref = "/issues";
  } else if (input.errorTraceCount > 0 && worstAgentId) {
    primaryHref = `/traces?outcome=error&agentId=${encodeURIComponent(worstAgentId)}`;
  } else if (input.errorTraceCount > 0) {
    primaryHref = "/traces?outcome=error";
  } else if (worstAgentId) {
    primaryHref = `/agents/${encodeURIComponent(worstAgentId)}`;
  }

  return {
    openIssueCount: input.openIssueCount,
    errorTraceCount: input.errorTraceCount,
    worstAgentId,
    worstAgentName,
    windowHours: input.windowHours,
    primaryHref,
  };
}

export function buildNextAction(input: {
  agentCount: number;
  traceCountEver: number;
  openIssueCount: number;
  errorTraceCount: number;
  worstAgentId?: string | null;
  worstStatus?: AgentHealthStatus | null;
}): NextAction {
  if (input.agentCount === 0 || input.traceCountEver === 0) {
    return {
      kind: "connect",
      href: "/agents/connect",
      labelKey: "dashboard.nextAction.kinds.connect",
    };
  }

  if (input.openIssueCount > 0) {
    const href = input.worstAgentId
      ? `/issues?agentId=${encodeURIComponent(input.worstAgentId)}`
      : "/issues";
    return {
      kind: "open_issue",
      href,
      labelKey: "dashboard.nextAction.kinds.openIssue",
    };
  }

  if (input.errorTraceCount > 0) {
    const href = input.worstAgentId
      ? `/traces?outcome=error&agentId=${encodeURIComponent(input.worstAgentId)}`
      : "/traces?outcome=error";
    return {
      kind: "review_failures",
      href,
      labelKey: "dashboard.nextAction.kinds.reviewFailures",
    };
  }

  if (
    input.worstStatus === "failing" ||
    input.worstStatus === "degraded"
  ) {
    const href = input.worstAgentId
      ? `/improve?tab=plans&agentId=${encodeURIComponent(input.worstAgentId)}`
      : "/improve?tab=plans";
    return {
      kind: "create_plan",
      href,
      labelKey: "dashboard.nextAction.kinds.createPlan",
    };
  }

  return {
    kind: "healthy",
    href: "/traces",
    labelKey: "dashboard.nextAction.kinds.healthy",
  };
}

export function mapFailureRows(
  traces: Array<{
    trace_id: string;
    agent_id?: string | null;
    outcome?: string | null;
    duration_ms?: number | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    cost_cents?: number | null;
    error?: string | null;
    started_at?: string | null;
    model?: string | null;
  }>,
  limit = 5,
): FailureRow[] {
  return traces
    .filter((t) => {
      const o = (t.outcome ?? "").toLowerCase();
      return (
        o === "error" ||
        o === "failure" ||
        o === "failed" ||
        o === "crash" ||
        Boolean(t.error)
      );
    })
    .slice(0, limit)
    .map((t) => {
      const tokens =
        (t.input_tokens ?? 0) + (t.output_tokens ?? 0) || null;
      return {
        traceId: t.trace_id,
        agentId: t.agent_id ?? null,
        summary: t.error || t.model || t.outcome || t.trace_id,
        outcome: t.outcome ?? null,
        latencyMs: t.duration_ms ?? null,
        totalTokens: tokens,
        costUsd:
          t.cost_cents != null ? t.cost_cents / 100 : null,
        startedAt: t.started_at ?? null,
      };
    });
}

export function pickWorstAgent(
  rows: AgentOsRow[],
): { agentId: string; displayName: string; status: AgentHealthStatus } | null {
  if (rows.length === 0) return null;
  const rank: Record<AgentHealthStatus, number> = {
    failing: 5,
    degraded: 4,
    silent: 3,
    idle: 2,
    unknown: 1,
    healthy: 0,
  };
  const sorted = [...rows].sort((a, b) => {
    const rd = rank[b.status] - rank[a.status];
    if (rd !== 0) return rd;
    return (b.errorRate ?? 0) - (a.errorRate ?? 0);
  });
  const top = sorted[0]!;
  return {
    agentId: top.agentId,
    displayName: top.displayName,
    status: top.status,
  };
}
