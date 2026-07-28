/**
 * Mastra auto-instrumentation.
 *
 * `wrapMastra(mastra, opts)` wraps a Mastra instance so agent and
 * workflow executions emit `agent.run` framework events with
 * `source_format: mastra`.
 */

import { getDefaultClient } from "../client.js";
import { randomId, traceIdOrRandom } from "../ids.js";
import { type TraceOptions } from "../types.js";

const _wrapped = new WeakSet<object>();
const WRAP_MARKER = Symbol.for("@eden-ai/sdk.wrapMastra");

export function wrapMastra<T extends object>(
  mastra: T,
  opts: TraceOptions = {},
): T {
  if (!mastra || typeof mastra !== "object") return mastra;
  if (_wrapped.has(mastra)) return mastra;
  const marked = (mastra as unknown as { [k: symbol]: unknown })[WRAP_MARKER];
  if (marked === true) return mastra;
  _wrapped.add(mastra);

  const proxy = new Proxy(mastra, {
    get(target, prop, receiver) {
      if (prop === WRAP_MARKER) return true;
      if (prop === "getAgent") {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function") return original;
        return function (this: unknown, ...args: unknown[]) {
          const agent = (original as (...a: unknown[]) => unknown).apply(this, args);
          return _wrapAgent(agent, opts, String(args[0] ?? "agent"));
        };
      }
      if (prop === "getWorkflow") {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function") return original;
        return function (this: unknown, ...args: unknown[]) {
          const workflow = (original as (...a: unknown[]) => unknown).apply(this, args);
          return _wrapWorkflow(workflow, opts, String(args[0] ?? "workflow"));
        };
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

function _wrapAgent(agent: unknown, opts: TraceOptions, name: string): unknown {
  if (!agent || typeof agent !== "object") return agent;
  return new Proxy(agent as object, {
    get(target, prop, receiver) {
      if (
        typeof prop === "string" &&
        ["generate", "stream", "run", "execute"].includes(prop)
      ) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function") return original;
        return async function (this: unknown, ...args: unknown[]) {
          const start = Date.now();
          try {
            const result = await (original as (...a: unknown[]) => Promise<unknown>).apply(
              this,
              args,
            );
            _emitMastraEvent({
              name,
              kind: `agent.${prop}`,
              durationMs: Date.now() - start,
              outcome: "success",
              opts,
            });
            return result;
          } catch (err) {
            _emitMastraEvent({
              name,
              kind: `agent.${prop}`,
              durationMs: Date.now() - start,
              outcome: "error",
              error: err instanceof Error ? err.message : String(err),
              opts,
            });
            throw err;
          }
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function _wrapWorkflow(
  workflow: unknown,
  opts: TraceOptions,
  name: string,
): unknown {
  if (!workflow || typeof workflow !== "object") return workflow;
  return new Proxy(workflow as object, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && ["execute", "run", "start"].includes(prop)) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function") return original;
        return async function (this: unknown, ...args: unknown[]) {
          const start = Date.now();
          try {
            const result = await (original as (...a: unknown[]) => Promise<unknown>).apply(
              this,
              args,
            );
            _emitMastraEvent({
              name,
              kind: `workflow.${prop}`,
              durationMs: Date.now() - start,
              outcome: "success",
              opts,
            });
            return result;
          } catch (err) {
            _emitMastraEvent({
              name,
              kind: `workflow.${prop}`,
              durationMs: Date.now() - start,
              outcome: "error",
              error: err instanceof Error ? err.message : String(err),
              opts,
            });
            throw err;
          }
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function _emitMastraEvent(args: {
  name: string;
  kind: string;
  durationMs: number;
  outcome: "success" | "error";
  error?: string;
  opts: TraceOptions;
}): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  client.emit({
    eventId: `eden_mastra_${randomId()}`,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    // Joins an active outer ``trace()``/``traceAgent()`` span when
    // one is running, falling back to a fresh random id otherwise.
    // ``eventId`` above stays independently random, so it can never
    // collide even when ``traceId`` is shared.
    traceId: traceIdOrRandom(),
    realm: config.realm,
    eventType: "agent.run",
    timestamp: new Date().toISOString(),
    sourceFormat: "mastra",
    name: args.name,
    durationMs: args.durationMs,
    payload: {
      outcome: args.outcome,
      kind: args.kind,
      ...(args.error ? { error: args.error } : {}),
    },
    attributes: {
      "mastra.kind": args.kind,
      ...(args.error ? { "mastra.error": args.error } : {}),
    },
    tags: ["mastra", "framework", ...(args.opts.tags ?? [])],
    environmentId: args.opts.environmentId,
  });
}
