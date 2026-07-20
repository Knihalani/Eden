import type { TranscriptMessage, TranscriptRow } from "@/lib/observability/types";

type SpanNode = Record<string, unknown>;

const TOOL_PAYLOAD_PREVIEW = 240;

export interface BuildTranscriptOptions {
  /** F82 — defer large tool bodies; show preview until expanded. */
  lazyToolPayloads?: boolean;
}

function truncateToolPayload(value: unknown, lazy: boolean): unknown {
  if (!lazy || value == null) return value;
  const text =
    typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= TOOL_PAYLOAD_PREVIEW) return value;
  return {
    _lazy: true,
    preview: `${text.slice(0, TOOL_PAYLOAD_PREVIEW)}…`,
    bytes: text.length,
  };
}

function spanToRow(node: SpanNode, options: BuildTranscriptOptions): TranscriptRow {
  const payload = (node.payload as Record<string, unknown>) ?? {};
  const spanType = String(node.span_type ?? node.event_type ?? "system");
  const messages = (payload.messages ?? payload.input_messages) as
    | Array<Record<string, unknown>>
    | undefined;
  const lazy = Boolean(options.lazyToolPayloads);

  const row: TranscriptRow = {
    span_id: String(node.span_id ?? ""),
    parent_span_id: (node.parent_span_id as string | null | undefined) ?? null,
    agent_id: (node.agent_id as string | null | undefined) ?? null,
    name: String(node.name ?? "unnamed"),
    event_type: spanType,
    timestamp: String(node.timestamp ?? node.started_at ?? new Date().toISOString()),
    duration_ms: Number(node.duration_ms ?? 0),
    outcome: (node.outcome as string | null | undefined) ?? null,
    request_body: (payload.request as TranscriptRow["request_body"]) ?? {
      model: (payload.model as string | undefined) ?? undefined,
      messages: Array.isArray(messages)
        ? messages.map((m) => {
            const roleRaw = String(m.role ?? "assistant");
            const role = (
              roleRaw === "system" ||
              roleRaw === "user" ||
              roleRaw === "assistant" ||
              roleRaw === "tool"
                ? roleRaw
                : "assistant"
            ) as TranscriptMessage["role"];
            return { role, content: String(m.content ?? "") };
          })
        : undefined,
    },
    response_body: truncateToolPayload(
      payload.response ?? payload.output ?? payload.content,
      lazy,
    ),
    tool_calls: Array.isArray(payload.tool_calls)
      ? (payload.tool_calls as TranscriptRow["tool_calls"])
      : spanType === "tool_invocation"
        ? [
            {
              type: "function",
              name: String(payload.tool_name ?? node.name ?? "tool"),
              arguments: truncateToolPayload(
                payload.arguments ?? payload.input,
                lazy,
              ),
            },
          ]
        : null,
    tool_results:
      spanType === "tool_result" || payload.tool_result
        ? [
            {
              tool_call_id: String(payload.tool_call_id ?? ""),
              content: truncateToolPayload(
                payload.result ?? payload.output ?? payload,
                lazy,
              ),
              is_error: Boolean(payload.is_error ?? payload.error),
            },
          ]
        : null,
    children: undefined,
  };

  const children = (node.children as SpanNode[] | undefined) ?? [];
  if (children.length > 0) {
    row.children = children.map((c) => spanToRow(c, options));
  }

  return row;
}

/** True when a span carries transcript-worthy payload (LLM/tool content). */
function nodeHasTranscriptContent(node: SpanNode): boolean {
  const payload = (node.payload as Record<string, unknown>) ?? {};
  if (payload.messages != null || payload.input_messages != null) return true;
  if (payload.response != null || payload.output != null || payload.content != null) {
    return true;
  }
  if (payload.request != null) return true;
  if (Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0) return true;
  if (payload.tool_result != null) return true;
  const spanType = String(node.span_type ?? node.event_type ?? "");
  if (
    spanType === "tool_invocation" ||
    spanType === "tool_result" ||
    spanType.includes("llm") ||
    spanType.includes("chat") ||
    spanType.includes("generation")
  ) {
    return true;
  }
  return false;
}

/** Build chronological TranscriptRow list from observability trace tree API. */
export function buildTranscriptRows(
  rootSpans: SpanNode[],
  options: BuildTranscriptOptions = {},
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const visit = (nodes: SpanNode[]) => {
    for (const node of nodes) {
      const childNodes = (node.children as SpanNode[] | undefined) ?? [];
      // Emit leaves always; also emit parents that carry LLM/tool content.
      if (childNodes.length === 0 || nodeHasTranscriptContent(node)) {
        const { children: _omit, ...flat } = node;
        rows.push(spanToRow(flat, options));
      }
      if (childNodes.length > 0) {
        visit(childNodes);
      }
    }
  };
  visit(rootSpans);
  rows.sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  return rows;
}
