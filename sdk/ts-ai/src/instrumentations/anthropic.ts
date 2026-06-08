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
import { SOURCE_FORMATS, type TraceOptions } from "../types.js";

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
                return function (this: unknown, ...args: any[]): unknown {
                  return _instrumentedCreate(
                    original as (...a: any[]) => any,
                    target,
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

  return Promise.resolve()
    .then(() => originalCreate.apply(self, args))
    .catch((err: unknown) => {
      status = "error";
      errorType = err instanceof Error ? err.constructor.name : "Error";
      throw err;
    })
    .finally(() => {
      const durationMs = Date.now() - start;
      const client = getDefaultClient();
      const config = client.getConfig();
      client.emit({
        eventId: traceId,
        tenantId: config.orgId ?? "default",
        projectId: config.projectId,
        traceId,
        realm: config.realm,
        eventType: "llm_completion",
        timestamp: new Date().toISOString(),
        sourceFormat: SOURCE_FORMATS.ANTHROPIC,
        payload: {
          provider: "anthropic",
          model: _extractModel(args),
          duration_ms: durationMs,
          status,
          error_type: errorType,
          environment_id: opts.environmentId,
        },
        metrics: { duration_ms: durationMs },
        tags: [...(opts.tags ?? []), "auto_instrument"],
        environmentId: opts.environmentId,
        durationMs,
      });
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
  let finishReason: string | undefined;
  let chunkCount = 0;
  let model: string | undefined;
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  const tags = [...(opts.tags ?? []), "auto_instrument", "streaming"];

  try {
    const upstream: AsyncIterable<any> = await originalCreate.apply(self, args);
    for await (const event of upstream) {
      chunkCount += 1;
      const now = Date.now();
      tLast = now;
      if (tFirst === null) tFirst = now;
      else if (tPrev !== null) {
        itlSumMs += now - tPrev;
        itlCount += 1;
      }
      tPrev = now;

      const etype = event?.type;
      if (etype === "content_block_delta") {
        const delta = event?.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          outputTokens += Math.max(1, Math.floor(delta.text.length / 4));
        }
      } else if (etype === "message_delta") {
        const delta = event?.delta;
        if (delta?.stop_reason) finishReason = delta.stop_reason;
        const usage = event?.usage;
        if (usage && typeof usage.output_tokens === "number" && usage.output_tokens > 0) {
          usageOutputTokens = usage.output_tokens;
        }
      } else if (etype === "message_start") {
        const msg = event?.message;
        if (msg) {
          if (typeof msg.model === "string") model = msg.model;
          const usage = msg.usage;
          if (usage && typeof usage.input_tokens === "number") {
            usageInputTokens = usage.input_tokens;
          }
        }
      }

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
      },
      tags,
      environmentId: opts.environmentId,
      durationMs: completionDurationMs,
    });
  }
}

function randomId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}${rand}`.slice(0, 24);
}
