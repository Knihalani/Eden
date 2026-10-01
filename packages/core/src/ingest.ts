/**
 * Observability-platform trace ingestion (cold-start elimination).
 *
 * Every production agent team already has weeks of tool-call history in
 * LangSmith, OpenTelemetry, LangFuse, or plain JSONL logs. That history is
 * exactly what Eden's compiler needs to mine repeated stretches — but it is
 * locked in a dozen different export formats.
 *
 * This module normalizes them into Eden's ToolEvent shape so the existing
 * compile pipeline consumes imported history identically to live recordings.
 *
 * Design rule: an adapter that cannot confidently map a record returns it as
 * skipped rather than guessing — a wrong guess would compile a stretch that
 * never happened.
 */

import type { ToolEvent } from "./types";

// ─── Generic JSONL ──────────────────────────────────────────────────────────

/**
 * The identity mapping: one JSON object per line with Eden-compatible fields.
 * Accepts partial records (missing result → ok:true with undefined result;
 * missing duration → no timing). Skips lines that lack a name.
 */
export function parseGenericJsonl(content: string): ToolEvent[] {
  const out: ToolEvent[] = [];
  const lines = content.split("\n").filter((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (typeof obj.name !== "string" || !obj.name) continue;
      out.push({
        event_id: typeof obj.event_id === "string" ? obj.event_id : `imp-${i}`,
        seq: typeof obj.seq === "number" ? obj.seq : i,
        name: obj.name,
        args: (obj.args && typeof obj.args === "object" ? obj.args : {}) as Record<string, unknown>,
        ...(obj.result !== undefined ? { result: obj.result } : {}),
        ok: obj.ok !== false,
        ...(typeof obj.duration_ms === "number" ? { duration_ms: obj.duration_ms } : {}),
        ...(typeof obj.command === "string" ? { command: obj.command } : {}),
      });
    } catch {
      // Malformed line: skip rather than fail the whole import.
    }
  }
  return out;
}

// ─── OpenTelemetry GenAI spans ──────────────────────────────────────────────

interface OTelSpan {
  traceId?: string;
  name?: string;
  attributes?: Record<string, unknown>;
  status?: { code?: string };
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  events?: Array<{ name?: string; attributes?: Record<string, unknown> }>;
}

/** Attribute keys that mark a span as a tool call (GenAI conventions + common extensions). */
const TOOL_NAME_ATTRS = [
  "gen_ai.tool.name",
  "tool.name",
  "tool_name",
  "mcp.tool.name",
  "function.name",
  "openinference.span.kind", // Phoenix: check value === "TOOL"
];

/** Argument attribute keys in priority order (research-confirmed GenAI names). */
const TOOL_ARGS_ATTRS = [
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.args",
  "tool.args",
  "tool_arguments",
  "function.arguments",
];

function findToolName(attrs: Record<string, unknown>): string | null {
  // Phoenix/OpenInference marks tool spans by kind, not by a name attr —
  // the actual tool name is the span's own `name` field.
  const kind = attrs["openinference.span.kind"];
  if (kind === "TOOL") return "__PHOENIX_USE_SPAN_NAME__";
  for (const key of TOOL_NAME_ATTRS) {
    if (key === "openinference.span.kind") continue;
    const v = attrs[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * Convert OTel spans (already flattened from OTLP JSON) into ToolEvents.
 * Spans are grouped by traceId to preserve sequence ordering within a run.
 * LLM-inference spans (no tool attribute) are skipped — they carry no tool-call
 * data for the compiler.
 */
export function parseOtelSpans(spans: OTelSpan[]): Map<string, ToolEvent[]> {
  const byTrace = new Map<string, OTelSpan[]>();
  for (const span of spans) {
    const tid = span.traceId ?? "unknown";
    const list = byTrace.get(tid);
    if (list) list.push(span);
    else byTrace.set(tid, [span]);
  }
  const out = new Map<string, ToolEvent[]>();
  for (const [tid, spansInTrace] of byTrace) {
    // Sort by start time to preserve execution order.
    const sorted = [...spansInTrace].sort(
      (a, b) => Number(a.startTimeUnixNano ?? 0) - Number(b.startTimeUnixNano ?? 0),
    );
    const events: ToolEvent[] = [];
    let seq = 0;
    for (const span of sorted) {
      const attrs =
        span.attributes && typeof span.attributes === "object" ? (span.attributes as Record<string, unknown>) : {};
      let toolName = findToolName(attrs);
      // Phoenix/OpenInference: the span's own name IS the tool name.
      if (toolName === "__PHOENIX_USE_SPAN_NAME__") toolName = span.name ?? null;
      if (!toolName) continue; // LLM inference span or non-tool span
      const argsRaw =
        attrs["gen_ai.tool.call.arguments"] ??
        attrs["gen_ai.tool.args"] ??
        attrs["tool.args"] ??
        attrs["tool_arguments"] ??
        attrs["function.arguments"] ??
        // Phoenix: input.value may hold JSON string or object
        (attrs.input && typeof attrs.input === "object" ? (attrs.input as any).value : undefined) ??
        {};
      let args: Record<string, unknown> = {};
      if (typeof argsRaw === "string") {
        try {
          args = JSON.parse(argsRaw);
        } catch {
          args = { raw: argsRaw };
        }
      } else if (argsRaw && typeof argsRaw === "object") {
        args = argsRaw as Record<string, unknown>;
      }
      const ok = span.status?.code !== "STATUS_CODE_ERROR" && span.status?.code !== "ERROR";
      const startNs = Number(span.startTimeUnixNano ?? 0);
      const endNs = Number(span.endTimeUnixNano ?? 0);
      const durMs = startNs && endNs ? Math.round((endNs - startNs) / 1e6) : undefined;
      events.push({
        event_id: `${tid}-${seq}`,
        seq: seq++,
        name: toolName,
        args,
        ok,
        ...(durMs !== undefined ? { duration_ms: durMs } : {}),
      });
    }
    if (events.length >= 2) out.set(tid, events);
  }
  return out;
}

// ─── LangSmith runs ────────────────────────────────────────────────────────

interface LangSmithRun {
  id?: string;
  run_type?: string;
  name?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string | null;
  start_time?: string;
  end_time?: string;
  parent_run_id?: string | null;
  trace_id?: string;
}

/**
 * Convert LangSmith API runs into ToolEvents. Only `run_type === "tool"`
 * entries are relevant; LLM/chat-model runs are skipped. Runs sharing a
 * `trace_id` belong to one workflow invocation.
 */
export function parseLangSmithRuns(runs: LangSmithRun[]): Map<string, ToolEvent[]> {
  const toolRuns = runs.filter((r) => r.run_type === "tool" && r.name);
  const byTrace = new Map<string, LangSmithRun[]>();
  for (const run of toolRuns) {
    const tid = run.trace_id ?? run.parent_run_id ?? "unknown";
    const list = byTrace.get(tid);
    if (list) list.push(run);
    else byTrace.set(tid, [run]);
  }
  const out = new Map<string, ToolEvent[]>();
  for (const [tid, runsInTrace] of byTrace) {
    const sorted = [...runsInTrace].sort(
      (a, b) => new Date(a.start_time ?? 0).getTime() - new Date(b.start_time ?? 0).getTime(),
    );
    const events: ToolEvent[] = [];
    for (let seq = 0; seq < sorted.length; seq++) {
      const run = sorted[seq]!;
      const ok = !run.error;
      const startMs = run.start_time ? new Date(run.start_time).getTime() : 0;
      const endMs = run.end_time ? new Date(run.end_time).getTime() : 0;
      const durMs = startMs && endMs ? endMs - startMs : undefined;
      events.push({
        event_id: String(run.id ?? `${tid}-s${seq}`),
        seq,
        name: run.name!,
        args: (run.inputs && typeof run.inputs === "object" ? run.inputs : {}) as Record<string, unknown>,
        ...(run.outputs !== undefined ? { result: run.outputs } : {}),
        ok,
        ...(durMs !== undefined ? { duration_ms: durMs } : {}),
      });
    }
    if (events.length >= 2) out.set(tid, events);
  }
  return out;
}

// ─── Langfuse observations ──────────────────────────────────────────────────

interface LangfuseObservation {
  type?: string; // "TOOL" | "LLM" | "SPAN" etc
  name?: string;
  input?: unknown;
  output?: unknown;
  level?: string;
  startTime?: string;
  endTime?: string;
  latency?: number;
  parentObservationId?: string | null;
  traceId?: string;
}

export function parseLangfuseObservations(observations: LangfuseObservation[]): Map<string, ToolEvent[]> {
  const toolObs = observations.filter((o) => o.type === "TOOL" && o.name);
  const byTrace = new Map<string, LangfuseObservation[]>();
  for (const obs of toolObs) {
    const tid = obs.traceId ?? "unknown";
    const list = byTrace.get(tid);
    if (list) list.push(obs);
    else byTrace.set(tid, [obs]);
  }
  const out = new Map<string, ToolEvent[]>();
  for (const [tid, obsList] of byTrace) {
    const sorted = [...obsList].sort(
      (a, b) => new Date(a.startTime ?? 0).getTime() - new Date(b.startTime ?? 0).getTime(),
    );
    const events: ToolEvent[] = [];
    for (let seq = 0; seq < sorted.length; seq++) {
      const obs = sorted[seq]!;
      events.push({
        event_id: `${tid}-${seq}`,
        seq,
        name: obs.name!,
        args: (obs.input && typeof obs.input === "object" ? obs.input : {}) as Record<string, unknown>,
        ...(obs.output !== undefined ? { result: obs.output } : {}),
        ok: obs.level !== "ERROR",
        ...(typeof obs.latency === "number" ? { duration_ms: Math.round(obs.latency * 1000) } : {}),
      });
    }
    if (events.length >= 2) out.set(tid, events);
  }
  return out;
}

// ─── OpenAI chat completions (raw API logs) ────────────────────────────────

interface OpenAIMessage {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAICompletionLog {
  choices?: Array<{ message?: OpenAIMessage; finish_reason?: string }>;
  /** Optional export metadata. When present, conversations are kept apart so
   * the compiler sees N traces (its repetition gate needs ≥3) instead of one
   * fabricated cross-conversation super-sequence. */
  conversation_id?: string;
  session_id?: string;
  thread_id?: string;
}

/**
 * Extract tool-call sequences from raw OpenAI chat-completion logs.
 *
 * Each completion may contain `tool_calls` (requests) and the NEXT completion's
 * input contains `role:"tool"` messages (results). This function pairs requests
 * with their results by tool_call_id across a sequence of completion logs.
 *
 * Returns one event per completed call (request + result paired). Calls without
 * a matching result are skipped — they are incomplete and would mislead mining.
 */
export function parseOpenAIToolCalls(logs: OpenAICompletionLog[]): Map<string, ToolEvent[]> {
  // Pairing is identical either way; only the trace partition differs.
  const convoOf = (log: OpenAICompletionLog): string => log.conversation_id ?? log.session_id ?? log.thread_id ?? "";

  const hasConvoIds = logs.some((l) => convoOf(l) !== "");
  const partitions = new Map<string, OpenAICompletionLog[]>();
  if (hasConvoIds) {
    for (const log of logs) {
      const key = convoOf(log) || `unkeyed-${partitions.size}`;
      const list = partitions.get(key);
      if (list) list.push(log);
      else partitions.set(key, [log]);
    }
  } else {
    partitions.set("openai-sequence", logs); // legacy single-trace behavior
  }

  const out = new Map<string, ToolEvent[]>();
  for (const [key, partLogs] of partitions) {
    // Pass 1: collect all tool_call requests and all tool results.
    interface Pending {
      name: string;
      args: Record<string, unknown>;
      logIdx: number;
    }
    interface Result {
      output: unknown;
      isError: boolean;
    }
    const pending = new Map<string, Pending>();
    const results = new Map<string, Result>();
    for (const log of partLogs) {
      for (const choice of log.choices ?? []) {
        const msg = choice.message;
        if (!msg) continue;
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (!tc.id || !tc.function?.name) continue;
            let parsedArgs: Record<string, unknown> = {};
            try {
              const p = JSON.parse(tc.function.arguments ?? "{}");
              if (p && typeof p === "object") parsedArgs = p;
            } catch {
              parsedArgs = { raw: tc.function.arguments };
            }
            pending.set(tc.id, { name: tc.function.name, args: parsedArgs, logIdx: 0 });
          }
        }
        if (msg.role === "tool" && msg.tool_call_id) {
          let output: unknown = msg.content;
          try {
            const p = JSON.parse(msg.content ?? "");
            if (p !== null && typeof p === "object") output = p;
          } catch {
            /* keep as string */
          }
          results.set(msg.tool_call_id, { output, isError: false });
        }
      }
    }
    // Pass 2: pair requests with results.
    const paired: Array<{ name: string; args: Record<string, unknown>; result: unknown }> = [];
    for (const [id, req] of pending) {
      const res = results.get(id);
      if (!res) continue; // incomplete call — no result came back
      paired.push({ name: req.name, args: req.args, result: res.output });
    }
    if (paired.length < 2) continue;
    const events: ToolEvent[] = paired.map((p, i) => ({
      event_id: `openai-${i}`,
      seq: i,
      name: p.name,
      args: p.args,
      result: p.result,
      ok: true,
    }));
    out.set(key === "openai-sequence" ? key : `openai-${key.slice(0, 24)}`, events);
  }
  return out;
}

/**
 * Auto-detect routing for raw OpenAI chat-completion logs: a JSON array of
 * objects that carry `choices` arrays. Unreachable before, so OpenAI-shop
 * exports fell through to "Unrecognized format" despite the adapter existing.
 */
export function looksLikeOpenAILogs(parsed: unknown): parsed is OpenAICompletionLog[] {
  return (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every(
      (entry) => entry !== null && typeof entry === "object" && Array.isArray((entry as OpenAICompletionLog).choices),
    )
  );
}

// ─── Auto-detection ─────────────────────────────────────────────────────────

/**
 * Sniff a JSON payload and route to the right adapter. Returns null for
 * unrecognized formats — callers should report the error rather than
 * silently importing garbage.
 */
export function detectAndParse(content: string): { format: string; traces: Map<string, ToolEvent[]> } | null {
  const trimmed = content.trim();

  // Generic JSONL: one object per line with a `name` field.
  if (trimmed.startsWith("{")) {
    const firstLine = trimmed.split("\n")[0]?.trim() ?? "";
    try {
      const first = JSON.parse(firstLine) as Record<string, unknown>;
      // OTLP: array of resourceSpans or top-level `resourceSpans`
      if (Array.isArray(first.resourceSpans) || first.scopeSpans) {
        return { format: "otlp", traces: new Map() }; // full OTLP needs flattening upstream
      }
      // LangSmith: has run_type field
      if (typeof first.run_type === "string") {
        // Line-level tolerance: one malformed line used to throw out of this
        // map, hit the outer catch, and reject an otherwise-valid export as
        // "Unrecognized format". Skip bad lines instead.
        const parsed: LangSmithRun[] = [];
        let skipped = 0;
        for (const line of trimmed.split("\n")) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            if (obj && typeof obj === "object") parsed.push(obj as LangSmithRun);
          } catch {
            skipped++;
          }
        }
        if (!parsed.length) return null;
        if (skipped > 0) console.error(`[eden import] skipped ${skipped} malformed line(s)`);
        return { format: "langsmith", traces: parseLangSmithRuns(parsed) };
      }
      // Generic JSONL
      const events = parseGenericJsonl(trimmed);
      if (events.length) {
        return { format: "generic_jsonl", traces: new Map([["batch", events]]) };
      }
    } catch {
      /* fall through */
    }
  }

  // OTel: JSON array of spans
  try {
    const arr = JSON.parse(trimmed) as unknown[];
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0] as Record<string, unknown>;
      if ((typeof first.traceId === "string" || typeof first.spanId === "string") && typeof first.name === "string") {
        const parsed = parseOtelSpans(arr as OTelSpan[]);
        return { format: "otel_spans", traces: parsed };
      }
      // Raw OpenAI chat-completion logs (array of {choices}). Routed here so
      // OpenAI-shop exports stop falling through to "Unrecognized format".
      if (looksLikeOpenAILogs(arr)) {
        return { format: "openai_logs", traces: parseOpenAIToolCalls(arr) };
      }
      // LangSmith array
      if (typeof first.run_type === "string") {
        const parsed = parseLangSmithRuns(arr as LangSmithRun[]);
        return { format: "langsmith", traces: parsed };
      }
    }
  } catch {
    /* fall through */
  }

  return null;
}
