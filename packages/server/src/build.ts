import { ContextPartner, GATE_MODULE, ItemCache, pooledSanitizer, type TraceSink } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, OpenRouterModel, type Model } from "@eden/llm";
import { WorkerPool } from "@eden/primitives";
import { SourceFanout, type SourceResolver } from "@eden/sources";

export interface BuildOptions {
  sources: SourceResolver;
  sourceMapPath?: string;
  model?: Model | null;
  onTrace?: TraceSink;
  /** A pool from `startGatePool`: lookup results are redacted in it. Without one they are redacted on the loop. */
  gatePool?: WorkerPool;
}

/** Wires a partner from its parts with production defaults. */
export function buildPartner(options: BuildOptions): ContextPartner {
  return new ContextPartner({
    sources: options.sources,
    sourceMap: new SourceMap(options.sourceMapPath),
    cache: new ItemCache(),
    budget: new Budget(),
    model: options.model === undefined ? OpenRouterModel.fromEnv() : options.model,
    onTrace: options.onTrace,
    fanout: options.gatePool && new SourceFanout({ sanitize: pooledSanitizer(options.gatePool) }),
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
