/** Shared ChatSidebar types (W20 spine + W21 navigate/filters). */

export interface Session {
  session_id: string;
  title: string;
  updated_at: string | null;
  archived: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: {
    status: "ok" | "error";
    output?: unknown;
    duration_ms?: number;
  };
}

export interface ChatCitation {
  kind: string;
  id: string;
  label: string;
  excerpt?: string;
  trace_id?: string;
}

export interface ChatChart {
  type: string;
  title: string;
  data: Array<Record<string, unknown>>;
  unit?: string;
  x_key?: string;
  y_key?: string;
  y2_key?: string;
  group_key?: string;
  label_key?: string;
  value_key?: string;
  row_key?: string;
  col_key?: string;
  source_key?: string;
  target_key?: string;
  columns?: string[];
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  text?: string;
  toolCalls?: ToolCall[];
  charts?: ChatChart[];
  citations?: ChatCitation[];
  streaming?: boolean;
  isError?: boolean;
  costUsd?: number;
}

/** Rich portal context sent with each chat turn (W21). */
export type PageContextPayload = {
  pathname?: string;
  search?: string;
  resource?: string;
  trace_id?: string;
  issue_id?: string;
  session_id?: string;
  alert_id?: string;
  artifact_id?: string;
  q?: string;
  selected_id?: string;
  filters?: Record<string, string>;
};

export function newMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const SIDEBAR_WIDTH = 360;

function resourceFromPath(path: string): string | undefined {
  const seg = path.split("/").filter(Boolean)[0];
  return seg || undefined;
}

export function buildPageContext(pathname: string | null): PageContextPayload {
  const path = pathname ?? (typeof window !== "undefined" ? window.location.pathname : "");
  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : null;
  const search = params?.toString() || undefined;

  const fromQuery =
    params?.get("trace_id") ||
    params?.get("traceId") ||
    params?.get("trace") ||
    null;
  const fromPath = path.match(/\/(?:traces|replay)\/([^/?#]+)/)?.[1] ?? null;
  const issueFromPath = path.match(/\/issues\/([^/?#]+)/)?.[1] ?? null;
  const sessionFromPath =
    path.match(/\/sessions\/([^/?#]+)/)?.[1] ??
    path.match(/\/debugger-sessions\/([^/?#]+)/)?.[1] ??
    null;

  const issue_id =
    params?.get("issueId") || params?.get("issue_id") || issueFromPath || undefined;
  const session_id =
    params?.get("sessionId") ||
    params?.get("session_id") ||
    sessionFromPath ||
    undefined;
  const alert_id = params?.get("alertId") || params?.get("alert_id") || undefined;
  const artifact_id =
    params?.get("artifactId") || params?.get("artifact_id") || undefined;
  const q = params?.get("q") || params?.get("filter") || undefined;
  const trace_id = fromQuery || fromPath || undefined;

  const filters: Record<string, string> = {};
  if (issue_id) filters.issue_id = issue_id;
  if (session_id) filters.session_id = session_id;
  if (alert_id) filters.alert_id = alert_id;
  if (artifact_id) filters.artifact_id = artifact_id;
  if (q) filters.q = q;
  if (params?.get("agent_id")) filters.agent_id = params.get("agent_id")!;
  if (params?.get("outcome")) filters.outcome = params.get("outcome")!;
  if (params?.get("view")) filters.view = params.get("view")!;

  const selected_id =
    trace_id || issue_id || session_id || alert_id || artifact_id || undefined;

  return {
    ...(path ? { pathname: path } : {}),
    ...(search ? { search: `?${search}` } : {}),
    ...(resourceFromPath(path) ? { resource: resourceFromPath(path) } : {}),
    ...(trace_id ? { trace_id } : {}),
    ...(issue_id ? { issue_id } : {}),
    ...(session_id ? { session_id } : {}),
    ...(alert_id ? { alert_id } : {}),
    ...(artifact_id ? { artifact_id } : {}),
    ...(q ? { q } : {}),
    ...(selected_id ? { selected_id } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
  };
}

export function needsApproval(tc: ToolCall): boolean {
  if (
    tc.name === "preview_nl_alert" ||
    tc.name === "preview_nl_signal" ||
    tc.name === "create_dataset" ||
    tc.name === "promote_trace_to_dataset" ||
    tc.name === "create_experiment" ||
    tc.name === "create_playground" ||
    tc.name === "playground_from_span"
  ) {
    return true;
  }
  const out = tc.result?.output;
  if (out && typeof out === "object" && (out as { approval_required?: boolean }).approval_required) {
    return true;
  }
  return false;
}

/** Operator model picker options (W23 Loop-class). */
export const CHAT_MODEL_OPTIONS = [
  {
    id: "auto",
    label: "Auto",
    tier: "auto" as const,
    description: "T1/SLM for simple; T3 for tools",
  },
  {
    id: "t1",
    label: "Fast",
    tier: "t1" as const,
    description: "Lowest TTFT / cost",
  },
  {
    id: "t3",
    label: "Expert",
    tier: "t3" as const,
    description: "Multi-tool copilot",
  },
] as const;

export type ChatModelOptionId = (typeof CHAT_MODEL_OPTIONS)[number]["id"];

export function resolvePreferredTier(optionId: string): {
  preferred_model?: string;
  preferred_tier: string;
} {
  if (optionId === "t1") return { preferred_tier: "t1" };
  if (optionId === "t3") return { preferred_tier: "t3" };
  return { preferred_model: "auto", preferred_tier: "auto" };
}
