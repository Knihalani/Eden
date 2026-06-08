/**
 * Eden TypeScript runtime SDK — `trace()` and `traceAgent()`.
 *
 * Mirrors the Python SDK's `trace_agent` decorator:
 *
 *   - `traceAgent(opts)` — class-method decorator (TS equivalent of
 *     Python's `@trace_agent(...)`).
 *   - `trace(name, fn, opts)` — async helper that returns the
 *     function's result while emitting a single
 *     `agent_call` event with timing + status.
 *
 * Tracing never breaks the wrapped function. All errors from the
 * telemetry path are caught and logged at debug level.
 */

import { randomUUID } from "node:crypto";
import { getDefaultClient } from "./client.js";
import { SOURCE_FORMATS, type TraceOptions } from "./types.js";

/**
 * Public trace context — same shape as the Python SDK's
 * `TraceContext` dataclass.
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  startMs: number;
}

function newContext(): TraceContext {
  return {
    traceId: randomUUID().slice(0, 24),
    spanId: randomUUID().slice(0, 16),
    startMs: Date.now(),
  };
}

function finishTrace(
  ctx: TraceContext,
  start: number,
  payload: Record<string, unknown>,
  options: TraceOptions,
): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  const durationMs = Date.now() - start;
  client.emit({
    eventId: ctx.traceId,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    traceId: ctx.traceId,
    realm: config.realm,
    eventType: "agent_call",
    timestamp: new Date().toISOString(),
    sourceFormat: SOURCE_FORMATS.TRACE_AGENT,
    payload: {
      ...payload,
      environment_id: options.environmentId,
      ...options.metadata,
    },
    metrics: { duration_ms: durationMs },
    tags: [...config.tags, ...(options.tags ?? [])],
    environmentId: options.environmentId,
    spanId: ctx.spanId,
    name: payload.function as string | undefined,
    durationMs,
  });
}

/**
 * Async helper that traces a single function invocation.
 *
 * ```ts
 * const result = await trace("myAgent", async (ctx) => {
 *   return await llm.chat.completions.create(...);
 * }, { tags: ["prod"] });
 * ```
 */
export async function trace<T>(
  name: string,
  fn: (ctx: TraceContext) => Promise<T>,
  opts: TraceOptions = {},
): Promise<T> {
  const ctx = newContext();
  const start = ctx.startMs;
  let status: "success" | "error" = "success";
  let errorType: string | undefined;
  let resultType: string | undefined;
  try {
    const result = await fn(ctx);
    if (result === null) {
      resultType = "null";
    } else {
      resultType = typeof result;
      if (result && typeof result === "object") {
        resultType = (result as { constructor?: { name?: string } })
          .constructor?.name ?? "object";
      }
    }
    return result;
  } catch (err) {
    status = "error";
    errorType = err instanceof Error ? err.constructor.name : "Error";
    throw err;
  } finally {
    finishTrace(
      ctx,
      start,
      { name, status, error_type: errorType, result_type: resultType },
      opts,
    );
  }
}

// ── traceAgent decorator ─────────────────────────────────────────

/**
 * Build a wrapped method that emits one `agent_call` event per
 * invocation. Shared between Stage-2 and Stage-3 decorator paths.
 */
function makeWrappedMethod(
  propertyKey: string,
  original: (...a: any[]) => any,
  options: TraceOptions,
): (...a: any[]) => any {
  return function (this: unknown, ...args: any[]): unknown {
    const ctx = newContext();
    const start = ctx.startMs;
    const fnName = `${(this as { constructor?: { name?: string } })?.constructor?.name ?? "Anon"}.${propertyKey}`;

    let status: "success" | "error" = "success";
    let errorType: string | undefined;

    const finish = () => {
      finishTrace(
        ctx,
        start,
        { function: fnName, status, error_type: errorType, arg_count: args.length },
        options,
      );
    };

    try {
      const result = original.apply(this, args);
      if (result instanceof Promise) {
        return result
          .catch((err) => {
            status = "error";
            errorType =
              err instanceof Error ? err.constructor.name : "Error";
            throw err;
          })
          .finally(finish);
      }
      finish();
      return result;
    } catch (err) {
      status = "error";
      errorType = err instanceof Error ? err.constructor.name : "Error";
      finish();
      throw err;
    }
  };
}

const __wrappedFlag = Symbol.for("@eden-ai/sdk.traceAgent.wrapped");

/**
 * Class-method decorator that auto-traces a function. Mirrors
 * the Python `@trace_agent()` decorator semantics: returns a
 * wrapped method that emits one `agent_call` event per call.
 *
 * Supports both legacy (Stage 2) and current (Stage 3) decorator
 * proposals. Bun's transpiler uses Stage 3 — in that case the
 * descriptor is `undefined` and we install the wrapped method
 * via the `addInitializer` hook.
 *
 * ```ts
 * class MyAgent {
 *   @traceAgent({ tags: ["prod"] })
 *   async run(query: string) {
 *     return await openai.chat.completions.create({ ... });
 *   }
 * }
 * ```
 */
export function traceAgent(options: TraceOptions = {}) {
  return function (
    _targetOrValue: unknown,
    propertyKeyOrContext: string | undefined,
    descriptor: TypedPropertyDescriptor<(...a: any[]) => any> | undefined,
  ): any {
    // Detect which proposal we're running under.
    // - Stage 2 (legacy):  (target, key, descriptor)
    // - Stage 3 (TC39):    (value, context)  — context has `kind`,
    //                      `name`, `addInitializer`, etc.
    const stage3Context =
      propertyKeyOrContext &&
      typeof propertyKeyOrContext === "object" &&
      "addInitializer" in (propertyKeyOrContext as object)
        ? (propertyKeyOrContext as unknown as {
            kind: string;
            name: string;
            addInitializer?: (fn: () => void) => void;
            static?: boolean;
            private?: boolean;
          })
        : undefined;
    const stage2Descriptor =
      !stage3Context &&
      descriptor &&
      typeof (descriptor as TypedPropertyDescriptor<(...a: any[]) => any>).value === "function"
        ? (descriptor as TypedPropertyDescriptor<(...a: any[]) => any>)
        : undefined;

    const propertyKey = stage3Context
      ? stage3Context.name
      : (propertyKeyOrContext as string);

    if (stage2Descriptor) {
      // Stage 2 (legacy) — descriptor.value is the original fn.
      const original = stage2Descriptor.value!;
      stage2Descriptor.value = makeWrappedMethod(propertyKey, original, options);
      return stage2Descriptor;
    }

    if (stage3Context && typeof stage3Context.addInitializer === "function") {
      if (stage3Context.private === true) return; // unsupported
      const isStatic = stage3Context.static === true;
      stage3Context.addInitializer(function (this: any) {
        // Bun binds `this` to the prototype (for instance methods)
        // and to the constructor (for static methods). The
        // canonical TC39 spec says `this` is the class. Handle
        // both: if the value has a `prototype` property, use it
        // as the class; otherwise treat it as the prototype.
        const target: Record<string, any> = isStatic
          ? this
          : this && typeof this === "object" && "prototype" in this
            ? (this as { prototype: Record<string, any> }).prototype
            : this;
        const original = (target as Record<string, any>)[propertyKey];
        if (typeof original !== "function") return;
        if ((original as any)[__wrappedFlag] === true) return;
        const wrapped = makeWrappedMethod(propertyKey, original, options);
        (wrapped as any)[__wrappedFlag] = true;
        (target as Record<string, any>)[propertyKey] = wrapped;
      });
      return;
    }

    return;
  };
}

/**
 * Configure the default SDK client. Convenience wrapper that
 * sets options on the singleton returned by `getDefaultClient()`.
 */
export function configure(opts: import("./types.js").EdenSDKOptions): void {
  getDefaultClient().configure(opts);
}
