/**
 * AI context model — structured attach list for ai-insights chat.
 * Mirrors the backend `page_context` shape accepted by /orgs/{org}/ai-insights/chat.
 */

export interface AiContextItem {
  type:
    | "trace"
    | "session"
    | "issue"
    | "alert"
    | "finding"
    | "agent"
    | "plan"
    | "artifact"
    | "debuggerSession"
    | "experiment";
  id: string;
  /** Optional secondary id (e.g. spanId inside a trace). */
  secondaryId?: string;
  label?: string;
}

export interface PageContext {
  items: AiContextItem[];
  /** Raw org id — always present. */
  orgId?: string;
}

/**
 * Context param keys we parse from page URLs.
 * These are canonical per IA §4.2 / ai-agent.md §4.2.
 */
export const CONTEXT_PARAMS = [
  "traceId",
  "spanId",
  "issueId",
  "findingId",
  "agentId",
  "planId",
  "artifactId",
  "debuggerSessionId",
  "sessionId",
  "alertId",
] as const;

export type ContextParamKey = (typeof CONTEXT_PARAMS)[number];

/**
 * Build an attach list from a URL search-params map.
 * Priority: explicit URL params (no soft hints — those are caller's responsibility).
 */
export function buildContextFromParams(
  params: Partial<Record<ContextParamKey, string>>,
): AiContextItem[] {
  const items: AiContextItem[] = [];

  if (params.traceId) {
    items.push({
      type: "trace",
      id: params.traceId,
      secondaryId: params.spanId,
    });
  } else if (params.spanId) {
    items.push({ type: "trace", id: params.spanId, secondaryId: params.spanId });
  }

  if (params.sessionId) {
    items.push({ type: "session", id: params.sessionId });
  }

  if (params.issueId) {
    items.push({ type: "issue", id: params.issueId });
  }

  if (params.alertId) {
    items.push({ type: "alert", id: params.alertId });
  }

  if (params.findingId) {
    items.push({ type: "finding", id: params.findingId });
  }

  if (params.agentId) {
    items.push({ type: "agent", id: params.agentId });
  }

  if (params.planId) {
    items.push({ type: "plan", id: params.planId });
  }

  if (params.artifactId) {
    items.push({ type: "artifact", id: params.artifactId });
  }

  if (params.debuggerSessionId) {
    items.push({ type: "debuggerSession", id: params.debuggerSessionId });
  }

  return items;
}

/** Serialise attach list for the backend `page_context` field. */
export function serializePageContext(items: AiContextItem[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const item of items) {
    const key = item.type + "_ids";
    if (!out[key]) out[key] = [];
    out[key].push(item.id);
    if (item.secondaryId && item.type === "trace") {
      const sk = "span_ids";
      if (!out[sk]) out[sk] = [];
      out[sk].push(item.secondaryId);
    }
  }
  return out;
}
