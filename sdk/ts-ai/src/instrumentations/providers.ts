/**
 * Bedrock + Gemini proxy wrappers (TS).
 * No AWS/Google SDKs required at install time — wrap client-like objects.
 */

import { getDefaultClient } from "../client.js";
import { errorClass, errorMessage, randomId } from "../ids.js";
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
}): void {
  const client = getDefaultClient();
  const config = client.getConfig();
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
    attributes: {
      provider: args.provider,
      ...(args.model ? { model: args.model } : {}),
    },
    tags: [args.provider, ...(args.opts.tags ?? [])],
    environmentId: args.opts.environmentId,
  });
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
      emitProviderEvent({
        provider: meta.provider,
        name: meta.name,
        model,
        durationMs: Date.now() - start,
        outcome: "success",
        opts,
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
