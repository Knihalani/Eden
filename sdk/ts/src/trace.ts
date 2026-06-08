/**
 * Eden TypeScript SDK — production observability decorator.
 *
 * Phase 6.5.2: mirrors the Python ``@trace_agent`` decorator and
 * the Python ``auto_instrument`` monkey-patch. Wraps a function so
 * every call is reported to Eden's telemetry pipeline.
 *
 * Usage:
 * ```ts
 * import { traceAgent, autoInstrument } from "@eden/sdk/trace";
 *
 * @traceAgent({ tags: ["production"] })
 * async function myAgent(query: string) {
 *   // ...
 * }
 *
 * // Or auto-instrument common LLM SDKs
 * autoInstrument({ tags: ["production"] });
 * ```
 */

import { randomUUID } from "crypto";

export interface TraceOptions {
  environmentId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  startMs: number;
}

let _collectorUrl: string | undefined;
let _tenantId: string | undefined;
let _installedInstrumentations = new Set<string>();

/** Configure the default collector URL and tenant. Call once at startup. */
export function configureTracing(opts: {
  collectorUrl: string;
  tenantId: string;
}): void {
  _collectorUrl = opts.collectorUrl;
  _tenantId = opts.tenantId;
}

async function _emit(event: Record<string, unknown>): Promise<void> {
  if (!_collectorUrl || !_tenantId) return; // silently no-op until configured
  try {
    await fetch(`${_collectorUrl}/telemetry/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tenant-Id": _tenantId,
      },
      body: JSON.stringify(event),
    });
  } catch {
    // Tracing must never break the user's call
  }
}

/**
 * Method decorator that traces a function. Captures timing,
 * arguments (sanitised), return value shape, and exceptions.
 */
export function traceAgent(options: TraceOptions = {}) {
  return function <T extends (...args: any[]) => any>(
    _target: any,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<T>,
  ): TypedPropertyDescriptor<T> {
    const original = descriptor.value!;
    const wrapped = function (this: any, ...args: any[]) {
      const traceId = randomUUID();
      const start = Date.now();
      let status: "success" | "error" = "success";
      let errorType: string | undefined;
      let result: unknown;
      try {
        result = original.apply(this, args);
        if (result instanceof Promise) {
          return result
            .catch((err) => {
              status = "error";
              errorType = err?.constructor?.name ?? "Error";
              throw err;
            })
            .finally(() => {
              void _emit({
                event_id: traceId,
                event_type: "agent_call",
                realm: "PRODUCTION",
                source_format: "eden-trace-agent-ts",
                timestamp_ms: Date.now(),
                payload: {
                  function: propertyKey,
                  duration_ms: Date.now() - start,
                  status,
                  error_type: errorType,
                  arg_count: args.length,
                  environment_id: options.environmentId,
                },
                tags: options.tags ?? [],
                metadata: options.metadata ?? {},
              });
            });
        }
        return result;
      } catch (err: any) {
        status = "error";
        errorType = err?.constructor?.name ?? "Error";
        throw err;
      } finally {
        if (!(result instanceof Promise)) {
          void _emit({
            event_id: traceId,
            event_type: "agent_call",
            realm: "PRODUCTION",
            source_format: "eden-trace-agent-ts",
            timestamp_ms: Date.now(),
            payload: {
              function: propertyKey,
              duration_ms: Date.now() - start,
              status,
              error_type: errorType,
              arg_count: args.length,
              environment_id: options.environmentId,
            },
            tags: options.tags ?? [],
            metadata: options.metadata ?? {},
          });
        }
      }
    };
    descriptor.value = wrapped as T;
    return descriptor;
  };
}

/**
 * Auto-patch common LLM SDKs at runtime.
 *
 * Currently supported:
 *   - openai    (patches `chat.completions.create`)
 *   - anthropic (patches `messages.create`)
 *
 * Idempotent: calling twice is a no-op for any given target.
 */
export function autoInstrument(opts: TraceOptions = {}): {
  openai: boolean;
  anthropic: boolean;
} {
  const result = { openai: false, anthropic: false };
  if (!_installedInstrumentations.has("openai")) {
    result.openai = _tryInstrumentOpenAI(opts);
    if (result.openai) _installedInstrumentations.add("openai");
  } else {
    result.openai = true;
  }
  if (!_installedInstrumentations.has("anthropic")) {
    result.anthropic = _tryInstrumentAnthropic(opts);
    if (result.anthropic) _installedInstrumentations.add("anthropic");
  } else {
    result.anthropic = true;
  }
  return result;
}

function _tryInstrumentOpenAI(opts: TraceOptions): boolean {
  try {
    // Avoid hard import — openai may not be installed
    const mod: any = require("openai");
    const OpenAI = mod.OpenAI ?? mod.default?.OpenAI;
    if (!OpenAI) return false;
    const original = OpenAI.prototype.chat?.completions?.create;
    if (!original) return false;
    OpenAI.prototype.chat.completions.create = function (...args: any[]) {
      const isStream = !!(args[1]?.stream ?? args[0]?.stream);
      if (isStream) {
        return _wrapOpenAIStream(original, this, args, opts);
      }
      const start = Date.now();
      const traceId = randomUUID();
      const status = { ok: true as boolean, errorType: undefined as string | undefined };
      return Promise.resolve()
        .then(() => original.apply(this, args))
        .catch((err: any) => {
          status.ok = false;
          status.errorType = err?.constructor?.name ?? "Error";
          throw err;
        })
        .finally(() => {
          void _emit({
            event_id: traceId,
            event_type: "llm_completion",
            realm: "PRODUCTION",
            source_format: "eden-auto-instrument-ts",
            timestamp_ms: Date.now(),
            payload: {
              provider: "openai",
              duration_ms: Date.now() - start,
              status: status.ok ? "success" : "error",
              error_type: status.errorType,
            },
            tags: [...(opts.tags ?? []), "auto_instrument"],
          });
        });
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap an OpenAI ``stream: true`` response so the caller still
 * iterates as normal, but we sample per-chunk timing and emit one
 * ``llm_completion_stream`` event after the iterator exhausts.
 *
 * Mirrors the Python ``_wrap_openai_stream`` in
 * ``src/eden/sdk/trace.py``. Output-token count is estimated from
 * chunk content deltas; the SDK's reported usage (when present) wins.
 */
async function* _wrapOpenAIStream(
  original: (...args: any[]) => any,
  self: any,
  args: any[],
  opts: TraceOptions,
): AsyncIterable<any> {
  const start = Date.now();
  const traceId = randomUUID();
  let tFirst: number | null = null;
  let tPrev: number | null = null;
  let tLast = start;
  let itlSumMs = 0;
  let itlCount = 0;
  let outputTokens = 0;
  let usageOutputTokens: number | undefined;
  let finishReason: string | undefined;
  let chunkCount = 0;
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  let model: string | undefined;
  const tags = [...(opts.tags ?? []), "auto_instrument", "streaming"];

  try {
    const upstream = await original.apply(self, args);
    for await (const chunk of upstream) {
      chunkCount += 1;
      const now = Date.now();
      tLast = now;
      if (tFirst === null) tFirst = now;
      else if (tPrev !== null) {
        itlSumMs += now - tPrev;
        itlCount += 1;
      }
      tPrev = now;

      const choice = chunk?.choices?.[0];
      const text: string | undefined = choice?.delta?.content;
      if (text) outputTokens += Math.max(1, Math.floor(text.length / 4));
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk?.model) model = chunk.model;
      const usage = chunk?.usage;
      if (usage && typeof usage.completion_tokens === "number" && usage.completion_tokens > 0) {
        usageOutputTokens = usage.completion_tokens;
      }
      yield chunk;
    }
  } catch (err: any) {
    status = "error";
    errorType = err?.constructor?.name ?? "Error";
    throw err;
  } finally {
    if (typeof usageOutputTokens === "number") outputTokens = usageOutputTokens;
    const ttftMs = tFirst !== null ? tFirst - start : 0;
    const completionDurationMs = tLast - start;
    const itlMsAvg = itlCount > 0 ? itlSumMs / itlCount : 0;
    const tpotMs = outputTokens > 1 ? (completionDurationMs - ttftMs) / (outputTokens - 1) : 0;
    void _emit({
      event_id: traceId,
      event_type: "llm_completion_stream",
      realm: "PRODUCTION",
      source_format: "eden-auto-instrument-ts",
      timestamp_ms: Date.now(),
      payload: {
        provider: "openai",
        model,
        duration_ms: completionDurationMs,
        status,
        error_type: errorType,
        chunk_count: chunkCount,
        finish_reason: finishReason,
      },
      metrics: {
        ttft_ms: ttftMs,
        itl_ms_avg: itlMsAvg,
        tpot_ms: tpotMs,
        completion_duration_ms: completionDurationMs,
        output_tokens: outputTokens,
      },
      tags,
    });
  }
}

function _tryInstrumentAnthropic(opts: TraceOptions): boolean {
  try {
    const mod: any = require("@anthropic-ai/sdk");
    const Anthropic = mod.Anthropic ?? mod.default?.Anthropic;
    if (!Anthropic) return false;
    const original = Anthropic.prototype.messages?.create;
    if (!original) return false;
    Anthropic.prototype.messages.create = function (...args: any[]) {
      const start = Date.now();
      const traceId = randomUUID();
      const status = { ok: true as boolean, errorType: undefined as string | undefined };
      return Promise.resolve()
        .then(() => original.apply(this, args))
        .catch((err: any) => {
          status.ok = false;
          status.errorType = err?.constructor?.name ?? "Error";
          throw err;
        })
        .finally(() => {
          void _emit({
            event_id: traceId,
            event_type: "llm_completion",
            realm: "PRODUCTION",
            source_format: "eden-auto-instrument-ts",
            timestamp_ms: Date.now(),
            payload: {
              provider: "anthropic",
              duration_ms: Date.now() - start,
              status: status.ok ? "success" : "error",
              error_type: status.errorType,
            },
            tags: [...(opts.tags ?? []), "auto_instrument"],
          });
        });
    };
    return true;
  } catch {
    return false;
  }
}
