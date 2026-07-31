/**
 * Allowlisted chart queries for the lab AI Agent.
 *
 * The agent chooses `{ queryId, chartType? }` — this module executes the
 * query against lab fixtures and materializes a downloadable artifact.
 * Bandwidth stays small: intents are tiny; points are filled here (or
 * later by a real warehouse), never as PNGs in the chat stream.
 */

import { AGENT_LIST } from "@/lab/fixtures/agents";
import { COST_DRIVERS } from "@/lab/fixtures/cost";
import type {
  AgentArtifact,
  AgentChartPoint,
  AgentChartType,
} from "@/lab/fixtures/agent-chat";

export type ChartQueryId =
  | "spend_by_agent"
  | "spend_share"
  | "spend_hourly"
  | "runs_by_agent"
  | "spend_vs_success"
  | "error_rate_by_agent"
  | "driver_save_table";

export type ChartQueryScope = {
  agentId?: string | "all" | null;
  window?: "24h" | "7d";
};

export type ChartQueryIntent = {
  queryId: ChartQueryId;
  /** Override the catalog default chart type when allowed. */
  chartType?: AgentChartType;
  title?: string;
  subtitle?: string;
  filename?: string;
  scope?: ChartQueryScope;
};

export type ChartQueryDef = {
  id: ChartQueryId;
  label: string;
  description: string;
  defaultChartType: AgentChartType | "spreadsheet";
  allowedChartTypes: AgentChartType[];
  unit?: string;
  seriesLabel?: string;
  seriesLabel2?: string;
  keywords: string[];
};

const HOURLY_SPEND: AgentChartPoint[] = [];

function shortName(name: string): string {
  return name.replace(/-agent$/, "").replace(/-triage$/, "");
}

function agentsInScope(scope?: ChartQueryScope) {
  const id = scope?.agentId;
  if (!id || id === "all") return [...AGENT_LIST];
  return AGENT_LIST.filter((a) => a.id === id);
}

export const CHART_QUERY_CATALOG: Record<ChartQueryId, ChartQueryDef> = {
  spend_by_agent: {
    id: "spend_by_agent",
    label: "Spend by agent",
    description: "USD spend rolled up per agent over the window",
    defaultChartType: "bar",
    allowedChartTypes: ["bar", "horizontal_bar", "pie", "donut"],
    unit: "$",
    seriesLabel: "Spend USD",
    keywords: ["spend", "cost", "budget", "usd", "money"],
  },
  spend_share: {
    id: "spend_share",
    label: "Spend share",
    description: "Share-of-total spend by agent",
    defaultChartType: "donut",
    allowedChartTypes: ["donut", "pie", "bar"],
    unit: "$",
    seriesLabel: "Spend USD",
    keywords: ["share", "breakdown", "pie", "donut", "proportion"],
  },
  spend_hourly: {
    id: "spend_hourly",
    label: "Hourly spend",
    description: "Fleet spend buckets over the last 24h",
    defaultChartType: "area",
    allowedChartTypes: ["area", "line", "bar"],
    unit: "$",
    seriesLabel: "USD / hour",
    keywords: ["hourly", "trend", "timeseries", "over time", "timeline"],
  },
  runs_by_agent: {
    id: "runs_by_agent",
    label: "Runs by agent",
    description: "Run volume per agent",
    defaultChartType: "horizontal_bar",
    allowedChartTypes: ["horizontal_bar", "bar"],
    seriesLabel: "Runs",
    keywords: ["runs", "volume", "throughput", "traffic"],
  },
  spend_vs_success: {
    id: "spend_vs_success",
    label: "Spend vs success",
    description: "Cost beside success rate (composed)",
    defaultChartType: "composed",
    allowedChartTypes: ["composed", "line", "bar"],
    unit: "$",
    seriesLabel: "Spend USD",
    seriesLabel2: "Success %",
    keywords: ["success", "quality", "composed", "vs", "tradeoff"],
  },
  error_rate_by_agent: {
    id: "error_rate_by_agent",
    label: "Error rate by agent",
    description: "Error % radar / comparison across agents",
    defaultChartType: "radar",
    allowedChartTypes: ["radar", "bar", "horizontal_bar"],
    unit: "%",
    seriesLabel: "Error %",
    keywords: ["error", "fail", "failure", "radar", "reliability"],
  },
  driver_save_table: {
    id: "driver_save_table",
    label: "Driver save opportunity",
    description: "Tabular cost-driver save estimates",
    defaultChartType: "spreadsheet",
    allowedChartTypes: [],
    keywords: ["driver", "save", "spreadsheet", "table", "xlsx", "csv"],
  },
};

export function isChartQueryId(id: string): id is ChartQueryId {
  return id in CHART_QUERY_CATALOG;
}

function pickChartType(
  def: ChartQueryDef,
  override?: AgentChartType,
): AgentChartType | "spreadsheet" {
  if (def.defaultChartType === "spreadsheet") return "spreadsheet";
  if (override && def.allowedChartTypes.includes(override)) return override;
  return def.defaultChartType;
}

function runSeries(
  queryId: ChartQueryId,
  scope?: ChartQueryScope,
): AgentChartPoint[] {
  const agents = agentsInScope(scope).sort(
    (a, b) => (b.costUsd24h ?? 0) - (a.costUsd24h ?? 0),
  );

  switch (queryId) {
    case "spend_by_agent":
    case "spend_share":
      return agents.map((a) => ({
        label: shortName(a.name),
        value: Number((a.costUsd24h ?? 0).toFixed(2)),
      }));
    case "spend_hourly":
      return HOURLY_SPEND.map((p) => ({ ...p }));
    case "runs_by_agent":
      return [...agents]
        .sort((a, b) => b.runs24h - a.runs24h)
        .map((a) => ({
          label: shortName(a.name),
          value: a.runs24h,
        }));
    case "spend_vs_success":
      return agents
        .filter((a) => a.successRate != null)
        .map((a) => ({
          label: shortName(a.name),
          value: Number((a.costUsd24h ?? 0).toFixed(2)),
          value2: Number(((a.successRate ?? 0) * 100).toFixed(1)),
        }));
    case "error_rate_by_agent":
      return agents
        .filter((a) => a.errorRate != null)
        .map((a) => ({
          label: shortName(a.name),
          value: Number(((a.errorRate ?? 0) * 100).toFixed(1)),
        }));
    case "driver_save_table":
      return [];
  }
}

/** Execute an allowlisted intent → chart or spreadsheet artifact. */
export function executeChartQuery(intent: ChartQueryIntent): AgentArtifact {
  const def = CHART_QUERY_CATALOG[intent.queryId];
  if (!def) {
    throw new Error(`Unknown chart query: ${intent.queryId}`);
  }

  const chartType = pickChartType(def, intent.chartType);
  const window = intent.scope?.window ?? "24h";
  const scopeNote =
    intent.scope?.agentId && intent.scope.agentId !== "all"
      ? ` · ${intent.scope.agentId}`
      : "";

  if (chartType === "spreadsheet" || intent.queryId === "driver_save_table") {
    const rows = COST_DRIVERS.filter((d) => {
      const aid = intent.scope?.agentId;
      if (!aid || aid === "all") return true;
      return d.agentId === aid;
    }).map((d) => ({
      driver: d.title,
      agent: AGENT_LIST.find((a) => a.id === d.agentId)?.name ?? d.agentId,
      estSaveUsd: d.estSaveUsd,
      confidence: d.confidence,
    }));

    return {
      id: `art_${intent.queryId}_sheet`,
      kind: "spreadsheet",
      title: intent.title ?? `${def.label} · ${window}`,
      subtitle:
        intent.subtitle ??
        `query:${intent.queryId}${scopeNote} · CSV / XLSX`,
      filename: intent.filename ?? `eden-${intent.queryId}`,
      queryId: intent.queryId,
      columns: [
        { key: "driver", label: "Driver" },
        { key: "agent", label: "Agent" },
        { key: "estSaveUsd", label: "Est. save USD" },
        { key: "confidence", label: "Confidence" },
      ],
      rows,
    };
  }

  const points = runSeries(intent.queryId, intent.scope);

    return {
      id: `art_${intent.queryId}_${chartType}`,
      kind: "chart",
      title: intent.title ?? `${def.label} · ${window}`,
      subtitle:
        intent.subtitle ??
        `query:${intent.queryId} · ${chartType}${scopeNote} · PNG / CSV`,
      chartType,
      unit: def.unit,
      seriesLabel: def.seriesLabel,
      seriesLabel2: def.seriesLabel2,
      filename: intent.filename ?? `eden-${intent.queryId}${chartType === def.defaultChartType ? "" : `-${chartType}`}`,
      points,
      queryId: intent.queryId,
    };
}

export function executeChartQueries(
  intents: ChartQueryIntent[],
): AgentArtifact[] {
  return intents.map((i) => executeChartQuery(i));
}

/**
 * Heuristic “agent chooses graph + query” from natural language + pins.
 * Production would be the LLM emitting ChartQueryIntent JSON; lab fixtures
 * use this selector so the same execute path runs.
 */
export function selectChartIntents(
  prompt: string,
  scope?: ChartQueryScope,
): ChartQueryIntent[] {
  const q = prompt.toLowerCase();
  const pinnedAgent =
    scope?.agentId && scope.agentId !== "all" ? scope.agentId : undefined;
  const baseScope: ChartQueryScope = {
    agentId: pinnedAgent ?? "all",
    window: "24h",
  };

  const wantsTable =
    q.includes("spreadsheet") ||
    q.includes("xlsx") ||
    (q.includes("table") && !q.includes("stable"));
  const wantsShare =
    q.includes("share") || q.includes("pie") || q.includes("donut");
  const wantsTrend =
    q.includes("hourly") ||
    q.includes("trend") ||
    q.includes("over time") ||
    q.includes("timeline") ||
    q.includes("area chart") ||
    (q.includes("line") && q.includes("chart"));
  const wantsRuns = /\bruns?\b/.test(q) && !q.includes("fail");
  const wantsSuccess =
    q.includes("success") || q.includes("tradeoff") || q.includes("vs success");
  const wantsError =
    q.includes("error rate") ||
    q.includes("radar") ||
    (q.includes("error") && q.includes("chart"));
  const wantsSpend =
    q.includes("spend") ||
    q.includes("cost") ||
    q.includes("budget") ||
    q.includes("chart") ||
    q.includes("graph") ||
    q.includes("csv") ||
    q.includes("export");

  // Broad spend ask → full demo pack (intent → execute).
  if (
    wantsSpend &&
    !wantsShare &&
    !wantsTrend &&
    !wantsRuns &&
    !wantsSuccess &&
    !wantsError &&
    !wantsTable
  ) {
    return defaultSpendChartIntents(baseScope);
  }

  const intents: ChartQueryIntent[] = [];
  const add = (queryId: ChartQueryId, chartType?: AgentChartType) => {
    if (
      intents.some(
        (i) => i.queryId === queryId && (i.chartType ?? null) === (chartType ?? null),
      )
    ) {
      return;
    }
    intents.push({ queryId, chartType, scope: baseScope });
  };

  if (wantsShare) add("spend_share", q.includes("pie") ? "pie" : "donut");
  if (wantsTrend) add("spend_hourly", q.includes("line") ? "line" : "area");
  if (wantsRuns) add("runs_by_agent", "horizontal_bar");
  if (wantsSuccess) add("spend_vs_success", "composed");
  if (wantsError) add("error_rate_by_agent", "radar");
  if (wantsTable || q.includes("driver")) add("driver_save_table");
  if (
    wantsSpend &&
    intents.every((i) => i.queryId !== "spend_by_agent") &&
    !wantsShare &&
    !wantsTrend
  ) {
    add("spend_by_agent", q.includes("horizontal") ? "horizontal_bar" : "bar");
  }

  if (intents.length === 0 && (q.includes("chart") || q.includes("graph"))) {
    return defaultSpendChartIntents(baseScope).slice(0, 3);
  }

  return intents;
}

/** Canonical pack used by the Spend drivers placeholder thread. */
export function defaultSpendChartIntents(
  scope?: ChartQueryScope,
): ChartQueryIntent[] {
  const s: ChartQueryScope = { agentId: scope?.agentId ?? "all", window: "24h" };
  return [
    { queryId: "spend_by_agent", chartType: "bar", scope: s },
    { queryId: "runs_by_agent", chartType: "horizontal_bar", scope: s },
    { queryId: "spend_share", chartType: "donut", scope: s },
    { queryId: "spend_hourly", chartType: "area", scope: s },
    {
      queryId: "spend_hourly",
      chartType: "line",
      title: "Hourly spend trend · 24h",
      filename: "eden-spend-hourly-line",
      scope: s,
    },
    { queryId: "spend_vs_success", chartType: "composed", scope: s },
    { queryId: "error_rate_by_agent", chartType: "radar", scope: s },
    { queryId: "driver_save_table", scope: s },
  ];
}
