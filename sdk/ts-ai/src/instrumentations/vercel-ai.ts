/**
 * Vercel AI SDK auto-instrumentation.
 *
 * The Vercel AI SDK (npm: `ai`) exposes top-level helpers
 * `generateText`, `streamText`, `generateObject`, and
 * `streamObject`. Each accepts a `model` (or `experimental_*`
 * variant) and a `messages`/`prompt` payload.
 *
 * `wrapVercelAI(mod, opts)` accepts the imported `ai` namespace
 * (or a re-exported object containing those helpers) and returns
 * a Proxy that wraps each helper. `streamText` / `streamObject`
 * are tracked as streaming calls; the rest as standard
 * `llm_completion` events.
 *
 * The wrapper is dependency-free: the user passes the `ai`
 * module so the SDK doesn't take a hard import on it.
 */

import { getDefaultClient } from "../client.js";
import {
  SOURCE_FORMATS,
  type StreamChunk,
  type TraceOptions,
} from "../types.js";

type AnyModule = Record<string, unknown>;

const _wrapped = new WeakSet<object>();

const STREAMING_HELPERS = new Set(["streamText", "streamObject"]);

/**
 * Wrap the Vercel AI SDK module. Pass the result of
 * `import * as ai from "ai"` as `mod`.
 */
export function wrapVercelAI<T extends AnyModule>(
  mod: T,
  opts: TraceOptions = {},
): T {
  if (!mod || typeof mod !== "object") return mod;
  if (_wrapped.has(mod)) return mod;
  _wrapped.add(mod);

  return new Proxy(mod, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof value === "function" &&
        typeof prop === "string" &&
        _isVercelHelper(prop)
      ) {
        return _wrapHelper(value as (...a: any[]) => any, prop, opts);
      }
      return value;
    },
  });
}

function _isVercelHelper(name: string): boolean {
  return (
    STREAMING_HELPERS.has(name) ||
    name === "generateText" ||
    name === "generateObject" ||
    name === "streamUI"
  );
}

function _wrapHelper(
  original: (...args: any[]) => any,
  name: string,
  opts: TraceOptions,
): (...args: any[]) => any {
  if (STREAMING_HELPERS.has(name) || name === "streamUI") {
    return function (this: unknown, ...args: any[]) {
      const ctx = _beginCall(name, args, opts);
      let result: unknown;
      try {
        result = original.apply(this, args);
      } catch (err) {
        _finishCall(ctx, { status: "error", errorType: err });
        throw err;
      }
      // If the call returned a Promise, await it before
      // attaching the consumer.
      if (result instanceof Promise) {
        return result.then(
          (r: unknown) => {
            _wrapVercelStream(r, ctx);
            return r;
          },
          (err: unknown) => {
            _finishCall(ctx, { status: "error", errorType: err });
            throw err;
          },
        );
      }
      _wrapVercelStream(result, ctx);
      return result;
    };
  }
  return function (this: unknown, ...args: any[]) {
    const ctx = _beginCall(name, args, opts);
    try {
      const result = original.apply(this, args);
      if (result instanceof Promise) {
        return result
          .catch((err: unknown) => {
            _finishCall(ctx, { status: "error", errorType: err });
            throw err;
          })
          .then((value: unknown) => {
            _finishCall(ctx, { status: "success" });
            return value;
          });
      }
      _finishCall(ctx, { status: "success" });
      return result;
    } catch (err) {
      _finishCall(ctx, { status: "error", errorType: err });
      throw err;
    }
  };
}

interface _CallCtx {
  traceId: string;
  eventId: string;
  helper: string;
  model: string | undefined;
  start: number;
  opts: TraceOptions;
  chunkCount: number;
  tFirst: number | null;
  tPrev: number | null;
  tLast: number;
  outputTokens: number;
  status: "success" | "error";
  errorType: string | undefined;
  finishReason: string | undefined;
  /**
   * Per-chunk buffer of ``StreamChunk`` events. Flushed to
   * ``/ingest/chunks`` on stream completion so the per-chunk
   * TTFT / ITL / TPOT dashboards render for Vercel AI streams
   * too — previously only the aggregate event was emitted and
   * the per-chunk dashboards were always empty for the
   * Vercel AI source format.
   */
  chunkBuffer: StreamChunk[];
}

function _beginCall(
  helper: string,
  args: any[],
  opts: TraceOptions,
): _CallCtx {
  const traceId = randomId();
  return {
    traceId,
    eventId: `stream_vercel_ai_${traceId}`,
    helper,
    model: _extractModel(args),
    start: Date.now(),
    opts,
    chunkCount: 0,
    tFirst: null,
    tPrev: null,
    tLast: Date.now(),
    outputTokens: 0,
    status: "success",
    errorType: undefined,
    finishReason: undefined,
    chunkBuffer: [],
  };
}

function _extractModel(args: any[]): string | undefined {
  for (const a of args) {
    if (!a || typeof a !== "object") continue;
    const obj = a as Record<string, unknown>;
    if (typeof obj.model === "string") return obj.model;
    if (obj.model && typeof (obj.model as { modelId?: string }).modelId === "string") {
      return (obj.model as { modelId: string }).modelId;
    }
  }
  return undefined;
}

/**
 * Wrap the value returned by `streamText`/`streamObject`. The
 * Vercel AI SDK returns an object with an async iterable
 * `textStream` (or `fullStream`); we attach a no-op consumer
 * that samples timing and emit one event on completion.
 */
function _wrapVercelStream(result: unknown, ctx: _CallCtx): unknown {
  if (!result || typeof result !== "object") return result;
  const stream = result as Record<string, any>;

  // Try to attach a hidden consumer that drains the stream and
  // records per-chunk timing. The user still gets back the
  // original object so their iteration is unchanged. Every
  // chunk is also pushed to ``ctx.chunkBuffer`` so the
  // ``/ingest/chunks`` endpoint sees the same per-chunk TTFT /
  // ITL / TPOT data the OpenAI and Anthropic streaming
  // instrumentations already produce. Without this, the
  // per-chunk dashboards rendered empty for every Vercel AI
  // stream — only the aggregate event was emitted.
  const fullStream = stream.fullStream ?? stream.textStream;
  if (fullStream && typeof fullStream[Symbol.asyncIterator] === "function") {
    const client = getDefaultClient();
    const consumer = (async () => {
      try {
        for await (const chunk of fullStream) {
          ctx.chunkCount += 1;
          const now = Date.now();
          // Capture the interval to the previous chunk BEFORE
          // updating ``tPrev`` — otherwise the per-chunk ITL /
          // TPOT readings collapse to 0 for chunks that share
          // a tick. Mirrors the OpenAI + Anthropic streaming
          // paths so Vercel AI's per-chunk metrics use the
          // exact same arithmetic.
          const prev = ctx.tPrev;
          ctx.tLast = now;
          if (ctx.tFirst === null) ctx.tFirst = now;
          else if (prev !== null) {
            // itl sum/avg computed in finish
          }
          ctx.tPrev = now;
          const text = _extractTextFromVercelChunk(chunk);
          if (text) ctx.outputTokens += Math.max(1, Math.floor(text.length / 4));
          // Per-chunk TPOT (time per output token) is the
          // time spent generating THIS chunk's tokens
          // divided by the token count for this chunk
          // (approximated as ``ceil(len/4)`` to match the
          // aggregate ``output_tokens`` heuristic). Chunks
          // with no text (finish_reason / usage chunks)
          // emit ``null`` rather than a misleading zero.
          const tpotMs =
            text && text.length > 0 && prev !== null && now > prev
              ? (now - prev) / Math.max(1, Math.ceil(text.length / 4))
              : null;
          ctx.chunkBuffer.push({
            eventId: ctx.eventId,
            traceId: ctx.traceId,
            chunkIndex: ctx.chunkCount - 1,
            deltaText: text ?? null,
            ttftMs: ctx.tFirst !== null ? ctx.tFirst - ctx.start : null,
            itlMs: prev !== null ? now - prev : null,
            tpotMs,
            receivedAtClientMs: Date.now(),
          });
        }
        _finishCall(ctx, { status: "success" });
      } catch (err) {
        _finishCall(ctx, { status: "error", errorType: err });
      } finally {
        // Per-chunk replay — mirrors the OpenAI + Anthropic
        // streaming paths so ``/ingest/chunks`` receives the
        // full per-chunk series for Vercel AI streams.
        for (const c of ctx.chunkBuffer) client.bufferChunk(c);
      }
    })();
    // Best-effort: keep the consumer alive; unhandled rejection
    // is silenced because we already record the error.
    consumer.catch(() => undefined);
  }
  return result;
}

function _extractTextFromVercelChunk(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== "object") return undefined;
  const c = chunk as Record<string, unknown>;
  if (c.type === "text-delta" && typeof c.textDelta === "string") {
    return c.textDelta;
  }
  if (typeof c.text === "string") return c.text;
  if (typeof c.delta === "string") return c.delta;
  return undefined;
}

function _finishCall(
  ctx: _CallCtx,
  outcome: { status: "success" | "error"; errorType?: unknown },
): void {
  const durationMs = Date.now() - ctx.start;
  const client = getDefaultClient();
  const config = client.getConfig();
  const isStream = STREAMING_HELPERS.has(ctx.helper) || ctx.helper === "streamUI";
  const eventType = isStream ? "llm_completion_stream" : "llm_completion";
  const ttftMs = ctx.tFirst !== null ? ctx.tFirst - ctx.start : 0;
  const completionDurationMs = ctx.tLast - ctx.start;
  const itlCount = Math.max(0, ctx.chunkCount - 1);
  const itlMsAvg =
    itlCount > 0 && ctx.tPrev !== null
      ? (ctx.tLast - (ctx.tFirst ?? ctx.start)) / itlCount
      : 0;
  const tpotMs =
    ctx.outputTokens > 1
      ? (completionDurationMs - ttftMs) / (ctx.outputTokens - 1)
      : 0;

  client.emit({
    eventId: ctx.traceId,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    traceId: ctx.traceId,
    realm: config.realm,
    eventType,
    timestamp: new Date().toISOString(),
    sourceFormat: SOURCE_FORMATS.VERCEL_AI,
    payload: {
      provider: "vercel-ai",
      helper: ctx.helper,
      model: ctx.model,
      status: outcome.status,
      error_type:
        outcome.errorType instanceof Error
          ? outcome.errorType.constructor.name
          : undefined,
      chunk_count: isStream ? ctx.chunkCount : undefined,
      finish_reason: ctx.finishReason,
      environment_id: ctx.opts.environmentId,
    },
    metrics: isStream
      ? {
          ttft_ms: ttftMs,
          itl_ms_avg: itlMsAvg,
          tpot_ms: tpotMs,
          completion_duration_ms: completionDurationMs,
          output_tokens: ctx.outputTokens,
        }
      : { duration_ms: durationMs },
    tags: [
      ...(ctx.opts.tags ?? []),
      "auto_instrument",
      ...(isStream ? ["streaming"] : []),
    ],
    environmentId: ctx.opts.environmentId,
    durationMs,
  });
}

function randomId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}${rand}`.slice(0, 24);
}
