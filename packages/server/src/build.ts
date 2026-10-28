import { ContextPartner, GATE_MODULE, ItemCache, type ShadowSink, type TraceSink } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, OpenRouterModel, type Model } from "@eden/llm";
import { WorkerPool } from "@eden/primitives";
import { QueryPlanner, type SourceResolver } from "@eden/sources";

export interface BuildOptions {
  sources: SourceResolver;
  sourceMapPath?: string;
  model?: Model | null;
  onTrace?: TraceSink;
  /** A pool from `startGatePool`: lookup results are redacted in it. Without one they are redacted on the loop. */
  gatePool?: WorkerPool;
  /** The query planner (D28): serving by default (D33), in shadow, or off; its learning persists in the source map. */
  queryPlanner?: "off" | "serve" | "shadow";
  onShadow?: ShadowSink;
}

/** Wires a partner from its parts with production defaults. */
export function buildPartner(options: BuildOptions): ContextPartner {
  const sourceMap = new SourceMap(options.sourceMapPath);
  return new ContextPartner({
    sources: options.sources,
    sourceMap,
    cache: new ItemCache(),
    budget: new Budget(),
    model: options.model === undefined ? OpenRouterModel.fromEnv() : options.model,
    onTrace: options.onTrace,
    gatePool: options.gatePool,
    planner:
      (options.queryPlanner ?? "serve") === "off"
        ? undefined
        : new QueryPlanner({
            seed: (Math.random() * 2 ** 32) >>> 0,
            store: sourceMap,
            mode: options.queryPlanner ?? "serve",
          }),
    onShadow: options.onShadow,
  });
}

/**
 * Starts the pool that redacts lookup results (D25), or returns undefined for 0 workers. Items under 1 KB are gated
 * inline (the round trip costs more than the work); a batch running past 500 ms has its worker replaced and its items
 * dropped, which bounds a pathological input.
 */
export async function startGatePool(workers: number): Promise<WorkerPool | undefined> {
  if (workers <= 0) return undefined;
  return WorkerPool.start({
    module: GATE_MODULE,
    size: workers,
    maxQueue: 4_096,
    maxBatch: 32,
    taskTimeoutMs: 500,
    inlineBelow: 1_024,
  });
}
