import { planById } from "@/lab/fixtures/improve";
import { issueById } from "@/lab/fixtures/issues";
import { traceById } from "@/lab/fixtures/traces";
import { agentById } from "@/lab/fixtures/agents";
import {
  defaultSpendChartIntents,
  executeChartQueries,
} from "@/lab/agent/chart-query-catalog";

export type AgentCitationKind =
  | "trace"
  | "issue"
  | "plan"
  | "agent"
  | "cost"
  | "signal"
  | "evals";

export type AgentActionKind =
  | "navigate"
  | "open_plan"
  | "draft_signal"
  | "open_cost"
  | "open_issue"
  | "open_trace";

export type AgentCitation = {
  kind: AgentCitationKind;
  id: string;
  label: string;
};

export type AgentActionCard = {
  kind: AgentActionKind;
  title: string;
  body?: string;
  href: string;
  primary?: boolean;
};

/** Downloadable chart / spreadsheet embedded in a chat turn. */
export type AgentChartType =
  | "bar"
  | "horizontal_bar"
  | "line"
  | "area"
  | "pie"
  | "donut"
  | "radar"
  | "composed";

export type AgentChartPoint = {
  label: string;
  /** Primary series value. */
  value: number;
  /** Optional secondary series (composed / multi-metric). */
  value2?: number;
};

export type AgentSpreadsheetColumn = {
  key: string;
  label: string;
};

export type AgentArtifact =
  | {
      id: string;
      kind: "chart";
      title: string;
      subtitle?: string;
      chartType: AgentChartType;
      unit?: string;
      /** Label for primary series (tooltip / legend). */
      seriesLabel?: string;
      /** Label for secondary series when value2 is set. */
      seriesLabel2?: string;
      points: AgentChartPoint[];
      /** Base filename without extension (downloads add .png / .csv). */
      filename: string;
      /** Allowlisted query that produced this chart (intent → execute). */
      queryId?: string;
    }
  | {
      id: string;
      kind: "spreadsheet";
      title: string;
      subtitle?: string;
      columns: AgentSpreadsheetColumn[];
      rows: Record<string, string | number>[];
      /** Base filename without extension (.csv / .xlsx). */
      filename: string;
      queryId?: string;
    };

export type AgentMessagePart =
  | { type: "text"; text: string }
  | { type: "citations"; items: AgentCitation[] }
  | { type: "actions"; items: AgentActionCard[] }
  | { type: "artifacts"; items: AgentArtifact[] };

export type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  at: string;
  parts: AgentMessagePart[];
};

export type AgentContextPin = {
  kind: "trace" | "issue" | "plan" | "agent";
  id: string;
  label: string;
};

export type AgentThread = {
  id: string;
  title: string;
  updatedAt: string;
  pins: AgentContextPin[];
  messages: AgentMessage[];
};

export function labCitationHref(c: AgentCitation): string {
  switch (c.kind) {
    case "trace":
      return `/traces?id=${encodeURIComponent(c.id)}`;
    case "issue":
      return `/issues?id=${encodeURIComponent(c.id)}`;
    case "plan":
      return `/improve?mode=plan&id=${encodeURIComponent(c.id)}`;
    case "agent":
      return `/agents?id=${encodeURIComponent(c.id)}`;
    case "cost":
      return c.id
        ? `/cost?mode=drivers&id=${encodeURIComponent(c.id)}`
        : "/cost";
    case "signal":
      return `/signals?id=${encodeURIComponent(c.id)}`;
    case "evals":
      return "/evals";
    default:
      return "/home";
  }
}

export const SUGGESTED_PROMPTS: string[] = [];

/** Fixture artifacts for spend / cost replies — intent → execute. */
export function spendArtifacts(agentId?: string | null): AgentArtifact[] {
  return executeChartQueries(
    defaultSpendChartIntents({
      agentId: agentId && agentId !== "all" ? agentId : "all",
      window: "24h",
    }),
  );
}

/** Starter prompts from pinned objects — empty until Assistant is live. */
export function suggestionsForPins(_pins: AgentContextPin[]): string[] {
  return [];
}

export function pinFromParams(input: {
  traceId?: string | null;
  issueId?: string | null;
  planId?: string | null;
  agentId?: string | null;
}): AgentContextPin[] {
  const pins: AgentContextPin[] = [];
  if (input.traceId) {
    const t = traceById(input.traceId);
    pins.push({
      kind: "trace",
      id: input.traceId,
      label: t?.name ?? input.traceId,
    });
  }
  if (input.issueId) {
    const i = issueById(input.issueId);
    pins.push({
      kind: "issue",
      id: input.issueId,
      label: i?.title ?? input.issueId,
    });
  }
  if (input.planId) {
    const p = planById(input.planId);
    pins.push({
      kind: "plan",
      id: input.planId,
      label: p?.title ?? input.planId,
    });
  }
  if (input.agentId && input.agentId !== "all") {
    const a = agentById(input.agentId);
    pins.push({
      kind: "agent",
      id: input.agentId,
      label: a?.name ?? input.agentId,
    });
  }
  return pins;
}

export function pinHref(pin: AgentContextPin): string {
  if (pin.kind === "trace") return `/traces?id=${pin.id}`;
  if (pin.kind === "issue") return `/issues?id=${pin.id}`;
  if (pin.kind === "plan") return `/improve?mode=plan&id=${pin.id}`;
  return `/agents?id=${pin.id}`;
}

export function newEmptyThread(): AgentThread {
  return {
    id: `thr_${Date.now().toString(36)}`,
    title: "New chat",
    updatedAt: "just now",
    pins: [],
    messages: [],
  };
}
