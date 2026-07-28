/**
 * Mistral AI auto-instrumentation.
 *
 * Wraps the official `@mistralai/mistralai` client's
 * `client.chat.complete({...})` / `client.chat.stream({...})` methods.
 * Previously Mistral calls were only reachable via the generic
 * host-sniffing HTTP-capture path. This module gives Mistral a
 * dedicated wrapper — mirroring `openai.ts`'s `wrapOpenAI` — that
 * understands the SDK's actual response shapes:
 *
 *   - `chat.complete()` returns a `ChatCompletionResponse` whose
 *     `usage` field uses OpenAI-shaped camelCase keys
 *     (`promptTokens` / `completionTokens` / `totalTokens`) rather
 *     than OpenAI's own snake_case — verified against the SDK's
 *     generated `UsageInfo` type (`@mistralai/mistralai/models/usageinfo`).
 *   - `chat.stream()` returns an `EventStream<CompletionEvent>` where
 *     each event's `.data` field (NOT the event itself) is the
 *     OpenAI-shaped `CompletionChunk` (`choices[].delta.content`,
 *     `usage`, `model`) — one extra unwrap step versus OpenAI/Groq.
 *   - Tool calls surface as `message.tool_calls[].function.{name,arguments}`
 *     (non-streaming) and accumulate incrementally on
 *     `delta.tool_calls[].function.name` keyed by `index` (streaming),
 *     same shape as OpenAI/Groq.
 */

import { getDefaultClient } from "../client.js";
import { errorClass, errorMessage, randomId, traceIdOrRandom } from "../ids.js";
import { extractUsage, normalizeModelName } from "../tokens.js";
import type { StreamChunk, TraceOptions } from "../types.js";

const SOURCE_FORMAT = "mistral";

const _proxies = new WeakMap<object, object>();
const WRAP_MARKER = Symbol.for("@eden-ai/sdk.wrapMistral");

/**
 * Wrap a Mistral client (or any object exposing `client.chat.complete`
 * / `client.chat.stream`). Idempotent: calling twice on the same
 * client returns the same Proxy.
 */
export function wrapMistral<T extends object>(client: T, opts: TraceOptions = {}): T {
  if (!client || (client as { chat?: unknown }).chat === undefined) {
    return client;
  }
  const existing = _proxies.get(client as object);
  if (existing) return existing as T;
  const marked = (client as unknown as { [k: symbol]: unknown })[WRAP_MARKER];
  if (marked === true) return client;

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAP_MARKER) return true;
      if (prop === "chat") {
        const chat = Reflect.get(target, prop, receiver);
        if (chat && typeof chat === "object") {
          return new Proxy(chat, {
            get(chatTarget, chatProp, chatReceiver) {
              const original = Reflect.get(chatTarget, chatProp, chatReceiver);
              if (chatProp === "complete" && typeof original === "function") {
                const bound = original.bind(chatTarget);
                return function (this: unknown, ...args: any[]): unknown {
                  return _instrumentedComplete(bound as (...a: any[]) => any, chatTarget, args, opts);
                };
              }
              if (chatProp === "stream" && typeof original === "function") {
                const bound = original.bind(chatTarget);
                return function (this: unknown, ...args: any[]): unknown {
                  return _instrumentedStream(bound as (...a: any[]) => any, chatTarget, args, opts);
                };
              }
              return original;
            },
          });
        }
        return chat;
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

function _extractToolCalls(message: unknown): Array<{ id?: string; name?: string }> {
  if (!message || typeof message !== "object") return [];
  const toolCalls = (message as Record<string, unknown>).tool_calls ?? (message as Record<string, unknown>).toolCalls;
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc: any) => ({
    id: typeof tc?.id === "string" ? tc.id : undefined,
    name: typeof tc?.function?.name === "string" ? tc.function.name : undefined,
  }));
}

/** `chat.complete()` — non-streaming. */
function _instrumentedComplete(
  originalComplete: (...args: any[]) => any,
  self: unknown,
  args: any[],
  opts: TraceOptions,
): unknown {
  const start = Date.now();
  const traceId = traceIdOrRandom();
  const eventId = randomId();
  const request = _extractRequest(args);
  const requestModel = typeof request?.model === "string" ? request.model : undefined;
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  let errorMsg: string | undefined;
  let capturedUsage: unknown;
  let responseModel: string | undefined;
  let toolCallCount = 0;
  let toolNames: string[] = [];

  return (async () => {
    try {
      const result = await originalComplete.apply(self, args);
      if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (typeof r.model === "string") responseModel = r.model;
        if (r.usage && typeof r.usage === "object") capturedUsage = r.usage;
        const choices = r.choices;
        if (Array.isArray(choices) && choices[0]) {
          const toolCalls = _extractToolCalls((choices[0] as Record<string, unknown>).message);
          toolCallCount = toolCalls.length;
          toolNames = toolCalls.map((t) => t.name).filter((n): n is string => !!n);
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
        eventId,
        traceId,
        model: responseModel ?? requestModel,
        durationMs,
        status,
        errorType,
        errorMessage: errorMsg,
        opts,
        usage: capturedUsage,
        toolCallCount,
        toolNames,
      });
    }
  })();
}

/** `chat.stream()` — returns `EventStream<CompletionEvent>`; each event's `.data` is the `CompletionChunk`. */
function _instrumentedStream(
  originalStream: (...args: any[]) => any,
  self: unknown,
  args: any[],
  opts: TraceOptions,
): unknown {
  const request = _extractRequest(args);
  const requestModel = typeof request?.model === "string" ? request.model : undefined;
  return (async () => {
    const upstream = await originalStream.apply(self, args);
    return _wrapMistralStream(upstream, opts, requestModel);
  })();
}

async function* _wrapMistralStream(
  upstream: AsyncIterable<any>,
  opts: TraceOptions,
  requestModel: string | undefined,
): AsyncIterable<any> {
  const start = Date.now();
  const traceId = traceIdOrRandom();
  const eventId = `stream_mistral_${randomId()}`;
  let tFirst: number | null = null;
  let tPrev: number | null = null;
  let tLast = start;
  let itlSumMs = 0;
  let itlCount = 0;
  let outputTokens = 0;
  let errorMsg: string | undefined;
  let usageOutputTokens: number | undefined;
  let usageInputTokens: number | undefined;
  let finishReason: string | undefined;
  let chunkCount = 0;
  let model: string | undefined;
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  const toolCallNames = new Map<number, string>();

  const client = getDefaultClient();
  const config = client.getConfig();
  const chunkBuffer: StreamChunk[] = [];
  const bufferedTags = [...(opts.tags ?? []), "auto_instrument", "streaming"];

  try {
    for await (const event of upstream) {
      // Each SSE event wraps the actual completion chunk under
      // ``.data`` — the one shape difference from OpenAI/Groq.
      const chunk = event && typeof event === "object" && "data" in event ? (event as any).data : event;
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

      const choice = chunk?.choices?.[0];
      const text: string | undefined = choice?.delta?.content;
      if (typeof text === "string" && text) outputTokens += Math.max(1, Math.floor(text.length / 4));
      if (choice?.finish_reason || choice?.finishReason) finishReason = choice.finish_reason ?? choice.finishReason;
      if (!model && chunk?.model) model = chunk.model;
      const deltaToolCalls = choice?.delta?.tool_calls ?? choice?.delta?.toolCalls;
      if (Array.isArray(deltaToolCalls)) {
        for (const tc of deltaToolCalls) {
          const idx = typeof tc?.index === "number" ? tc.index : 0;
          const name = tc?.function?.name;
          if (typeof name === "string" && name.length > 0 && !toolCallNames.has(idx)) {
            toolCallNames.set(idx, name);
          }
        }
      }
      const usage = chunk?.usage;
      if (usage) {
        const u = extractUsage(usage);
        if (u.outputTokens !== null && u.outputTokens > 0) usageOutputTokens = u.outputTokens;
        if (u.inputTokens !== null) usageInputTokens = u.inputTokens;
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
    if (typeof usageOutputTokens === "number") outputTokens = usageOutputTokens;
    const ttftMs = tFirst !== null ? tFirst - start : 0;
    const completionDurationMs = tLast - start;
    const itlMsAvg = itlCount > 0 ? itlSumMs / itlCount : 0;
    const tpotMs = outputTokens > 1 ? (completionDurationMs - ttftMs) / (outputTokens - 1) : 0;
    const finalModel = model ?? requestModel;

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
        provider: "mistral",
        model: finalModel,
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
        ...(typeof usageInputTokens === "number" ? { input_tokens: usageInputTokens } : {}),
      },
      modelNormalized: finalModel ? (normalizeModelName(finalModel) ?? undefined) : undefined,
      tags: bufferedTags,
      environmentId: opts.environmentId,
      durationMs: completionDurationMs,
    });

    for (const chunk of chunkBuffer) {
      client.bufferChunk(chunk);
    }
  }
}

function _emitCompletion(args: {
  eventId: string;
  traceId: string;
  model: string | undefined;
  durationMs: number;
  status: "success" | "error";
  errorType: string | undefined;
  errorMessage?: string | undefined;
  opts: TraceOptions;
  usage?: unknown;
  toolCallCount: number;
  toolNames: string[];
}): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  const usageFields: Record<string, number> = {};
  if (args.usage) {
    const u = extractUsage(args.usage);
    if (u.inputTokens !== null) usageFields.input_tokens = u.inputTokens;
    if (u.outputTokens !== null) usageFields.output_tokens = u.outputTokens;
    if (u.cacheReadTokens !== null) usageFields.cache_read_input_tokens = u.cacheReadTokens;
    if (u.cacheCreationTokens !== null) usageFields.cache_creation_input_tokens = u.cacheCreationTokens;
  }
  client.emit({
    eventId: args.eventId,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    traceId: args.traceId,
    realm: config.realm,
    eventType: "llm_completion",
    timestamp: new Date().toISOString(),
    sourceFormat: SOURCE_FORMAT,
    payload: {
      provider: "mistral",
      model: args.model,
      duration_ms: args.durationMs,
      status: args.status,
      error_type: args.errorType,
      ...(args.errorMessage !== undefined ? { error_message: args.errorMessage } : {}),
      tool_call_count: args.toolCallCount,
      ...(args.toolNames.length > 0 ? { tool_names: args.toolNames } : {}),
      environment_id: args.opts.environmentId,
    },
    metrics: { duration_ms: args.durationMs, ...usageFields },
    modelNormalized: args.model ? (normalizeModelName(args.model) ?? undefined) : undefined,
    tags: [...(args.opts.tags ?? []), "auto_instrument"],
    environmentId: args.opts.environmentId,
    durationMs: args.durationMs,
  });
}
