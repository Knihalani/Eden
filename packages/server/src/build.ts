import {
  ContextPartner,
  GATE_MODULE,
  ItemCache,
  type EngineConfig,
  type ShadowSink,
  type TraceSink,
} from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, OpenRouterModel, type Model } from "@eden/llm";
import { WorkerPool } from "@eden/primitives";
import { QueryPlanner, type SourceResolver } from "@eden/sources";

export interface BuildOptions {
  sources: SourceResolver;
  sourceMapPath?: string;
  /** An open source map (from `openSourceMap`); `sourceMapPath` is ignored when this is set. */
  sourceMap?: SourceMap;
  model?: Model | null;
  onTrace?: TraceSink;
  /** A pool from `startGatePool`: lookup results are redacted in it. Without one they are redacted on the loop. */
  gatePool?: WorkerPool;
  /** The query planner (D28): serving by default (D33), in shadow, or off; its learning persists in the source map. */
  queryPlanner?: "off" | "serve" | "shadow";
  onShadow?: ShadowSink;
  /**
   * Background connector sync (D57, experimental, off by default): sources with a list tool are read into each
   * active user's cache in the background, on a one-minute timer, and lookups answer them locally.
   */
  sync?: boolean;
  /**
   * Engine settings over the production defaults, for an embedding or a deployment that opts into experimental flags:
   * the action firewall (`actionCheck`, D69, behind `POST /v1/check`) finds only on the grounds these turn on
   * (`probes`, `groundConflict`, `groundAway`, `graph`, `cards`). The servers pass what EDEN_ENGINE_CONFIG names
   * (D103, engine-config.ts), `{}` when it is unset. `sync: true` here also starts the sync timer.
   */
  engine?: Partial<EngineConfig>;
}

/** Wires a partner from its parts with production defaults. */
export function buildPartner(options: BuildOptions): ContextPartner {
  const sourceMap = options.sourceMap ?? new SourceMap(options.sourceMapPath);
  const mode = options.queryPlanner ?? "serve";
  const sync = options.sync === true || options.engine?.sync === true;
  const partner = new ContextPartner({
    sources: options.sources,
    sourceMap,
    cache: new ItemCache(),
    budget: new Budget(),
    model: options.model === undefined ? OpenRouterModel.fromEnv() : options.model,
    onTrace: options.onTrace,
    gatePool: options.gatePool,
    planner:
      mode === "off" ? undefined : new QueryPlanner({ seed: (Math.random() * 2 ** 32) >>> 0, store: sourceMap, mode }),
    onShadow: options.onShadow,
    config: { ...options.engine, ...(sync ? { sync: true } : {}) },
  });
  if (sync) partner.startSync();
  return partner;
}

/**
 * Opens the source map at the path `resolvePath` gives, failing open: if the directory cannot be made or the file
 * cannot be opened (permissions, a full disk, another process holding the lock past the busy timeout), it logs to
 * stderr and returns an in-memory map, so the planner forgets what it learns at exit but asks are still served. For
 * mcp-stdio, which an MCP client launches and whose startup failure the user sees only as a broken tool.
 */
export function openSourceMap(resolvePath: () => string, log = console.error): SourceMap {
  try {
    return new SourceMap(resolvePath());
  } catch (err) {
    log(`eden: source map not opened, learning kept in memory only: ${err instanceof Error ? err.message : err}`);
    return new SourceMap();
  }
}

/**
 * Starts the pool that redacts lookup results (D25), or returns undefined for 0 workers. Items under 1 KB are gated
 * inline (the round trip costs more than the work); a batch running past 500 ms has its worker replaced and its items
 * dropped, which bounds a pathological input. Each worker, a replacement too, compiles the secret gate before it
 * serves (`warmGateItem` in engine/src/gate.ts): otherwise each one's first batch paid 30-50 ms for it.
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
    // A task of GATE_MODULE: a missing export fails the start, so a rename cannot leave the workers cold unnoticed.
    warm: "warmGateItem",
  });
}
