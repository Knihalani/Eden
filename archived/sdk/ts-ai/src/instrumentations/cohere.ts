/**
 * Cohere auto-instrumentation.
 *
 * Wraps the official `cohere-ai` client's Chat API v2 surface —
 * Cohere's current, actively-documented Chat API — under BOTH shapes
 * `cohere-ai` exposes it in:
 *
 *   - the legacy `CohereClient` (`new CohereClient({...})`), where it
 *     lives at `client.v2.chat({...})` / `client.v2.chatStream({...})`
 *   - `CohereClientV2` (`new CohereClientV2({...})`) — Cohere's own
 *     documented primary entry point — where `chat`/`chatStream` are
 *     direct top-level properties with NO `.v2` nesting at all
 *
 * `wrapCohere` tells the two shapes apart via `"v2" in client`
 * (`CohereClientV2` never has a `v2` property; the legacy client
 * always does — verified against `cohere-ai`'s generated `.d.ts`
 * files) so both route through the same instrumentation helper
 * (`_maybeWrapChatMethod`).
 *
 * The legacy client's OWN top-level `client.chat` / `client.chatStream`
 * (the v1 API, `NonStreamedChatResponse` with a `meta.billed_units`
 * shape) is intentionally left to the generic HTTP-capture fallback:
 * v1 predates typed tool-calling and is superseded by v2 in Cohere's
 * own docs, and giving it a second, differently-shaped native wrapper
 * would double the surface this module has to keep correct for no
 * material benefit. If a caller needs v1 coverage, `installHttpCapture()`
 * still sees those requests.
 *
 * Response shape (verified against `cohere-ai`'s generated
 * `V2ChatResponse` / `Usage` types):
 *
 *   - `V2ChatResponse` has NO `model` field — unlike OpenAI/Groq/
 *     Mistral, the model must be read back off the *request*.
 *   - `usage.billedUnits.{inputTokens,outputTokens}` is the actual
 *     billed amount; `usage.tokens.{inputTokens,outputTokens}` is
 *     the raw (pre-billing) count. We report `billedUnits` when
 *     present (matches what the customer is actually charged),
 *     falling back to `tokens`.
 *   - `usage.cachedTokens` maps to `cache_read_input_tokens`.
 *   - Tool calls live at `message.toolCalls[].function.{name,arguments}`.
 *
 * Streaming (`chatStream`) yields a discriminated union of SSE-style
 * events (`type: "content-delta" | "tool-call-start" | "tool-call-delta"
 * | "message-end" | ...`) rather than OpenAI-shaped chunks:
 *
 *   - `content-delta`: `event.delta.message.content.text` is the
 *     text token.
 *   - `tool-call-start`: `event.delta.message.toolCalls` is a single
 *     `ToolCallV2` (one tool call per event, keyed by `event.index`)
 *     — NOT an array, unlike OpenAI/Groq/Mistral's `delta.tool_calls[]`.
 *   - `message-end`: `event.delta.usage` / `event.delta.finishReason`
 *     carry the final usage + finish reason.
 */

import { getDefaultClient } from "../client.js";
import { errorClass, errorMessage, randomId, traceIdOrRandom } from "../ids.js";
import { extractUsage, normalizeModelName, type NormalizedUsage } from "../tokens.js";
import type { StreamChunk, TraceOptions } from "../types.js";

const SOURCE_FORMAT = "cohere";

const _proxies = new WeakMap<object, object>();
const WRAP_MARKER = Symbol.for("@eden-ai/sdk.wrapCohere");

/**
 * Shared interception logic: given the object a `chat`/`chatStream`
 * property is being read off of (`propTarget`) and the property name
 * being read (`prop`), returns the instrumented replacement when
 * `prop` is `"chat"` or `"chatStream"` and resolves to a function;
 * otherwise returns `original` untouched.
 *
 * This is the single place that decides how `chat`/`chatStream` get
 * wrapped, so both client shapes below stay byte-for-byte identical
 * in behavior instead of drifting apart:
 *
 *   - the legacy `CohereClient`, where this runs against the nested
 *     `client.v2` object (`client.v2.chat` / `client.v2.chatStream`)
 *   - `CohereClientV2` — Cohere's own documented primary entry point
 *     (`new CohereClientV2({...})`) — where `chat`/`chatStream` are
 *     direct top-level properties with NO `.v2` nesting at all, so
 *     this runs directly against the client itself
 */
function _maybeWrapChatMethod(
  original: unknown,
  propTarget: object,
  prop: PropertyKey,
  opts: TraceOptions,
): unknown {
  if (typeof original !== "function") return original;
  const bound = original.bind(propTarget);
  if (prop === "chat") {
    return function (this: unknown, ...args: any[]): unknown {
      return _instrumentedChat(bound as (...a: any[]) => any, propTarget, args, opts);
    };
  }
  if (prop === "chatStream") {
    return function (this: unknown, ...args: any[]): unknown {
      return _instrumentedChatStream(bound as (...a: any[]) => any, propTarget, args, opts);
    };
  }
  return original;
}

/**
 * Wrap a Cohere client. Handles two distinct client shapes from
 * `cohere-ai`, both routed through `_maybeWrapChatMethod` so telemetry
 * is identical regardless of which class the caller instantiated:
 *
 *   - The legacy `CohereClient` (`new CohereClient({...})`), whose
 *     Chat API v2 surface lives at `client.v2.chat` /
 *     `client.v2.chatStream` (a nested `V2Client` accessed via a
 *     `v2` getter).
 *   - `CohereClientV2` (`new CohereClientV2({...})`) — Cohere's own
 *     documented primary entry point — which exposes `chat` /
 *     `chatStream` directly as top-level properties, with NO `.v2`
 *     nesting at all.
 *
 * Idempotent: calling twice on the same client returns the same
 * Proxy.
 */
export function wrapCohere<T extends object>(client: T, opts: TraceOptions = {}): T {
  if (!client || typeof client !== "object") return client;
  const existing = _proxies.get(client as object);
  if (existing) return existing as T;
  const marked = (client as unknown as { [k: symbol]: unknown })[WRAP_MARKER];
  if (marked === true) return client;

  // Distinguish the two client shapes WITHOUT triggering the legacy
  // client's `v2` getter (which lazily allocates a `V2Client`):
  // `CohereClientV2` never has a `v2` property at all (verified
  // against `cohere-ai`'s generated types — it implements
  // `Omit<CohereClient, keyof V2Client | "v2">`), while the legacy
  // `CohereClient` always does. So `"v2" in client` reliably tells
  // top-level `chat`/`chatStream` apart: on `CohereClientV2` they're
  // the Chat API v2 methods we want to instrument; on the legacy
  // client they're the differently-shaped v1 API that this module
  // intentionally leaves to the generic HTTP-capture fallback (see
  // the file header).
  const isLegacyClientShape = "v2" in (client as object);

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAP_MARKER) return true;
      if (prop === "v2") {
        const v2 = Reflect.get(target, prop, receiver);
        if (v2 && typeof v2 === "object") {
          return new Proxy(v2, {
            get(v2Target, v2Prop, v2Receiver) {
              const original = Reflect.get(v2Target, v2Prop, v2Receiver);
              return _maybeWrapChatMethod(original, v2Target, v2Prop, opts);
            },
          });
        }
        return v2;
      }
      // `CohereClientV2` shape: `chat`/`chatStream` live directly on
      // the client (no `.v2` nesting) — route them through the same
      // instrumentation as the nested-`.v2` shape above. Skipped for
      // the legacy client shape, whose top-level `chat`/`chatStream`
      // are the unrelated v1 API.
      if (!isLegacyClientShape && (prop === "chat" || prop === "chatStream")) {
        const original = Reflect.get(target, prop, receiver);
        return _maybeWrapChatMethod(original, target, prop, opts);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  try {
    (proxy as unknown as { [k: symbol]: unknown })[WRAP_MARKER] = true;
  } catch {
    // ignore
  }
  _proxies.set(client as object, proxy);
  _proxies.set(proxy, proxy);
  return proxy;
}

function _extractRequest(args: any[]): Record<string, unknown> | undefined {
  for (const a of args) {
    if (a && typeof a === "object") return a as Record<string, unknown>;
  }
  return undefined;
}

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
};

/**
 * Normalize a Cohere v2 `Usage` object into the shared usage shape.
 * Prefers `billedUnits` (what the caller is actually charged for)
 * over the raw `tokens` count; `cachedTokens` maps to
 * `cache_read_input_tokens`.
 */
export function extractCohereUsage(usage: unknown): NormalizedUsage {
  if (!usage || typeof usage !== "object") return EMPTY_USAGE;
  const u = usage as Record<string, unknown>;
  const billed = u.billedUnits;
  const tokens = u.tokens;
  const base =
    billed && typeof billed === "object"
      ? extractUsage(billed)
      : tokens && typeof tokens === "object"
        ? extractUsage(tokens)
        : EMPTY_USAGE;
  let cacheReadTokens = base.cacheReadTokens;
  if (cacheReadTokens === null && typeof u.cachedTokens === "number" && Number.isFinite(u.cachedTokens)) {
    cacheReadTokens = u.cachedTokens;
  }
  return { ...base, cacheReadTokens };
}

function _extractToolCalls(message: unknown): Array<{ id?: string; name?: string }> {
  if (!message || typeof message !== "object") return [];
  const toolCalls = (message as Record<string, unknown>).toolCalls;
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc: any) => ({
    id: typeof tc?.id === "string" ? tc.id : undefined,
    name: typeof tc?.function?.name === "string" ? tc.function.name : undefined,
  }));
}

/** `client.v2.chat()` — non-streaming. */
function _instrumentedChat(
  originalChat: (...args: any[]) => any,
  self: unknown,
  args: any[],
  opts: TraceOptions,
): unknown {
  const start = Date.now();
  const traceId = traceIdOrRandom();
  const eventId = randomId();
  const request = _extractRequest(args);
  // Cohere's V2ChatResponse carries no `model` field — the request
  // is the only source of truth.
  const model = typeof request?.model === "string" ? request.model : undefined;
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  let errorMsg: string | undefined;
  let capturedUsage: unknown;
  let toolCallCount = 0;
  let toolNames: string[] = [];
  let finishReason: string | undefined;

  return (async () => {
    try {
      const result = await originalChat.apply(self, args);
      if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (r.usage && typeof r.usage === "object") capturedUsage = r.usage;
        if (typeof r.finishReason === "string") finishReason = r.finishReason;
        const toolCalls = _extractToolCalls(r.message);
        toolCallCount = toolCalls.length;
        toolNames = toolCalls.map((t) => t.name).filter((n): n is string => !!n);
      }
      return result;
    } catch (err: unknown) {
      status = "error";
      errorType = errorClass(err);
      errorMsg = errorMessage(err);
      throw err;
    } finally {
      const durationMs = Date.now() - start;
      const client = getDefaultClient();
      const config = client.getConfig();
      const usage = capturedUsage ? extractCohereUsage(capturedUsage) : EMPTY_USAGE;
      const usageFields: Record<string, number> = {};
      if (usage.inputTokens !== null) usageFields.input_tokens = usage.inputTokens;
      if (usage.outputTokens !== null) usageFields.output_tokens = usage.outputTokens;
      if (usage.cacheReadTokens !== null) usageFields.cache_read_input_tokens = usage.cacheReadTokens;
      client.emit({
        eventId,
        tenantId: config.orgId ?? "default",
        projectId: config.projectId,
        traceId,
        realm: config.realm,
        eventType: "llm_completion",
        timestamp: new Date().toISOString(),
        sourceFormat: SOURCE_FORMAT,
        payload: {
          provider: "cohere",
          model,
          duration_ms: durationMs,
          status,
          error_type: errorType,
          ...(errorMsg !== undefined ? { error_message: errorMsg } : {}),
          finish_reason: finishReason,
          tool_call_count: toolCallCount,
          ...(toolNames.length > 0 ? { tool_names: toolNames } : {}),
          environment_id: opts.environmentId,
        },
        metrics: { duration_ms: durationMs, ...usageFields },
        modelNormalized: model ? (normalizeModelName(model) ?? undefined) : undefined,
        tags: [...(opts.tags ?? []), "auto_instrument"],
        environmentId: opts.environmentId,
        durationMs,
      });
    }
  })();
}

/** `client.v2.chatStream()` — returns an async iterable of SSE-style events. */
function _instrumentedChatStream(
  originalChatStream: (...args: any[]) => any,
  self: unknown,
  args: any[],
  opts: TraceOptions,
): unknown {
  const request = _extractRequest(args);
  const requestModel = typeof request?.model === "string" ? request.model : undefined;
  return (async () => {
    const upstream = await originalChatStream.apply(self, args);
    return _wrapCohereStream(upstream, opts, requestModel);
  })();
}

async function* _wrapCohereStream(
  upstream: AsyncIterable<any>,
  opts: TraceOptions,
  requestModel: string | undefined,
): AsyncIterable<any> {
  const start = Date.now();
  const traceId = traceIdOrRandom();
  const eventId = `stream_cohere_${randomId()}`;
  let tFirst: number | null = null;
  let tPrev: number | null = null;
  let tLast = start;
  let itlSumMs = 0;
  let itlCount = 0;
  let outputTokens = 0;
  let errorMsg: string | undefined;
  let usage: NormalizedUsage = EMPTY_USAGE;
  let finishReason: string | undefined;
  let chunkCount = 0;
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  // Cohere streams ONE tool call per ``tool-call-start`` event
  // (keyed by ``event.index``) rather than an array of fragments
  // per chunk — still keyed by index for parity with the
  // OpenAI/Groq/Mistral accumulation pattern.
  const toolCallNames = new Map<number, string>();

  const client = getDefaultClient();
  const config = client.getConfig();
  const chunkBuffer: StreamChunk[] = [];
  const bufferedTags = [...(opts.tags ?? []), "auto_instrument", "streaming"];

  try {
    for await (const event of upstream) {
      chunkCount += 1;
      const now = Date.now();
      tLast = now;
      const prev = tPrev;
      if (tFirst === null) tFirst = now;
      else if (prev !== null) {
        itlSumMs += now - prev;
        itlCount += 1;
      }
      tPrev = now;

      const etype = event?.type;
      let text: string | undefined;
      if (etype === "content-delta") {
        text = event?.delta?.message?.content?.text;
        if (typeof text === "string" && text) outputTokens += Math.max(1, Math.floor(text.length / 4));
      } else if (etype === "tool-call-start") {
        const idx = typeof event?.index === "number" ? event.index : 0;
        const name = event?.delta?.message?.toolCalls?.function?.name;
        if (typeof name === "string" && name.length > 0) toolCallNames.set(idx, name);
      } else if (etype === "message-end") {
        if (typeof event?.delta?.finishReason === "string") finishReason = event.delta.finishReason;
        if (event?.delta?.usage) usage = extractCohereUsage(event.delta.usage);
      }

      chunkBuffer.push({
        eventId,
        traceId,
        chunkIndex: chunkCount - 1,
        deltaText: config.captureChunkText ? (typeof text === "string" ? text : null) : null,
        ttftMs: tFirst !== null ? tFirst - start : null,
        itlMs: prev !== null ? now - prev : null,
        tpotMs:
          typeof text === "string" && text.length > 0 && prev !== null && now > prev
            ? (now - prev) / Math.max(1, Math.ceil(text.length / 4))
            : null,
        receivedAtClientMs: Date.now(),
      });

      yield event;
    }
  } catch (err) {
    status = "error";
    errorType = errorClass(err);
    errorMsg = errorMessage(err);
    throw err;
  } finally {
    if (typeof usage.outputTokens === "number" && usage.outputTokens > 0) outputTokens = usage.outputTokens;
    const ttftMs = tFirst !== null ? tFirst - start : 0;
    const completionDurationMs = tLast - start;
    const itlMsAvg = itlCount > 0 ? itlSumMs / itlCount : 0;
    const tpotMs = outputTokens > 1 ? (completionDurationMs - ttftMs) / (outputTokens - 1) : 0;

    client.emit({
      eventId,
      tenantId: config.orgId ?? "default",
      projectId: config.projectId,
      traceId,
      realm: config.realm,
      eventType: "llm_completion_stream",
      timestamp: new Date().toISOString(),
      sourceFormat: SOURCE_FORMAT,
      payload: {
        provider: "cohere",
        model: requestModel,
        status,
        error_type: errorType,
        ...(errorMsg !== undefined ? { error_message: errorMsg } : {}),
        chunk_count: chunkCount,
        finish_reason: finishReason,
        tool_call_count: toolCallNames.size,
        ...(toolCallNames.size > 0 ? { tool_names: Array.from(toolCallNames.values()) } : {}),
        environment_id: opts.environmentId,
      },
      metrics: {
        ttft_ms: ttftMs,
        itl_ms_avg: itlMsAvg,
        tpot_ms: tpotMs,
        completion_duration_ms: completionDurationMs,
        output_tokens: outputTokens,
        ...(usage.inputTokens !== null ? { input_tokens: usage.inputTokens } : {}),
        ...(usage.cacheReadTokens !== null ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
      },
      modelNormalized: requestModel ? (normalizeModelName(requestModel) ?? undefined) : undefined,
      tags: bufferedTags,
      environmentId: opts.environmentId,
      durationMs: completionDurationMs,
    });

    for (const chunk of chunkBuffer) {
      client.bufferChunk(chunk);
    }
  }
}
