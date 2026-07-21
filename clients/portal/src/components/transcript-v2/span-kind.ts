export type SpanKind = "llm" | "tool" | "subagent" | "error" | "span";

export function classifySpanKind(row: {
  outcome?: string | null;
  request_body?: unknown;
  response_body?: unknown;
  event_type?: string;
  tool_calls?: unknown[] | null;
  tool_results?: unknown[] | null;
  is_subagent?: boolean;
  children?: unknown[];
}): SpanKind {
  const outcome = row.outcome?.toLowerCase();
  if (outcome === "failure" || outcome === "error") return "error";
  if (row.is_subagent || (row.children?.length ?? 0) > 0) return "subagent";
  const eventType = row.event_type?.toLowerCase() ?? "";
  if (
    eventType.includes("tool") ||
    (row.tool_calls?.length ?? 0) > 0 ||
    (row.tool_results?.length ?? 0) > 0
  ) {
    return "tool";
  }
  if (
    row.request_body != null ||
    row.response_body != null ||
    eventType.includes("chat") ||
    eventType.includes("llm")
  ) {
    return "llm";
  }
  return "span";
}

export function spanKindColor(kind: SpanKind): string {
  switch (kind) {
    case "llm":
      return "var(--accent)";
    case "tool":
      return "var(--warning)";
    case "subagent":
      return "var(--info)";
    case "error":
      return "var(--error)";
    case "span":
    default:
      return "var(--text-muted)";
  }
}

export function spanKindLabel(kind: SpanKind): string {
  switch (kind) {
    case "llm":
      return "LLM";
    case "tool":
      return "Tool";
    case "subagent":
      return "Subagent";
    case "error":
      return "Error";
    case "span":
    default:
      return "Span";
  }
}
