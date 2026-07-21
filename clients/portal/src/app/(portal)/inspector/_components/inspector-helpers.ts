import type { TranscriptMessage } from "@/components/observability/transcript-view";

export type Span = {
  span_id: string;
  parent_span_id?: string | null;
  name: string;
  span_type:
    | "llm_completion"
    | "tool_invocation"
    | "env_step"
    | "reasoning"
    | "user_interaction"
    | "system";
  duration_ms: number;
  start_offset_ms: number;
  payload: Record<string, unknown>;
};

export type Filter = "all" | "llm" | "tool" | "env" | "reasoning";
export type ViewMode = "tree" | "transcript";

export const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  llm: "Model",
  tool: "Tools",
  env: "Env",
  reasoning: "Reasoning",
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function depthOf(span: Span, all: Span[]): number {
  let d = 0;
  let parent = span.parent_span_id;
  while (parent) {
    d += 1;
    const p = all.find((s) => s.span_id === parent);
    if (!p) break;
    parent = p.parent_span_id;
  }
  return d;
}

export function orderSpansByParent(filteredSpans: Span[]): Span[] {
  const orderedSpans: Span[] = [];
  const byParent = new Map<string | null, Span[]>();
  for (const s of filteredSpans) {
    const key = s.parent_span_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(s);
  }
  const walk = (parent: string | null) => {
    const children = byParent.get(parent) ?? [];
    for (const c of children) {
      orderedSpans.push(c);
      walk(c.span_id);
    }
  };
  walk(null);
  return orderedSpans;
}

export function filterSpans(spans: Span[], filter: Filter): Span[] {
  return spans.filter((s) => {
    if (filter === "all") return true;
    if (filter === "llm") return s.span_type === "llm_completion";
    if (filter === "tool") return s.span_type === "tool_invocation";
    if (filter === "env") return s.span_type === "env_step";
    if (filter === "reasoning") return s.span_type === "reasoning";
    return true;
  });
}

export function spansToTranscriptMessages(spans: Span[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const span of spans) {
    const payload = span.payload ?? {};
    const messages = (payload.messages ?? payload.input_messages) as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(messages)) {
      for (const m of messages) {
        const roleRaw = String(m.role ?? "assistant");
        const role = (
          roleRaw === "system" ||
          roleRaw === "user" ||
          roleRaw === "assistant" ||
          roleRaw === "tool"
            ? roleRaw
            : "assistant"
        ) as TranscriptMessage["role"];
        out.push({
          id: `${span.span_id}-${out.length}`,
          role,
          content: String(m.content ?? ""),
        });
      }
    } else if (
      span.span_type === "llm_completion" ||
      span.span_type === "reasoning"
    ) {
      const content =
        (typeof payload.response === "string" && payload.response) ||
        (typeof payload.content === "string" && payload.content) ||
        (typeof payload.output === "string" && payload.output) ||
        JSON.stringify(payload).slice(0, 500);
      out.push({
        id: span.span_id,
        role: "assistant",
        content: content || span.name,
      });
    } else if (span.span_type === "tool_invocation") {
      out.push({
        id: span.span_id,
        role: "tool",
        content: JSON.stringify(payload, null, 2).slice(0, 2000),
      });
    } else if (span.span_type === "user_interaction") {
      out.push({
        id: span.span_id,
        role: "user",
        content: String(payload.content ?? payload.message ?? span.name),
      });
    }
  }
  return out;
}

export function flattenTraceTree(
  tree: { root_spans?: Array<Record<string, unknown>> } | null | undefined,
): Span[] {
  const flat: Span[] = [];
  const visit = (node: Record<string, unknown>) => {
    const children =
      (node.children as Array<Record<string, unknown>>) ?? [];
    for (const child of children) {
      flat.push({
        span_id: String(child.span_id ?? ""),
        parent_span_id:
          (child.parent_span_id as string | null | undefined) ?? null,
        name: String(child.name ?? "unnamed"),
        span_type: (child.span_type as Span["span_type"]) ?? "system",
        duration_ms: Number(child.duration_ms ?? 0),
        start_offset_ms: Number(child.start_offset_ms ?? 0),
        payload: (child.payload as Record<string, unknown>) ?? {},
      });
      visit(child);
    }
  };
  const roots = Array.isArray(tree?.root_spans) ? tree.root_spans : [];
  for (const root of roots) visit(root);
  return flat;
}
