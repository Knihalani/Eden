/**
 * LangGraph auto-instrumentation.
 *
 * `wrapLangGraph(graph, opts)` wraps a LangGraph `CompiledGraph` (or any
 * `@langchain/langgraph` `Pregel`-shaped instance) so each invocation and
 * streamed node update emits `graph.node_start` / `graph.node_end` events
 * with node names and state keys.
 *
 * Mirrors the Python SDK's `instrumentations/langgraph.py`. The wrapper is
 * dependency-free: any object exposing `invoke` / `stream` methods is
 * accepted. When `@langchain/langgraph` is not installed the function is
 * still importable and returns non-object arguments unchanged (no-op).
 */

import { getDefaultClient } from "../client.js";
import { randomId, traceIdOrRandom } from "../ids.js";
import type { TraceOptions } from "../types.js";

const WRAP_MARKER = Symbol.for("@eden-ai/sdk.wrapLangGraph");

function _stateKeys(state: unknown): string[] {
  if (!state || typeof state !== "object") return [];
  try {
    return Object.keys(state as object).sort();
  } catch {
    return [];
  }
}

function _graphName(graph: object): string {
  const g = graph as Record<string, unknown>;
  for (const attr of ["name", "graphName", "_graph_name"]) {
    if (g[attr] && typeof g[attr] === "string") return g[attr] as string;
  }
  const cls = graph.constructor?.name ?? "";
  return cls.replace(/^Compiled/i, "").toLowerCase() || "langgraph-graph";
}

function _emitNodeEvent(opts: {
  eventType: string;
  nodeName: string;
  graphName: string;
  stateKeys: string[];
  durationMs: number;
  outcome: "running" | "success" | "error";
  error?: string;
  traceOpts: TraceOptions;
}): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  const attributes: Record<string, unknown> = {
    "langgraph.framework": "langgraph",
    "langgraph.node": opts.nodeName,
    "langgraph.state_keys": opts.stateKeys,
  };
  if (opts.error) attributes["langgraph.error"] = opts.error;
  client.emit({
    eventId: `eden_lg_${randomId()}`,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    traceId: traceIdOrRandom(),
    realm: config.realm,
    // Use the literal string so ingest-format.ts routes it to the
    // webhook path (not OTel). Mirrors Python's source_format="webhook".
    eventType: opts.eventType as Parameters<typeof client.emit>[0]["eventType"],
    timestamp: new Date().toISOString(),
    name: `${opts.graphName}.${opts.nodeName}`,
    durationMs: opts.durationMs,
    sourceFormat: "webhook",
    payload: {
      outcome: opts.outcome,
      agent_id: opts.graphName,
      ...(opts.error ? { error: opts.error } : {}),
    },
    attributes,
    tags: ["langgraph", "framework", ...(opts.traceOpts.tags ?? [])],
    environmentId: opts.traceOpts.environmentId,
  });
}

/**
 * Wrap a LangGraph `CompiledGraph` (or any Pregel-shaped object) so that
 * `invoke` and `stream` calls emit `graph.node_start` / `graph.node_end`
 * framework events.
 *
 * Re-wrapping the same instance is a no-op (returns the same proxy).
 *
 * @example
 * ```ts
 * import { wrapLangGraph } from "@eden-ai/sdk/instrumentations/langgraph";
 * const graph = wrapLangGraph(workflow.compile());
 * const result = await graph.invoke({ messages: [] });
 * ```
 */
export function wrapLangGraph<T extends object>(
  graph: T,
  opts: TraceOptions = {},
): T {
  if (!graph || typeof graph !== "object") return graph;
  // Already wrapped — return as-is.
  if ((graph as unknown as { [k: symbol]: unknown })[WRAP_MARKER] === true) {
    return graph;
  }

  const gname = _graphName(graph);

  const proxy = new Proxy(graph, {
    get(target, prop, receiver) {
      if (prop === WRAP_MARKER) return true;

      // ── invoke (non-streaming, returns Promise<state>) ────────────────
      if (prop === "invoke") {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function") return original;
        return async function (
          this: unknown,
          input: unknown,
          ...rest: unknown[]
        ): Promise<unknown> {
          const inKeys = _stateKeys(input);
          _emitNodeEvent({
            eventType: "graph.node_start",
            nodeName: gname,
            graphName: gname,
            stateKeys: inKeys,
            durationMs: 0,
            outcome: "running",
            traceOpts: opts,
          });
          const t0 = Date.now();
          try {
            const result = await (
              original as (...a: unknown[]) => Promise<unknown>
            ).apply(this, [input, ...rest]);
            _emitNodeEvent({
              eventType: "graph.node_end",
              nodeName: gname,
              graphName: gname,
              stateKeys: _stateKeys(result),
              durationMs: Date.now() - t0,
              outcome: "success",
              traceOpts: opts,
            });
            return result;
          } catch (err) {
            _emitNodeEvent({
              eventType: "graph.node_end",
              nodeName: gname,
              graphName: gname,
              stateKeys: inKeys,
              durationMs: Date.now() - t0,
              outcome: "error",
              error: err instanceof Error ? err.message : String(err),
              traceOpts: opts,
            });
            throw err;
          }
        };
      }

      // ── stream (returns AsyncIterable<{nodeName: stateUpdate}>) ───────
      if (prop === "stream") {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function") return original;
        // Return an async generator function that wraps the original.
        return function (
          this: unknown,
          input: unknown,
          ...rest: unknown[]
        ): AsyncIterable<unknown> {
          const self = this;
          return (async function* () {
            const iter = (
              original as (
                ...a: unknown[]
              ) => AsyncIterable<unknown> | Iterable<unknown>
            ).apply(self, [input, ...rest]);
            // Unify sync and async iterables.
            for await (const chunk of iter) {
              // LangGraph JS streams {nodeName: stateUpdate} dicts in
              // "updates" mode (one key per chunk = the just-executed
              // node).  "values" mode yields full state snapshots with
              // no meaningful per-node key; treat as a graph-level event.
              if (chunk && typeof chunk === "object") {
                const entries = Object.entries(
                  chunk as Record<string, unknown>,
                );
                if (entries.length > 0) {
                  const t0 = Date.now();
                  for (const [nodeName, nodeState] of entries) {
                    _emitNodeEvent({
                      eventType: "graph.node_start",
                      nodeName,
                      graphName: gname,
                      stateKeys: _stateKeys(nodeState),
                      durationMs: 0,
                      outcome: "running",
                      traceOpts: opts,
                    });
                  }
                  yield chunk;
                  const elapsed = Date.now() - t0;
                  for (const [nodeName, nodeState] of entries) {
                    _emitNodeEvent({
                      eventType: "graph.node_end",
                      nodeName,
                      graphName: gname,
                      stateKeys: _stateKeys(nodeState),
                      durationMs: elapsed,
                      outcome: "success",
                      traceOpts: opts,
                    });
                  }
                } else {
                  // Empty object or unknown shape — emit graph-level event.
                  const t0 = Date.now();
                  _emitNodeEvent({
                    eventType: "graph.node_start",
                    nodeName: gname,
                    graphName: gname,
                    stateKeys: _stateKeys(chunk),
                    durationMs: 0,
                    outcome: "running",
                    traceOpts: opts,
                  });
                  yield chunk;
                  _emitNodeEvent({
                    eventType: "graph.node_end",
                    nodeName: gname,
                    graphName: gname,
                    stateKeys: _stateKeys(chunk),
                    durationMs: Date.now() - t0,
                    outcome: "success",
                    traceOpts: opts,
                  });
                }
              } else {
                // Non-object chunk (scalar / null) — pass through unchanged.
                yield chunk;
              }
            }
          })();
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });

  // Mark the proxy itself so re-wrapping is a no-op.
  try {
    (proxy as unknown as { [k: symbol]: unknown })[WRAP_MARKER] = true;
  } catch {
    // Some Proxy traps may reject this set — ignore safely.
  }
  return proxy;
}
