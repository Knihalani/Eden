/**
 * LlamaIndex.TS auto-instrumentation.
 *
 * `wrapLlamaIndex(engine, opts)` wraps a LlamaIndex.TS query engine,
 * chat engine, or retriever — anything returned by
 * `index.asQueryEngine()` / `index.asChatEngine()` / `index.asRetriever()`
 * — so each `query` / `chat` / `retrieve` call emits one `agent.run`
 * event with `sourceFormat: "llamaindex"`.
 *
 * Streaming responses (`{ stream: true }`) resolve to an
 * `AsyncIterable` of response chunks; we detect that shape on the
 * resolved value (rather than trusting the call args) and wrap the
 * iterable so per-chunk timing is buffered to `/ingest/chunks`
 * (parity with the OpenAI / Anthropic / LangChain streaming paths),
 * emitting the aggregate `agent.run` event once the stream is
 * exhausted (or the caller breaks out early).
 *
 * Mirrors the Python SDK's `_instrument_llama_index`, which
 * registers a `BaseSpanHandler` on `Settings.callback_manager` and
 * reports every span enter/exit as an `agent.run` event (duration +
 * outcome + span metadata). LlamaIndex.TS has no equivalent public
 * span-handler API, so this instruments at the query/chat/retrieve
 * call boundary instead — the observable behaviour is the same (one
 * event per logical call with duration, outcome, and framework
 * metadata) — applied the way the rest of this SDK wraps
 * framework client instances (see `mastra.ts` / `langchain.ts`).
 */

import { getDefaultClient } from "../client.js";
import { errorClass, errorMessage, randomId, traceIdOrRandom } from "../ids.js";
import type { StreamChunk, TraceOptions } from "../types.js";

// original → proxy (and proxy → proxy) so re-wrapping the same
// engine returns the instrumented Proxy, not the bare original.
const _proxies = new WeakMap<object, object>();
const WRAP_MARKER = Symbol.for("@eden-ai/sdk.wrapLlamaIndex");

const METHODS_TO_WRAP = ["query", "chat", "retrieve"] as const;
type MethodName = (typeof METHODS_TO_WRAP)[number];

/**
 * Wrap a LlamaIndex.TS query engine, chat engine, or retriever.
 * Idempotent: calling twice on the same instance is a no-op.
 */
export function wrapLlamaIndex<T extends object>(
  engine: T,
  opts: TraceOptions = {},
): T {
  if (!engine || typeof engine !== "object") return engine;
  const existing = _proxies.get(engine);
  if (existing) return existing as T;
  const marked = (engine as unknown as { [k: symbol]: unknown })[WRAP_MARKER];
  if (marked === true) return engine;

  const proxy = new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === WRAP_MARKER) return true;
      if (
        typeof prop === "string" &&
        (METHODS_TO_WRAP as readonly string[]).includes(prop)
      ) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function") return original;
        return _wrapMethod(
          original as (...a: any[]) => any,
          prop as MethodName,
          opts,
        );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  try {
    (proxy as unknown as { [k: symbol]: unknown })[WRAP_MARKER] = true;
  } catch {
    // ignore
  }
  _proxies.set(engine, proxy);
  _proxies.set(proxy, proxy);
  return proxy;
}

function _wrapMethod(
  original: (...args: any[]) => any,
  method: MethodName,
  opts: TraceOptions,
): (...args: any[]) => any {
  return function (this: unknown, ...args: any[]) {
    const start = Date.now();
    // Joins an active outer ``trace()``/``traceAgent()`` span when
    // one is running, falling back to a fresh random id otherwise.
    const traceId = traceIdOrRandom();
    const eventId = `eden_llamaindex_${randomId()}`;

    const onSettled = (result: unknown): unknown => {
      if (
        result &&
        typeof result === "object" &&
        Symbol.asyncIterator in (result as object)
      ) {
        return _wrapStream(result as AsyncIterable<unknown>, {
          method,
          start,
          traceId,
          eventId,
          opts,
        });
      }
      _emit({
        eventId,
        traceId,
        method,
        durationMs: Date.now() - start,
        outcome: "success",
        opts,
        sourceNodeCount: _extractSourceNodeCount(result),
      });
      return result;
    };

    const onError = (err: unknown): never => {
      _emit({
        eventId,
        traceId,
        method,
        durationMs: Date.now() - start,
        outcome: "error",
        error: err,
        opts,
      });
      throw err;
    };

    try {
      const result = original.apply(this, args);
      if (result instanceof Promise) {
        return result.then(onSettled, onError);
      }
      return onSettled(result);
    } catch (err) {
      return onError(err);
    }
  };
}

async function* _wrapStream(
  upstream: AsyncIterable<unknown>,
  ctx: {
    method: MethodName;
    start: number;
    traceId: string;
    eventId: string;
    opts: TraceOptions;
  },
): AsyncGenerator<unknown, void, unknown> {
  const { method, start, traceId, eventId, opts } = ctx;
  let tFirst: number | null = null;
  let tPrev: number | null = null;
  let tLast = start;
  let chunkCount = 0;
  let sourceNodeCount: number | undefined;
  let outcome: "success" | "error" = "success";
  let errorObj: unknown;
  const chunkBuffer: StreamChunk[] = [];
  const captureChunkText = getDefaultClient().getConfig().captureChunkText;

  try {
    for await (const chunk of upstream) {
      chunkCount += 1;
      const now = Date.now();
      const prev = tPrev;
      if (tFirst === null) tFirst = now;
      tPrev = now;
      tLast = now;
      const text = _extractChunkText(chunk);
      const nodeCount = _extractSourceNodeCount(chunk);
      if (nodeCount !== undefined) sourceNodeCount = nodeCount;
      chunkBuffer.push({
        eventId,
        traceId,
        chunkIndex: chunkCount - 1,
        deltaText: captureChunkText ? (text ?? null) : null,
        ttftMs: tFirst !== null ? tFirst - start : null,
        itlMs: prev !== null ? now - prev : null,
        tpotMs: null,
        receivedAtClientMs: Date.now(),
      });
      yield chunk;
    }
  } catch (err) {
    outcome = "error";
    errorObj = err;
    throw err;
  } finally {
    _emit({
      eventId,
      traceId,
      method,
      durationMs: tLast - start,
      outcome,
      error: errorObj,
      opts,
      sourceNodeCount,
      chunkCount,
    });
    const client = getDefaultClient();
    for (const c of chunkBuffer) client.bufferChunk(c);
  }
}

function _extractSourceNodeCount(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const sn = (value as Record<string, unknown>).sourceNodes;
    if (Array.isArray(sn)) return sn.length;
  }
  return undefined;
}

function _extractChunkText(chunk: unknown): string | undefined {
  if (typeof chunk === "string") return chunk;
  if (chunk && typeof chunk === "object") {
    const c = chunk as Record<string, unknown>;
    if (typeof c.delta === "string") return c.delta;
    if (typeof c.response === "string") return c.response;
  }
  return undefined;
}

function _emit(args: {
  eventId: string;
  traceId: string;
  method: MethodName;
  durationMs: number;
  outcome: "success" | "error";
  error?: unknown;
  opts: TraceOptions;
  sourceNodeCount?: number;
  chunkCount?: number;
}): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  const attributes: Record<string, unknown> = {
    "llamaindex.method": args.method,
  };
  if (typeof args.sourceNodeCount === "number") {
    attributes["llamaindex.source_node_count"] = args.sourceNodeCount;
  }
  if (typeof args.chunkCount === "number") {
    attributes["llamaindex.chunk_count"] = args.chunkCount;
  }
  const errorFields: Record<string, unknown> = {};
  if (args.error !== undefined) {
    errorFields.error_type = errorClass(args.error);
    errorFields.error_message = errorMessage(args.error);
    attributes["llamaindex.error"] = errorMessage(args.error) ?? errorClass(args.error);
  }
  client.emit({
    eventId: args.eventId,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    traceId: args.traceId,
    realm: config.realm,
    eventType: "agent.run",
    timestamp: new Date().toISOString(),
    sourceFormat: "llamaindex",
    name: `llamaindex.${args.method}`,
    durationMs: args.durationMs,
    payload: {
      outcome: args.outcome,
      method: args.method,
      ...errorFields,
    },
    metrics: {
      duration_ms: args.durationMs,
      ...(typeof args.sourceNodeCount === "number"
        ? { source_node_count: args.sourceNodeCount }
        : {}),
      ...(typeof args.chunkCount === "number"
        ? { chunk_count: args.chunkCount }
        : {}),
    },
    attributes,
    tags: ["llama_index", "framework", ...(args.opts.tags ?? [])],
    environmentId: args.opts.environmentId,
  });
}
