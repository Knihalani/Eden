import type { TranscriptMessage, TranscriptRow } from "@/lib/observability/types";
import {
  buildFallbackTimelineSteps,
  type TimelineStep,
} from "@/lib/observability/timeline-sync";

type SpanNode = Record<string, unknown>;

const TOOL_PAYLOAD_PREVIEW = 1_200;

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Pull latency-adjacent token/cost fields from getTraceTree span nodes. */
export function extractSpanMetrics(node: SpanNode): {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
} {
  const metrics = asRecord(node.metrics);
  const payload = asRecord(node.payload);
  const attributes = asRecord(node.attributes);

  const input_tokens =
    numOrNull(metrics.input_tokens) ??
    numOrNull(metrics.prompt_tokens) ??
    numOrNull(payload.input_tokens) ??
    numOrNull(payload.prompt_tokens) ??
    numOrNull(node.input_tokens) ??
    null;

  const output_tokens =
    numOrNull(metrics.output_tokens) ??
    numOrNull(metrics.completion_tokens) ??
    numOrNull(payload.output_tokens) ??
    numOrNull(payload.completion_tokens) ??
    numOrNull(node.output_tokens) ??
    null;

  const cost_usd =
    numOrNull(metrics.cost_usd) ??
    numOrNull(payload.cost_usd) ??
    numOrNull(attributes.cost_usd) ??
    (numOrNull(node.cost_cents) != null
      ? (numOrNull(node.cost_cents) as number) / 100
      : null) ??
    numOrNull(node.cost_usd) ??
    null;

  return { input_tokens, output_tokens, cost_usd };
}

/**
 * Bottom-up: when a parent lacks tokens/cost, sum children that have them.
 * Nodes without any token/cost (self or descendants) stay null — duration only.
 */
export function rollupTreeMetrics(rows: TranscriptRow[]): TranscriptRow[] {
  return rows.map((row) => {
    const children = row.children?.length
      ? rollupTreeMetrics(row.children)
      : undefined;

    let input = row.input_tokens ?? null;
    let output = row.output_tokens ?? null;
    let cost = row.cost_usd ?? null;

    if (children?.length) {
      let childIn = 0;
      let childOut = 0;
      let childCost = 0;
      let anyIn = false;
      let anyOut = false;
      let anyCost = false;
      for (const c of children) {
        if (c.input_tokens != null) {
          childIn += c.input_tokens;
          anyIn = true;
        }
        if (c.output_tokens != null) {
          childOut += c.output_tokens;
          anyOut = true;
        }
        if (c.cost_usd != null) {
          childCost += c.cost_usd;
          anyCost = true;
        }
      }
      if (input == null && anyIn) input = childIn;
      if (output == null && anyOut) output = childOut;
      if (cost == null && anyCost) cost = childCost;
    }

    return {
      ...row,
      children,
      input_tokens: input,
      output_tokens: output,
      cost_usd: cost,
    };
  });
}

/**
 * Filter span tree by name / span_id / event_type.
 * Keeps ancestors of matches so the path to a hit stays visible.
 */
export function filterSpanTreeKeepingAncestors(
  nodes: TranscriptRow[],
  query: string,
): TranscriptRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;

  const walk = (list: TranscriptRow[]): TranscriptRow[] => {
    const out: TranscriptRow[] = [];
    for (const node of list) {
      const filteredKids = walk(node.children ?? []);
      const selfMatch =
        node.name.toLowerCase().includes(q) ||
        node.span_id.toLowerCase().includes(q) ||
        (node.event_type?.toLowerCase().includes(q) ?? false);
      if (selfMatch || filteredKids.length > 0) {
        out.push({
          ...node,
          children: filteredKids,
        });
      }
    }
    return out;
  };

  return walk(nodes);
}

function spanToRow(node: SpanNode, options: BuildTranscriptOptions): TranscriptRow {
  const payload = (node.payload as Record<string, unknown>) ?? {};
  const spanType = String(node.span_type ?? node.event_type ?? "system");
  const messages = (payload.messages ?? payload.input_messages) as
    | Array<Record<string, unknown>>
    | undefined;
  const lazy = Boolean(options.lazyToolPayloads);
  const metrics = extractSpanMetrics(node);

  const row: TranscriptRow = {
    span_id: String(node.span_id ?? ""),
    parent_span_id: (node.parent_span_id as string | null | undefined) ?? null,
    agent_id: (node.agent_id as string | null | undefined) ?? null,
    name: String(node.name ?? "unnamed"),
    event_type: spanType,
    timestamp: String(node.timestamp ?? node.started_at ?? new Date().toISOString()),
    duration_ms: Number(node.duration_ms ?? 0),
    outcome: (node.outcome as string | null | undefined) ?? null,
    input_tokens: metrics.input_tokens,
    output_tokens: metrics.output_tokens,
    cost_usd: metrics.cost_usd,
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
    // Never lazy-truncate the model response — that is the main thing
    // users open a trace to read. Tool args/results still preview.
    response_body: payload.response ?? payload.output ?? payload.content,
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

/** Hierarchical span tree for the Tree tab (preserves children + metric rollup). */
export function buildSpanTree(
  rootSpans: SpanNode[],
  options: BuildTranscriptOptions = {},
): TranscriptRow[] {
  return rollupTreeMetrics(rootSpans.map((node) => spanToRow(node, options)));
}

// ── Transcript view rows (RunTranscript row builder) ────────────────────────

/**
 * Minimal timing shape RunTranscript steps satisfy (`TranscriptStep` in
 * `@/lab/fixtures/traces`). Kept structural so this data layer does not
 * import from the lab layer.
 */
export interface TimedTranscriptStep {
  id: string;
  parentId?: string;
  kind?: string;
  startedAt?: string;
  durationMs: number;
}

export type TranscriptViewRow<S extends TimedTranscriptStep> =
  | { type: "step"; id: string; step: S }
  | { type: "parallel"; id: string; lanes: S[] };

/** Steps only group when their start time actually parses — no guessing. */
function parseStartMs(step: TimedTranscriptStep): number | null {
  if (!step.startedAt) return null;
  const t = Date.parse(step.startedAt);
  return Number.isFinite(t) ? t : null;
}

/**
 * Group consecutive same-parent tool steps whose time ranges overlap into a
 * single parallel row (fan-out lanes). Everything else passes through in
 * order, so traces without concurrency render exactly as before. Steps with
 * missing/unparseable timestamps are never grouped.
 */
export function groupParallelSteps<S extends TimedTranscriptStep>(
  steps: S[],
): TranscriptViewRow<S>[] {
  const rows: TranscriptViewRow<S>[] = [];
  let group: S[] = [];
  let groupEndMs = -Infinity;
  let groupParent: string | undefined;

  const flush = () => {
    if (group.length >= 2) {
      rows.push({ type: "parallel", id: `par:${group[0].id}`, lanes: group });
    } else {
      for (const s of group) rows.push({ type: "step", id: s.id, step: s });
    }
    group = [];
    groupEndMs = -Infinity;
    groupParent = undefined;
  };

  for (const step of steps) {
    const startMs = parseStartMs(step);
    const groupable = step.kind === "tool" && startMs != null;
    if (!groupable) {
      flush();
      rows.push({ type: "step", id: step.id, step });
      continue;
    }
    const endMs = startMs + Math.max(0, step.durationMs);
    const overlaps =
      group.length > 0 && step.parentId === groupParent && startMs < groupEndMs;
    if (!overlaps) flush();
    if (group.length === 0) groupParent = step.parentId;
    group.push(step);
    groupEndMs = Math.max(groupEndMs, endMs);
  }
  flush();
  return rows;
}

/**
 * Timeline geometry for a run's steps — reuses the Wave 4 timeline-sync
 * builder so a future Gantt view and the transcript agree on t0/offsets.
 */
export function transcriptTimeline(
  steps: TimedTranscriptStep[],
): TimelineStep[] {
  return buildFallbackTimelineSteps(
    steps
      .filter((s) => parseStartMs(s) != null)
      .map((s) => ({
        span_id: s.id,
        name: s.id,
        timestamp: s.startedAt as string,
        duration_ms: s.durationMs,
      })),
  );
}

// ── Lazy tool payload markers (F82) ─────────────────────────────────────────

export interface LazyPayloadMarker {
  preview: string;
  bytes: number;
}

function markerFrom(value: unknown): LazyPayloadMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj._lazy !== true) return null;
  return {
    preview: typeof obj.preview === "string" ? obj.preview : "",
    bytes: typeof obj.bytes === "number" ? obj.bytes : 0,
  };
}

/**
 * Detect an F82 `{_lazy, preview, bytes}` truncation marker inside a raw
 * preview string (the marker itself, or one nesting level down — e.g. a
 * tool call's `arguments`). Returns null for ordinary payloads.
 */
export function parseLazyPayloadMarker(
  raw: string | null | undefined,
): LazyPayloadMarker | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  if (!text.includes('"_lazy"')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const direct = markerFrom(parsed);
    if (direct) return direct;
    const scan = (value: unknown): LazyPayloadMarker | null => {
      if (Array.isArray(value)) {
        for (const item of value) {
          const hit = markerFrom(item) ?? scanRecord(item);
          if (hit) return hit;
        }
        return null;
      }
      return scanRecord(value);
    };
    const scanRecord = (value: unknown): LazyPayloadMarker | null => {
      if (!value || typeof value !== "object") return null;
      for (const v of Object.values(value as Record<string, unknown>)) {
        const hit = markerFrom(v);
        if (hit) return hit;
      }
      return null;
    };
    return scan(parsed);
  } catch {
    return null;
  }
}
