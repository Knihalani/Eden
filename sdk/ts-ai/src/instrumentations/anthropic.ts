/**
 * Anthropic auto-instrumentation.
 *
 * `wrapAnthropic(client, opts)` returns a Proxy that intercepts
 * `client.messages.create({...})` calls:
 *
 *   - Non-streaming → one `llm_completion` event.
 *   - Streaming (`stream: true`) → wraps the async iterator to
 *     sample timing and emit one `llm_completion_stream` event
 *     on iterator exhaustion.
 *
 * Mirrors the Python SDK's `_instrument_anthropic` + `_wrap_anthropic_stream`.
 */

import { getDefaultClient } from "../client.js";
import { randomId } from "../ids.js";
import { extractUsage, normalizeModelName } from "../tokens.js";
import { SOURCE_FORMATS, type StreamChunk, type TraceOptions } from "../types.js";

const _wrapped = new WeakSet<object>();
const WRAP_MARKER = Symbol.for("@eden-ai/sdk.wrapAnthropic");

/**
 * Wrap an Anthropic client. Idempotent: calling twice on the
 * same client is a no-op.
 */
export function wrapAnthropic<T extends object>(
  client: T,
  opts: TraceOptions = {},
): T {
  if (
    !client ||
    (client as { messages?: unknown }).messages === undefined
  ) {
    return client;
  }
  if (_wrapped.has(client as object)) return client;
  const marked = (client as unknown as { [k: symbol]: unknown })[WRAP_MARKER];
  if (marked === true) return client;
  _wrapped.add(client as object);

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAP_MARKER) return true;
      if (prop === "messages") {
        const messages = Reflect.get(target, prop, receiver);
        if (
          messages &&
          typeof messages === "object" &&
          typeof (messages as { create?: unknown }).create === "function"
        ) {
          return new Proxy(messages, {
            get(msgTarget, msgProp, msgReceiver) {
              if (msgProp === "create") {
                const original = Reflect.get(
                  msgTarget,
                  msgProp,
                  msgReceiver,
                );
                if (typeof original !== "function") return original;
                // Bind the original ``create`` to the resource
                // object (``messages``) it's attached to, not the
                // top-level client. The Anthropic SDK internally
                // calls ``this._client.post(...)``, so ``this``
                // MUST be the resource or the wrapped client
                // shape breaks (TypeError: cannot read
                // properties of undefined).
                const bound = original.bind(msgTarget);
                return function (this: unknown, ...args: any[]): unknown {
                  return _instrumentedCreate(
                    bound as (...a: any[]) => any,
                    msgTarget,
                    args,
                    opts,
                  );
                };
              }
              return Reflect.get(msgTarget, msgProp, msgReceiver);
            },
          });
        }
        return messages;
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

function _instrumentedCreate(
  originalCreate: (...args: any[]) => any,
  self: unknown,
  args: any[],
  opts: TraceOptions,
): unknown {
  const isStream = _isStreaming(args);

  if (isStream) {
    return _wrapAnthropicStream(originalCreate, self, args, opts);
  }

  const start = Date.now();
  const traceId = randomId();
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  // Captured from the upstream result so we can normalize usage
  // into ``metrics`` on emit. Non-streaming Anthropic responses
  // ship full usage on the ``Message`` object; the streaming path
  // extracts from chunks instead.
  let capturedUsage: unknown = undefined;
  const modelFromArgs = _extractModel(args);

  // Run the upstream call and emit telemetry on settle — both
  // success and failure paths. We use a single async IIFE so the
  // timing/emit happen at a deterministic point and the test
  // harness's `await flush()` always sees the queued event.
  return (async () => {
    try {
      const result = await originalCreate.apply(self, args);
      // Anthropic SDK exposes ``result.usage`` on the returned
      // ``Message`` (also present on Anthropic-compatible gateways
      // that mirror the same shape).
      if (result && typeof result === "object") {
        const maybeUsage = (result as { usage?: unknown }).usage;
        if (maybeUsage && typeof maybeUsage === "object") {
          capturedUsage = maybeUsage;
        }
      }
      return result;
    } catch (err: unknown) {
      status = "error";
      errorType = err instanceof Error ? err.constructor.name : "Error";
      throw err;
    } finally {
      const durationMs = Date.now() - start;
      _emitAnthropicCompletion({
        traceId,
        model: modelFromArgs,
        durationMs,
        status,
        errorType,
        opts,
        usage: capturedUsage,
      });
    }
  })();
}

function _emitAnthropicCompletion(args: {
  traceId: string;
  model: string | undefined;
  durationMs: number;
  status: "success" | "error";
  errorType: string | undefined;
  opts: TraceOptions;
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
    sourceFormat: SOURCE_FORMATS.ANTHROPIC,
    payload: {
      provider: "anthropic",
      model: args.model,
      duration_ms: args.durationMs,
      status: args.status,
      error_type: args.errorType,
      environment_id: args.opts.environmentId,
    },
    metrics: { duration_ms: args.durationMs, ...usageFields },
    modelNormalized: args.model ? (normalizeModelName(args.model) ?? undefined) : undefined,
    tags: [...(args.opts.tags ?? []), "auto_instrument"],
    environmentId: args.opts.environmentId,
    durationMs: args.durationMs,
  });
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

async function* _wrapAnthropicStream(
  originalCreate: (...args: any[]) => any,
  self: unknown,
  args: any[],
  opts: TraceOptions,
): AsyncIterable<any> {
  const start = Date.now();
  const traceId = randomId();
  let tFirst: number | null = null;
  let tPrev: number | null = null;
  let tLast = start;
  let itlSumMs = 0;
  let itlCount = 0;
  let outputTokens = 0;
  let usageOutputTokens: number | undefined;
  let usageInputTokens: number | undefined;
  let usageCacheReadTokens: number | undefined;
  let usageCacheCreationTokens: number | undefined;
  let finishReason: string | undefined;
  let chunkCount = 0;
  let model: string | undefined;
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  const tags = [...(opts.tags ?? []), "auto_instrument", "streaming"];

  // Per-chunk replay buffer. Mirrors the Python SDK's
  // ``_wrap_async_stream`` path: every event is appended to
  // ``chunkBuffer`` and ``client.bufferChunk(...)``-flushed on
  // the same loop tick that emits the aggregate event. The TS
  // SDK previously *only* emitted the aggregate event, which
  // meant Anthropic streams had no per-chunk TPOT / ITL
  // metrics on the wire — parity bug with the Python SDK.
  const chunkBuffer: StreamChunk[] = [];
  const eventId = `stream_anthropic_${traceId}`;

  try {
    const upstream: AsyncIterable<any> = await originalCreate.apply(self, args);
    for await (const event of upstream) {
      chunkCount += 1;
      const now = Date.now();
      tLast = now;
      // Capture the interval to the previous chunk BEFORE
      // updating ``tPrev`` — otherwise the per-chunk ITL/TPOT
      // readings collapse to 0 for chunks that share a tick.
      const prev = tPrev;
      if (tFirst === null) tFirst = now;
      else if (prev !== null) {
        itlSumMs += now - prev;
        itlCount += 1;
      }
      tPrev = now;

      const etype = event?.type;
      // Hoist ``delta`` to function scope so the per-chunk
      // push below can read the text. The if-else chain only
      // assigns it on the content_block_delta path; the chunk
      // buffer path falls back to ``undefined`` for non-text
      // events.
      const delta = event?.delta;
      if (etype === "content_block_delta") {
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          outputTokens += Math.max(1, Math.floor(delta.text.length / 4));
        }
      } else if (etype === "message_delta") {
        if (delta?.stop_reason) finishReason = delta.stop_reason;
        const usage = event?.usage;
        if (usage) {
          const u = extractUsage(usage);
          if (u.outputTokens !== null && u.outputTokens > 0) usageOutputTokens = u.outputTokens;
          if (u.cacheReadTokens !== null) usageCacheReadTokens = u.cacheReadTokens;
        }
      } else if (etype === "message_start") {
        const msg = event?.message;
        if (msg) {
          if (typeof msg.model === "string") model = msg.model;
          const usage = msg.usage;
          if (usage) {
            const u = extractUsage(usage);
            if (u.inputTokens !== null) usageInputTokens = u.inputTokens;
            if (u.cacheReadTokens !== null) usageCacheReadTokens = u.cacheReadTokens;
            if (u.cacheCreationTokens !== null) usageCacheCreationTokens = u.cacheCreationTokens;
          }
        }
      }

      // Per-chunk payload: only ``content_block_delta`` carries
      // ``delta.text`` (the user-visible text token stream);
      // other event types (``message_start`` / ``message_delta``)
      // contribute timing but no text. Push every event so the
      // gateway can reconstruct ITL / TTFT and replay the
      // stream.
      const deltaText: string | null =
        etype === "content_block_delta" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
          ? delta.text
          : null;
      // Per-chunk TPOT: time spent generating THIS chunk's
      // tokens divided by the chunk's token count. Tokens are
      // approximated as ``ceil(len/4)`` (same heuristic the
      // aggregate uses). Chunks without text contribute
      // ``null`` rather than a misleading zero — matches the
      // OpenAI instrumentation.
      const tpotMs =
        deltaText && deltaText.length > 0 && prev !== null && now > prev
          ? (now - prev) / Math.max(1, Math.ceil(deltaText.length / 4))
          : null;
      chunkBuffer.push({
        eventId,
        traceId,
        chunkIndex: chunkCount - 1,
        deltaText,
        ttftMs: tFirst !== null ? tFirst - start : null,
        itlMs: prev !== null ? now - prev : null,
        tpotMs,
        receivedAtClientMs: Date.now(),
      });
      yield event;
    }
  } catch (err) {
    status = "error";
    errorType = err instanceof Error ? err.constructor.name : "Error";
    throw err;
  } finally {
    if (typeof usageOutputTokens === "number") outputTokens = usageOutputTokens;
    const ttftMs = tFirst !== null ? tFirst - start : 0;
    const completionDurationMs = tLast - start;
    const itlMsAvg = itlCount > 0 ? itlSumMs / itlCount : 0;
    const tpotMs = outputTokens > 1 ? (completionDurationMs - ttftMs) / (outputTokens - 1) : 0;

    const client = getDefaultClient();
    const config = client.getConfig();
    client.emit({
      eventId: traceId,
      tenantId: config.orgId ?? "default",
      projectId: config.projectId,
      traceId,
      realm: config.realm,
      eventType: "llm_completion_stream",
      timestamp: new Date().toISOString(),
      sourceFormat: SOURCE_FORMATS.ANTHROPIC,
      payload: {
        provider: "anthropic",
        model,
        status,
        error_type: errorType,
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
        ...(typeof usageInputTokens === "number"
          ? { input_tokens: usageInputTokens }
          : {}),
        ...(typeof usageCacheReadTokens === "number"
          ? { cache_read_input_tokens: usageCacheReadTokens }
          : {}),
        ...(typeof usageCacheCreationTokens === "number"
          ? { cache_creation_input_tokens: usageCacheCreationTokens }
          : {}),
      },
      modelNormalized: model ? (normalizeModelName(model) ?? undefined) : undefined,
      tags,
      environmentId: opts.environmentId,
      durationMs: completionDurationMs,
    });
    // Per-chunk replay — flush the buffered events to
    // ``/ingest/chunks`` on the same tick as the aggregate
    // event. Mirrors the Python SDK and the OpenAI TS path.
    for (const chunk of chunkBuffer) {
      client.bufferChunk(chunk);
    }
  }
}

