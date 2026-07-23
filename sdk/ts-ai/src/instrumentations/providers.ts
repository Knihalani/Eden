/**
 * Bedrock + Gemini proxy wrappers (TS).
 * No AWS/Google SDKs required at install time — wrap client-like objects.
 */

import { getDefaultClient } from "../client.js";
import { errorClass, errorMessage, randomId } from "../ids.js";
import { extractUsage, normalizeModelName, type NormalizedUsage } from "../tokens.js";
import type { TraceOptions } from "../types.js";

const BEDROCK_MARKER = Symbol.for("@eden-ai/sdk.wrapBedrock");
const GEMINI_MARKER = Symbol.for("@eden-ai/sdk.wrapGemini");

function emitProviderEvent(args: {
  provider: "bedrock" | "gemini";
  name: string;
  model?: string;
  durationMs: number;
  outcome: "success" | "error";
  error?: unknown;
  opts: TraceOptions;
  usage?: NormalizedUsage;
  totalTokens?: number | null;
}): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  const usageFields: Record<string, number> = {};
  if (args.usage) {
    if (args.usage.inputTokens !== null) usageFields.input_tokens = args.usage.inputTokens;
    if (args.usage.outputTokens !== null) usageFields.output_tokens = args.usage.outputTokens;
    if (args.usage.cacheReadTokens !== null) usageFields.cache_read_input_tokens = args.usage.cacheReadTokens;
    if (args.usage.cacheCreationTokens !== null) usageFields.cache_creation_input_tokens = args.usage.cacheCreationTokens;
  }
  if (typeof args.totalTokens === "number") usageFields.total_tokens = args.totalTokens;
  client.emit({
    eventId: `eden_${args.provider}_${randomId()}`,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    traceId: randomId(),
    realm: config.realm,
    eventType: "llm_completion",
    timestamp: new Date().toISOString(),
    sourceFormat: args.provider,
    name: args.name,
    durationMs: args.durationMs,
    payload: {
      outcome: args.outcome,
      model: args.model,
      ...(args.error
        ? {
            error_type: errorClass(args.error),
            error_message: errorMessage(args.error),
          }
        : {}),
    },
    metrics: { duration_ms: args.durationMs, ...usageFields },
    modelNormalized: args.model ? (normalizeModelName(args.model) ?? undefined) : undefined,
    attributes: {
      provider: args.provider,
      ...(args.model ? { model: args.model } : {}),
    },
    tags: [args.provider, ...(args.opts.tags ?? [])],
    environmentId: args.opts.environmentId,
  });
}

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
};

/** Best-effort decode of a Bedrock `InvokeModel` response body into JSON. */
function decodeBedrockBody(body: unknown): Record<string, unknown> | null {
  try {
    if (body == null) return null;
    if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
    if (body instanceof Uint8Array) {
      return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    }
    if (typeof body === "object") return body as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

/**
 * Extract input/output/cache token counts from a Bedrock response.
 *
 * Covers two shapes:
 *   - Converse / ConverseStream: `{ usage: { inputTokens, outputTokens, ... } }`
 *     directly on the response.
 *   - InvokeModel: usage lives inside the JSON-encoded `body`, and its
 *     field names vary per model family (Anthropic-on-Bedrock mirrors the
 *     native Anthropic shape; Titan and Llama use their own field names).
 */
export function extractBedrockUsage(response: unknown): NormalizedUsage {
  if (!response || typeof response !== "object") return EMPTY_USAGE;
  const r = response as Record<string, unknown>;

  if (r.usage && typeof r.usage === "object") {
    const u = extractUsage(r.usage);
    if (u.inputTokens !== null || u.outputTokens !== null) return u;
  }

  const body = decodeBedrockBody(r.body);
  if (body) {
    if (body.usage && typeof body.usage === "object") {
      const u = extractUsage(body.usage);
      if (u.inputTokens !== null || u.outputTokens !== null) return u;
    }
    // Titan / Llama expose token counts as bespoke top-level fields
    // rather than a nested `usage` object — fold them into the shared
    // `extract_usage`-compatible key names before normalizing.
    const synthetic: Record<string, unknown> = {};
    if (typeof body.inputTextTokenCount === "number") synthetic.input_tokens = body.inputTextTokenCount;
    if (typeof body.prompt_token_count === "number") synthetic.input_tokens = body.prompt_token_count;
    if (typeof body.generation_token_count === "number") synthetic.output_tokens = body.generation_token_count;
    const results = body.results;
    if (Array.isArray(results) && results[0] && typeof results[0] === "object") {
      const tc = (results[0] as Record<string, unknown>).tokenCount;
      if (typeof tc === "number") synthetic.output_tokens = tc;
    }
    if (Object.keys(synthetic).length > 0) return extractUsage(synthetic);
  }
  return EMPTY_USAGE;
}

/** Bedrock's Converse API also reports a provider-computed `totalTokens`. */
function extractBedrockTotalTokens(response: unknown): number | null {
  if (!response || typeof response !== "object") return null;
  const usage = (response as Record<string, unknown>).usage;
  if (usage && typeof usage === "object") {
    const t = (usage as Record<string, unknown>).totalTokens;
    if (typeof t === "number" && Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Extract input/output/cache token counts from a Gemini response's
 * `usageMetadata` (present on both the new `@google/genai` client
 * responses and, nested under `.response`, on the legacy
 * `@google/generative-ai` SDK's `generate_content` result).
 */
export function extractGeminiUsage(response: unknown): NormalizedUsage {
  if (!response || typeof response !== "object") return EMPTY_USAGE;
  const r = response as Record<string, unknown>;
  const direct = r.usageMetadata;
  if (direct && typeof direct === "object") return extractUsage(direct);
  const nestedResponse = r.response;
  if (nestedResponse && typeof nestedResponse === "object") {
    const nested = (nestedResponse as Record<string, unknown>).usageMetadata;
    if (nested && typeof nested === "object") return extractUsage(nested);
  }
  return EMPTY_USAGE;
}

function extractGeminiTotalTokens(response: unknown): number | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  const meta =
    (r.usageMetadata as Record<string, unknown> | undefined) ??
    ((r.response as Record<string, unknown> | undefined)?.usageMetadata as
      | Record<string, unknown>
      | undefined);
  if (meta) {
    const t = meta.totalTokenCount;
    if (typeof t === "number" && Number.isFinite(t)) return t;
  }
  return null;
}

function wrapMethod(
  original: (...a: unknown[]) => unknown,
  meta: { provider: "bedrock" | "gemini"; name: string; modelKey?: string },
  opts: TraceOptions,
): (...a: unknown[]) => unknown {
  return async function (this: unknown, ...args: unknown[]) {
    const start = Date.now();
    const first = args[0];
    let model: string | undefined;
    if (first && typeof first === "object") {
      const o = first as Record<string, unknown>;
      const key = meta.modelKey ?? "modelId";
      const v = o[key] ?? o.model ?? o.modelId;
      if (typeof v === "string") model = v;
    }
    try {
      const result = await Promise.resolve(original.apply(this, args));
      const usage =
        meta.provider === "bedrock" ? extractBedrockUsage(result) : extractGeminiUsage(result);
      const totalTokens =
        meta.provider === "bedrock"
          ? extractBedrockTotalTokens(result)
          : extractGeminiTotalTokens(result);
      emitProviderEvent({
        provider: meta.provider,
        name: meta.name,
        model,
        durationMs: Date.now() - start,
        outcome: "success",
        opts,
        usage,
        totalTokens,
      });
      return result;
    } catch (err) {
      emitProviderEvent({
        provider: meta.provider,
        name: meta.name,
        model,
        durationMs: Date.now() - start,
        outcome: "error",
        error: err,
        opts,
      });
      throw err;
    }
  };
}

/** Wrap a BedrockRuntime client (`send` / `invokeModel` / `converse`). */
export function wrapBedrock<T extends object>(client: T, opts: TraceOptions = {}): T {
  if (!client || typeof client !== "object") return client;
  const marked = (client as unknown as { [k: symbol]: unknown })[BEDROCK_MARKER];
  if (marked === true) return client;

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === BEDROCK_MARKER) return true;
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        typeof value === "function" &&
        ["send", "invokeModel", "converse", "InvokeModel", "Converse"].includes(prop)
      ) {
        return wrapMethod(
          value.bind(target) as (...a: unknown[]) => unknown,
          { provider: "bedrock", name: `bedrock.${prop}`, modelKey: "modelId" },
          opts,
        );
      }
      return value;
    },
  });
  try {
    (proxy as unknown as { [k: symbol]: unknown })[BEDROCK_MARKER] = true;
  } catch {
    // ignore
  }
  return proxy;
}

/** Wrap a Gemini / Vertex client (`generateContent` / `models.generateContent`). */
export function wrapGemini<T extends object>(client: T, opts: TraceOptions = {}): T {
  if (!client || typeof client !== "object") return client;
  const marked = (client as unknown as { [k: symbol]: unknown })[GEMINI_MARKER];
  if (marked === true) return client;

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === GEMINI_MARKER) return true;
      if (prop === "models") {
        const models = Reflect.get(target, prop, receiver);
        if (models && typeof models === "object") {
          return new Proxy(models as object, {
            get(mTarget, mProp, mReceiver) {
              const mVal = Reflect.get(mTarget, mProp, mReceiver);
              if (
                typeof mProp === "string" &&
                typeof mVal === "function" &&
                ["generateContent", "generateContentStream"].includes(mProp)
              ) {
                return wrapMethod(
                  mVal.bind(mTarget) as (...a: unknown[]) => unknown,
                  {
                    provider: "gemini",
                    name: `gemini.${mProp}`,
                    modelKey: "model",
                  },
                  opts,
                );
              }
              return mVal;
            },
          });
        }
      }
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        typeof value === "function" &&
        ["generateContent", "generate_content"].includes(prop)
      ) {
        return wrapMethod(
          value.bind(target) as (...a: unknown[]) => unknown,
          { provider: "gemini", name: `gemini.${prop}`, modelKey: "model" },
          opts,
        );
      }
      return value;
    },
  });
  try {
    (proxy as unknown as { [k: symbol]: unknown })[GEMINI_MARKER] = true;
  } catch {
    // ignore
  }
  return proxy;
}
