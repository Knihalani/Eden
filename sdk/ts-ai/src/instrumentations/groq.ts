/**
 * Groq auto-instrumentation.
 *
 * Groq's official TypeScript SDK (`groq-sdk`) is a Stainless-generated
 * client whose `chat.completions.create` surface is byte-for-byte
 * shaped like OpenAI's — same request/response schema, same streaming
 * chunk shape, same `usage.prompt_tokens` / `usage.completion_tokens`
 * naming. Previously Groq calls were only reachable via the generic
 * host-sniffing HTTP-capture path (no structured streaming-delta
 * parsing, no tool-call parsing, no per-field usage extraction). This
 * module gives Groq its own native wrapper — mirroring
 * `openai.ts`'s `wrapOpenAI` — instead of aliasing through it, so a
 * future Groq-specific response field (e.g. `x_groq`, `usage_breakdown`)
 * can be added here without touching the OpenAI wrapper.
 *
 * `wrapGroq(client, opts)` returns a Proxy that wraps the user's Groq
 * client instance. Every call to `client.chat.completions.create({...})`
 * is intercepted:
 *
 *   - Non-streaming calls → one `llm_completion` event after the
 *     response resolves (or throws).
 *   - Streaming calls (`stream: true`) → the returned async iterable
 *     is wrapped to sample per-chunk timing; one
 *     `llm_completion_stream` event is emitted after the iterator
 *     exhausts.
 *
 * Tool calls: Groq's `message.tool_calls` (non-streaming) and
 * `delta.tool_calls` (streaming, keyed by `index`) are counted and
 * their function names collected onto the emitted payload — mirrors
 * the Python SDK's `_extract_groq_tool_calls`.
 */

import { getDefaultClient } from "../client.js";
import { errorClass, errorMessage, randomId, traceIdOrRandom } from "../ids.js";
import { extractUsage, normalizeModelName } from "../tokens.js";
import type { StreamChunk, TraceOptions } from "../types.js";

const SOURCE_FORMAT = "groq";

// original → proxy (and proxy → proxy) so re-wrapping the same
// client returns the instrumented Proxy, not the bare original.
const _proxies = new WeakMap<object, object>();
const WRAP_MARKER = Symbol.for("@eden-ai/sdk.wrapGroq");

/**
 * Wrap a Groq client (or any object that exposes
 * `client.chat.completions.create`) with a Proxy that instruments
 * every call. Idempotent: calling twice on the same client returns
 * the same Proxy.
 */
export function wrapGroq<T extends object>(client: T, opts: TraceOptions = {}): T {
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
        if (chat && typeof chat === "object" && (chat as { completions?: unknown }).completions) {
          return new Proxy(chat, {
            get(chatTarget, chatProp, chatReceiver) {
              if (chatProp === "completions") {
                const completions = Reflect.get(chatTarget, chatProp, chatReceiver);
                if (
                  completions &&
                  typeof completions === "object" &&
                  typeof (completions as { create?: unknown }).create === "function"
                ) {
                  return new Proxy(completions, {
                    get(compTarget, compProp, compReceiver) {
                      if (compProp === "create") {
                        const original = Reflect.get(compTarget, compProp, compReceiver);
                        if (typeof original !== "function") return original;
                        // Bind to the resource object (``completions``),
                        // not the top-level client — the Groq SDK
                        // internally calls ``this._client.post(...)``
                        // (same Stainless codegen pattern as OpenAI).
                        const bound = original.bind(compTarget);
                        return function (this: unknown, ...args: any[]): unknown {
                          return _instrumentedCreate(bound as (...a: any[]) => any, compTarget, args, opts);
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
  const isStream = _isStreaming(args);
  if (isStream) {
    return _wrapGroqStream(originalCreate, self, args, opts);
  }

  const start = Date.now();
  // ``traceId`` joins an active outer ``trace()``/``traceAgent()``
  // span when one is running, falling back to a fresh random id
  // otherwise; ``eventId`` stays independently random.
  const traceId = traceIdOrRandom();
  const eventId = randomId();
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  let errorMsg: string | undefined;
  let capturedUsage: unknown = undefined;
  let toolCallCount = 0;
  let toolNames: string[] = [];

  return (async () => {
    try {
      const result = await originalCreate.apply(self, args);
      if (result && typeof result === "object") {
        const maybeUsage = (result as { usage?: unknown }).usage;
        if (maybeUsage && typeof maybeUsage === "object") capturedUsage = maybeUsage;
        const toolCalls = _extractToolCalls(result);
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
      _emitCompletion({
        eventId,
        traceId,
        model: _extractModel(args),
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

/** Extract `{id, name}` pairs from a non-streaming Groq chat completion's `message.tool_calls`. */
function _extractToolCalls(result: unknown): Array<{ id?: string; name?: string }> {
  if (!result || typeof result !== "object") return [];
  const choices = (result as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices[0]) return [];
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return [];
  const toolCalls = (message as Record<string, unknown>).tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc: any) => ({
    id: typeof tc?.id === "string" ? tc.id : undefined,
    name: typeof tc?.function?.name === "string" ? tc.function.name : undefined,
  }));
}

async function* _wrapGroqStream(
  originalCreate: (...args: any[]) => any,
  self: unknown,
  args: any[],
  opts: TraceOptions,
): AsyncIterable<any> {
  const start = Date.now();
  const traceId = traceIdOrRandom();
  const eventId = `stream_groq_${randomId()}`;
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
  let finishReason: string | undefined;
  let chunkCount = 0;
  let model: string | undefined;
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  // Tool-call fragments are keyed by ``index`` because Groq (like
  // OpenAI) streams each tool call's name/arguments incrementally
  // across multiple chunks rather than in one shot.
  const toolCallNames = new Map<number, string>();

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
      const deltaToolCalls = choice?.delta?.tool_calls;
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
        if (u.cacheReadTokens !== null) usageCacheReadTokens = u.cacheReadTokens;
      }

      chunkBuffer.push({
        eventId,
        traceId,
        chunkIndex: chunkCount - 1,
        deltaText: config.captureChunkText ? (text ?? null) : null,
        ttftMs: tFirst !== null ? tFirst - start : null,
        itlMs: prev !== null ? now - prev : null,
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
      eventId,
      tenantId: config.orgId ?? "default",
      projectId: config.projectId,
      traceId,
      realm: config.realm,
      eventType: "llm_completion_stream",
      timestamp: new Date().toISOString(),
      sourceFormat: SOURCE_FORMAT,
      payload: {
        provider: "groq",
        model,
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
        ...(typeof usageCacheReadTokens === "number" ? { cache_read_input_tokens: usageCacheReadTokens } : {}),
      },
      modelNormalized: model ? (normalizeModelName(model) ?? undefined) : undefined,
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
      provider: "groq",
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
