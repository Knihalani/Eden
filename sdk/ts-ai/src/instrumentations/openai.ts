/**
 * OpenAI auto-instrumentation.
 *
 * `wrapOpenAI(opts)` returns a Proxy that wraps the user's OpenAI
 * client instance. Every call to
 * `client.chat.completions.create({...})` is intercepted:
 *
 *   - Non-streaming calls → one `llm_completion` event after
 *     the response resolves (or throws).
 *   - Streaming calls (`stream: true`) → the returned async
 *     iterable is wrapped to sample per-chunk timing; one
 *     `llm_completion_stream` event is emitted after the
 *     iterator exhausts.
 *
 * Mirrors the Python SDK's `_instrument_openai` + `_wrap_openai_stream`.
 */

import { getDefaultClient } from "../client.js";
import { errorClass, errorMessage, randomId } from "../ids.js";
import { extractUsage, normalizeModelName } from "../tokens.js";
import {
  SOURCE_FORMATS,
  type StreamChunk,
  type TraceOptions,
} from "../types.js";

// original → proxy (and proxy → proxy) so re-wrapping the same
// client returns the instrumented Proxy, not the bare original.
const _proxies = new WeakMap<object, object>();
const WRAP_MARKER = Symbol.for("@eden-ai/sdk.wrapOpenAI");

/**
 * Wrap an OpenAI client (or any object that exposes
 * `client.chat.completions.create`) with a Proxy that
 * instruments every call.
 *
 * The function is idempotent: calling it twice on the same
 * client returns the same Proxy.
 */
export function wrapOpenAI<T extends object>(
  client: T,
  opts: TraceOptions = {},
): T {
  if (!client || (client as { chat?: unknown }).chat === undefined) {
    return client;
  }
  const existing = _proxies.get(client as object);
  if (existing) return existing as T;
  // If this is a Proxy we already produced, return it as-is.
  // We tag proxies with a Symbol; if the input lacks the
  // `chat` interface (or the user passes back a proxy), we
  // still want stable identity. Best-effort: check the marker
  // by reading the hidden property.
  const marked = (client as unknown as { [k: symbol]: unknown })[WRAP_MARKER];
  if (marked === true) return client;

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAP_MARKER) return true;
      if (prop === "chat") {
        const chat = Reflect.get(target, prop, receiver);
        if (
          chat &&
          typeof chat === "object" &&
          (chat as { completions?: unknown }).completions
        ) {
          return new Proxy(chat, {
            get(chatTarget, chatProp, chatReceiver) {
              if (chatProp === "completions") {
                const completions = Reflect.get(
                  chatTarget,
                  chatProp,
                  chatReceiver,
                );
                if (
                  completions &&
                  typeof completions === "object" &&
                  typeof (completions as { create?: unknown }).create === "function"
                ) {
                  return new Proxy(completions, {
                get(compTarget, compProp, compReceiver) {
                  if (compProp === "create") {
                    const original = Reflect.get(
                      compTarget,
                      compProp,
                      compReceiver,
                    );
                    if (typeof original !== "function") return original;
                    // Bind the original ``create`` to the resource
                    // object (``completions``) it's attached to,
                    // not the top-level client. The OpenAI SDK
                    // internally calls ``this._client.post(...)``,
                    // so ``this`` MUST be the resource or the
                    // wrapped client shape breaks (TypeError:
                    // cannot read properties of undefined).
                    const bound = original.bind(compTarget);
                    return function (this: unknown, ...args: any[]): unknown {
                      return _instrumentedCreate(
                        bound as (...a: any[]) => any,
                        compTarget,
                        args,
                        opts,
                      );
                    };
                  }
                  return Reflect.get(compTarget, compProp, compReceiver);
                },
              });
                }
                return completions;
              }
              return Reflect.get(chatTarget, chatProp, chatReceiver);
            },
          });
        }
        return chat;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  // Tag the proxy so re-wrapping is a no-op.
  try {
    (proxy as unknown as { [k: symbol]: unknown })[WRAP_MARKER] = true;
  } catch {
    // The proxy may be frozen; ignore.
  }
  _proxies.set(client as object, proxy);
  _proxies.set(proxy, proxy);
  return proxy;
}

function _instrumentedCreate(
  originalCreate: (...args: any[]) => any,
  self: unknown,
  args: any[],
  opts: TraceOptions,
): unknown {
  // OpenAI SDK supports both `create(messages, options)` and
  // `create({ messages, model, ... })` signatures. Normalise.
  const isStream = _isStreaming(args);

  if (isStream) {
    return _wrapOpenAIStream(originalCreate, self, args, opts);
  }

  const start = Date.now();
  const traceId = randomId();
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  let errorMsg: string | undefined;
  // Captured from the upstream result so we can normalize usage
  // into ``metrics`` on emit. Non-streaming OpenAI responses ship
  // full usage on the chat completion object; the streaming path
  // extracts from chunks instead.
  let capturedUsage: unknown = undefined;

  // Run the upstream call and emit telemetry on settle — both
  // success and failure paths. We use a single async IIFE so the
  // timing/emit happen at a deterministic point and the test
  // harness's `await flush()` always sees the queued event.
  return (async () => {
    try {
      const result = await originalCreate.apply(self, args);
      // OpenAI SDK exposes ``result.usage``; OpenAI-compatible
      // gateways (OpenRouter etc.) may use the same shape.
      if (result && typeof result === "object") {
        const maybeUsage = (result as { usage?: unknown }).usage;
        if (maybeUsage && typeof maybeUsage === "object") {
          capturedUsage = maybeUsage;
        }
      }
      return result;
    } catch (err: unknown) {
      status = "error";
      errorType = errorClass(err);
      errorMsg = errorMessage(err);
      throw err;
    } finally {
      const durationMs = Date.now() - start;
      _emitCompletion({
        traceId,
        model: _extractModel(args),
        durationMs,
        status,
        errorType,
        errorMessage: errorMsg,
        opts,
        framework: SOURCE_FORMATS.OPENAI,
        usage: capturedUsage,
      });
    }
  })();
}

function _isStreaming(args: any[]): boolean {
  for (const a of args) {
    if (a && typeof a === "object" && a.stream === true) return true;
  }
  return false;
}

function _extractModel(args: any[]): string | undefined {
  for (const a of args) {
    if (a && typeof a === "object" && typeof a.model === "string") return a.model;
  }
  return undefined;
}

async function* _wrapOpenAIStream(
  originalCreate: (...args: any[]) => any,
  self: unknown,
  args: any[],
  opts: TraceOptions,
): AsyncIterable<any> {
  const start = Date.now();
  const traceId = randomId();
  const eventId = `stream_openai_${traceId}`;
  let tFirst: number | null = null;
  let tPrev: number | null = null;
  let tLast = start;
  let itlSumMs = 0;
  let itlCount = 0;
  let outputTokens = 0;
  let errorMsg: string | undefined;
  let usageOutputTokens: number | undefined;
  let usageInputTokens: number | undefined;
  let usageCacheReadTokens: number | undefined;
  let usageCacheCreationTokens: number | undefined;
  let finishReason: string | undefined;
  let chunkCount = 0;
  let model: string | undefined;
  let status: "success" | "error" = "success";
  let errorType: string | undefined;

  const client = getDefaultClient();
  const config = client.getConfig();
  const chunkBuffer: StreamChunk[] = [];
  const bufferedTags = [...(opts.tags ?? []), "auto_instrument", "streaming"];

  try {
    const upstream: AsyncIterable<any> = await originalCreate.apply(self, args);
    for await (const chunk of upstream) {
      chunkCount += 1;
      const now = Date.now();
      tLast = now;
      // Capture the interval to the previous chunk BEFORE updating
      // tPrev — otherwise both the ITL accumulator and the
      // per-chunk ITL/TPOT readings collapse to 0.
      const prev = tPrev;
      if (tFirst === null) tFirst = now;
      else if (prev !== null) {
        itlSumMs += now - prev;
        itlCount += 1;
      }
      tPrev = now;

      const choice = chunk?.choices?.[0];
      const text: string | undefined = choice?.delta?.content;
      if (text) outputTokens += Math.max(1, Math.floor(text.length / 4));
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (!model && chunk?.model) model = chunk.model;
      const usage = chunk?.usage;
      if (usage) {
        const u = extractUsage(usage);
        if (u.outputTokens !== null && u.outputTokens > 0) usageOutputTokens = u.outputTokens;
        if (u.inputTokens !== null) usageInputTokens = u.inputTokens;
        if (u.cacheReadTokens !== null) usageCacheReadTokens = u.cacheReadTokens;
        if (u.cacheCreationTokens !== null) usageCacheCreationTokens = u.cacheCreationTokens;
      }

      chunkBuffer.push({
        eventId,
        traceId,
        chunkIndex: chunkCount - 1,
        deltaText: config.captureChunkText ? (text ?? null) : null,
        ttftMs: tFirst !== null ? tFirst - start : null,
        itlMs: prev !== null ? now - prev : null,
        // Per-chunk TPOT (time per output token) is the time spent
        // generating THIS chunk's tokens divided by the token count
        // for this chunk. Tokens are approximated as ``ceil(len/4)``
        // (the same heuristic the aggregate uses). Chunks with no
        // text (e.g. finish_reason / usage chunks) have no TPOT
        // — ``null`` rather than a misleading zero.
        //
        // The previous implementation set ``tpotMs = (now-start) /
        // chunkCount`` which is actually the average inter-chunk
        // arrival time, NOT time per token — that mislabel
        // propagated into the server's ``tpot_ms_p50`` /
        // ``tpot_ms_p95`` percentile dashboards.
        tpotMs:
          text && text.length > 0 && prev !== null && now > prev
            ? (now - prev) / Math.max(1, Math.ceil(text.length / 4))
            : null,
        receivedAtClientMs: Date.now(),
      });

      yield chunk;
    }
  } catch (err) {
    status = "error";
    errorType = errorClass(err);
    errorMsg = errorMessage(err);
    throw err;
  } finally {
    if (typeof usageOutputTokens === "number") outputTokens = usageOutputTokens;
    const ttftMs = tFirst !== null ? tFirst - start : 0;
    const completionDurationMs = tLast - start;
    const itlMsAvg = itlCount > 0 ? itlSumMs / itlCount : 0;
    const tpotMs = outputTokens > 1 ? (completionDurationMs - ttftMs) / (outputTokens - 1) : 0;

    client.emit({
      eventId: traceId,
      tenantId: config.orgId ?? "default",
      projectId: config.projectId,
      traceId,
      realm: config.realm,
      eventType: "llm_completion_stream",
      timestamp: new Date().toISOString(),
      sourceFormat: SOURCE_FORMATS.OPENAI,
      payload: {
        provider: "openai",
        model,
        status,
        error_type: errorType,
        ...(errorMsg !== undefined ? { error_message: errorMsg } : {}),
        chunk_count: chunkCount,
        finish_reason: finishReason,
        environment_id: opts.environmentId,
      },
      metrics: {
        ttft_ms: ttftMs,
        itl_ms_avg: itlMsAvg,
        tpot_ms: tpotMs,
        completion_duration_ms: completionDurationMs,
        output_tokens: outputTokens,
        ...(typeof usageInputTokens === "number" ? { input_tokens: usageInputTokens } : {}),
        ...(typeof usageCacheReadTokens === "number" ? { cache_read_input_tokens: usageCacheReadTokens } : {}),
        ...(typeof usageCacheCreationTokens === "number" ? { cache_creation_input_tokens: usageCacheCreationTokens } : {}),
      },
      modelNormalized: model ? (normalizeModelName(model) ?? undefined) : undefined,
      tags: bufferedTags,
      environmentId: opts.environmentId,
      durationMs: completionDurationMs,
    });

    // Per-chunk replay — mirrors Python SDK's
    // ``_flush_stream_chunks`` / ``POST /ingest/chunks``.
    for (const chunk of chunkBuffer) {
      client.bufferChunk(chunk);
    }
  }
}

function _emitCompletion(args: {
  traceId: string;
  model: string | undefined;
  durationMs: number;
  status: "success" | "error";
  errorType: string | undefined;
  errorMessage?: string | undefined;
  opts: TraceOptions;
  framework: string;
  usage?: unknown;
}): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  // Normalize usage into the same ``metrics`` shape the streaming
  // path emits so callers see identical billing fields regardless
  // of whether they used ``stream: true`` or not.
  const usageFields: Record<string, number> = {};
  if (args.usage) {
    const u = extractUsage(args.usage);
    if (u.inputTokens !== null) usageFields.input_tokens = u.inputTokens;
    if (u.outputTokens !== null) usageFields.output_tokens = u.outputTokens;
    if (u.cacheReadTokens !== null) usageFields.cache_read_input_tokens = u.cacheReadTokens;
    if (u.cacheCreationTokens !== null) usageFields.cache_creation_input_tokens = u.cacheCreationTokens;
  }
  client.emit({
    eventId: args.traceId,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    traceId: args.traceId,
    realm: config.realm,
    eventType: "llm_completion",
    timestamp: new Date().toISOString(),
    sourceFormat: args.framework,
    payload: {
      provider: "openai",
      model: args.model,
      duration_ms: args.durationMs,
      status: args.status,
      error_type: args.errorType,
      ...(args.errorMessage !== undefined ? { error_message: args.errorMessage } : {}),
      environment_id: args.opts.environmentId,
    },
    metrics: { duration_ms: args.durationMs, ...usageFields },
    modelNormalized: args.model ? (normalizeModelName(args.model) ?? undefined) : undefined,
    tags: [...(args.opts.tags ?? []), "auto_instrument"],
    environmentId: args.opts.environmentId,
    durationMs: args.durationMs,
  });
}
