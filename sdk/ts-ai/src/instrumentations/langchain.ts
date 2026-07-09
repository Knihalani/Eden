/**
 * LangChain auto-instrumentation.
 *
 * `wrapLangChain(chatModel, opts)` wraps a LangChain
 * `BaseChatModel` instance (or any object exposing `invoke` /
 * `stream` / `call` methods) so each invocation emits one
 * `llm_completion` event. Streaming invocations emit
 * `llm_completion_stream` with TTFT, ITL, TPOT, and chunk
 * count.
 *
 * Mirrors the Python SDK's `_instrument_langchain` which
 * monkey-patches `BaseChatModel._agenerate`. We do the
 * instance-level wrap instead (less invasive, multiple models
 * can be wrapped independently).
 *
 * The wrapper is dependency-free: pass in any chat-model
 * instance returned by `import { ChatOpenAI } from
 * "@langchain/openai"` etc.
 */

import { getDefaultClient } from "../client.js";
import { normalizeModelName } from "../tokens.js";
import { SOURCE_FORMATS, type TraceOptions } from "../types.js";

const _wrapped = new WeakSet<object>();
const WRAP_MARKER = Symbol.for("@eden-ai/sdk.wrapLangChain");

const METHODS_TO_WRAP = ["invoke", "call", "stream", "batch"] as const;
type MethodName = (typeof METHODS_TO_WRAP)[number];

export function wrapLangChain<T extends object>(
  chatModel: T,
  opts: TraceOptions = {},
): T {
  if (!chatModel || typeof chatModel !== "object") return chatModel;
  if (_wrapped.has(chatModel)) return chatModel;
  // Marker check for re-wrapping a Proxy we already produced.
  const marked = (chatModel as unknown as { [k: symbol]: unknown })[WRAP_MARKER];
  if (marked === true) return chatModel;
  _wrapped.add(chatModel);

  const proxy = new Proxy(chatModel, {
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
  return proxy;
}

function _wrapMethod(
  original: (...args: any[]) => any,
  method: MethodName,
  opts: TraceOptions,
): (...args: any[]) => any {
  if (method === "stream") {
    return function (this: unknown, ...args: any[]) {
      const start = Date.now();
      const traceId = randomId();
      let tFirst: number | null = null;
      let tPrev: number | null = null;
      let tLast = start;
      let chunkCount = 0;
      let outputTokens = 0;
      let status: "success" | "error" = "success";
      let errorType: string | undefined;

      // `original` may be sync or async. We need an AsyncIterable
      // to wrap. If sync, `callResult` is the iterable; if async,
      // the caller will await the return — we resolve lazily.
      let callResult: unknown;
      try {
        callResult = original.apply(this, args);
      } catch (err) {
        status = "error";
        errorType = err instanceof Error ? err.constructor.name : "Error";
        _emit({
          traceId,
          method,
          durationMs: Date.now() - start,
          status,
          errorType,
          opts,
        });
        throw err;
      }

      const iterPromise: Promise<AsyncIterable<unknown>> =
        callResult instanceof Promise
          ? callResult.then((r: unknown) => r as AsyncIterable<unknown>)
          : Promise.resolve(callResult as AsyncIterable<unknown>);

      const wrapped: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
          let pendingError: unknown = null;
          let inner: AsyncIterable<unknown> | null = null;
          let iterIt: AsyncIterator<unknown> | null = null;
          const ready = iterPromise.then(
            (r) => {
              inner = r;
            },
            (e) => {
              pendingError = e;
            },
          );

          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (iterIt === null && pendingError === null && inner === null) {
                await ready;
                const pendingErr: unknown = pendingError;
                if (pendingErr) {
                  status = "error";
                  errorType =
                    pendingErr instanceof Error
                      ? pendingErr.constructor.name
                      : "Error";
                  _emitStream({
                    traceId,
                    method,
                    chunkCount: 0,
                    outputTokens: 0,
                    ttftMs: 0,
                    itlMsAvg: 0,
                    tpotMs: 0,
                    completionDurationMs: Date.now() - start,
                    status,
                    errorType,
                    opts,
                  });
                  throw pendingError;
                }
                if (!inner) {
                  throw new Error("eden-ai: langchain stream resolved empty");
                }
                const resolvedInner: AsyncIterable<unknown> = inner;
                iterIt = resolvedInner[Symbol.asyncIterator]();
              }
              const activeIter: AsyncIterator<unknown> | null = iterIt;
              if (!activeIter) {
                throw new Error("eden-ai: langchain stream not initialised");
              }
              try {
                const r = await activeIter.next();
                if (!r.done) {
                  chunkCount += 1;
                  const now = Date.now();
                  tLast = now;
                  if (tFirst === null) tFirst = now;
                  else if (tPrev !== null) {
                    // itl avg computed in finish
                  }
                  tPrev = now;
                  const text = _extractLangChainText(r.value);
                  if (text)
                    outputTokens += Math.max(
                      1,
                      Math.floor(text.length / 4),
                    );
                } else {
                  const ttftMs = tFirst !== null ? tFirst - start : 0;
                  const completionDurationMs = tLast - start;
                  const itlCount = Math.max(0, chunkCount - 1);
                  const itlMsAvg =
                    itlCount > 0
                      ? (tLast - (tFirst ?? start)) / itlCount
                      : 0;
                  const tpotMs =
                    outputTokens > 1
                      ? (completionDurationMs - ttftMs) / (outputTokens - 1)
                      : 0;
                  _emitStream({
                    traceId,
                    method,
                    chunkCount,
                    outputTokens,
                    ttftMs,
                    itlMsAvg,
                    tpotMs,
                    completionDurationMs,
                    status,
                    errorType,
                    opts,
                  });
                }
                return r;
              } catch (err) {
                status = "error";
                errorType =
                  err instanceof Error ? err.constructor.name : "Error";
                _emitStream({
                  traceId,
                  method,
                  chunkCount,
                  outputTokens,
                  ttftMs: tFirst !== null ? tFirst - start : 0,
                  itlMsAvg: 0,
                  tpotMs: 0,
                  completionDurationMs: Date.now() - start,
                  status,
                  errorType,
                  opts,
                });
                throw err;
              }
            },
            async return(): Promise<IteratorResult<unknown>> {
              const it: AsyncIterator<unknown> | null = iterIt;
              if (it && typeof it.return === "function") {
                await it.return();
              }
              return { value: undefined, done: true };
            },
            async throw(err: unknown): Promise<IteratorResult<unknown>> {
              const it: AsyncIterator<unknown> | null = iterIt;
              if (it && typeof it.throw === "function") {
                return it.throw(err);
              }
              throw err;
            },
          };
        },
      };

      // If the original returned a Promise, return the wrapped
      // iterable via Promise; otherwise return directly.
      if (callResult instanceof Promise) {
        return Promise.resolve(wrapped);
      }
      return wrapped;
    };
  }

  return function (this: unknown, ...args: any[]) {
    const start = Date.now();
    const traceId = randomId();
    let status: "success" | "error" = "success";
    let errorType: string | undefined;
    try {
      const result = original.apply(this, args);
      if (result instanceof Promise) {
        return result
          .catch((err: unknown) => {
            status = "error";
            errorType = err instanceof Error ? err.constructor.name : "Error";
            throw err;
          })
          .then((value: unknown) => {
            _emit({
              traceId,
              method,
              durationMs: Date.now() - start,
              status,
              errorType,
              opts,
            });
            return value;
          });
      }
      _emit({
        traceId,
        method,
        durationMs: Date.now() - start,
        status,
        errorType,
        opts,
      });
      return result;
    } catch (err) {
      status = "error";
      errorType = err instanceof Error ? err.constructor.name : "Error";
      _emit({
        traceId,
        method,
        durationMs: Date.now() - start,
        status,
        errorType,
        opts,
      });
      throw err;
    }
  };
}

function _extractLangChainText(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== "object") return undefined;
  const c = chunk as Record<string, unknown>;
  if (typeof c.content === "string") return c.content;
  if (Array.isArray(c.content)) {
    return c.content
      .map((block) => {
        if (block && typeof block === "object" && "text" in block) {
          const t = (block as { text?: unknown }).text;
          if (typeof t === "string") return t;
        }
        return "";
      })
      .join("");
  }
  if (typeof c.text === "string") return c.text;
  if (typeof c.delta === "string") return c.delta;
  return undefined;
}

function _emit(args: {
  traceId: string;
  method: MethodName;
  durationMs: number;
  status: "success" | "error";
  errorType: string | undefined;
  opts: TraceOptions;
}): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  client.emit({
    eventId: args.traceId,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    traceId: args.traceId,
    realm: config.realm,
    eventType: "llm_completion",
    timestamp: new Date().toISOString(),
    sourceFormat: SOURCE_FORMATS.LANGCHAIN,
    payload: {
      provider: "langchain",
      method: args.method,
      duration_ms: args.durationMs,
      status: args.status,
      error_type: args.errorType,
      environment_id: args.opts.environmentId,
    },
    metrics: { duration_ms: args.durationMs },
    tags: [...(args.opts.tags ?? []), "auto_instrument"],
    environmentId: args.opts.environmentId,
    durationMs: args.durationMs,
  });
}

function _emitStream(args: {
  traceId: string;
  method: MethodName;
  chunkCount: number;
  outputTokens: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model?: string;
  ttftMs: number;
  itlMsAvg: number;
  tpotMs: number;
  completionDurationMs: number;
  status: "success" | "error";
  errorType: string | undefined;
  opts: TraceOptions;
}): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  client.emit({
    eventId: args.traceId,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    traceId: args.traceId,
    realm: config.realm,
    eventType: "llm_completion_stream",
    timestamp: new Date().toISOString(),
    sourceFormat: SOURCE_FORMATS.LANGCHAIN,
    payload: {
      provider: "langchain",
      method: args.method,
      chunk_count: args.chunkCount,
      status: args.status,
      error_type: args.errorType,
      environment_id: args.opts.environmentId,
    },
    metrics: {
      ttft_ms: args.ttftMs,
      itl_ms_avg: args.itlMsAvg,
      tpot_ms: args.tpotMs,
      completion_duration_ms: args.completionDurationMs,
      output_tokens: args.outputTokens,
      ...(typeof args.inputTokens === "number" ? { input_tokens: args.inputTokens } : {}),
      ...(typeof args.cacheReadTokens === "number" ? { cache_read_input_tokens: args.cacheReadTokens } : {}),
      ...(typeof args.cacheCreationTokens === "number" ? { cache_creation_input_tokens: args.cacheCreationTokens } : {}),
    },
    modelNormalized: args.model ? (normalizeModelName(args.model) ?? undefined) : undefined,
    tags: [...(args.opts.tags ?? []), "auto_instrument", "streaming"],
    environmentId: args.opts.environmentId,
    durationMs: args.completionDurationMs,
  });
}

function randomId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}${rand}`.slice(0, 24);
}
