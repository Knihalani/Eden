import {
  AskReader,
  CardEnricher,
  ContextPartner,
  DEFAULT_CONFIG,
  GATE_MODULE,
  ItemCache,
  ModelCardMaker,
  ModelReaderMaker,
  type EngineConfig,
  type ShadowSink,
  type TraceSink,
  type UsageSink,
} from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, DEFAULT_LIMITS, TenantSpend, type Model } from "@eden/llm";
import { WorkerPool } from "@eden/primitives";
import { QueryPlanner, type SourceResolver } from "@eden/sources";
import { sanitizeForStore } from "@eden/redact";
import { NO_MODELS, type ModelRoles } from "./models";

export interface BuildOptions {
  sources: SourceResolver;
  sourceMapPath?: string;
  /** An open source map (from `openSourceMap`); `sourceMapPath` is ignored when this is set. */
  sourceMap?: SourceMap;
  /**
   * A judge model for the slow path (D5). The servers pass none: the measured default ran without a judge (D112), so
   * only an embedding that has measured one wires it.
   */
  model?: Model | null;
  /**
   * The default's model roles (D112): cards and intent in the background; the ask-time reader on the request path,
   * which the default calls only with `pushCandidates: 0` (D237). The push's candidates need no reader role: they make
   * no call, so a no-key server runs them too (D276).
   * The servers pass `modelRolesFromEnv()` (models.ts), all null without OPENROUTER_API_KEY; unset, none (`NO_MODELS`).
   * A null role leaves its part of the default inert, so the same configuration runs its no-model path.
   */
  models?: ModelRoles;
  onTrace?: TraceSink;
  /** Whether the agent used each injection, once known (D293); `main.ts` logs it with `EDEN_TRACE=1`. */
  onUsage?: UsageSink;
  /** A pool from `startGatePool`: lookup results are redacted in it. Without one they are redacted on the loop. */
  gatePool?: WorkerPool;
  /** The query planner (D28): serving by default (D33), in shadow, or off; its learning persists in the source map. */
  queryPlanner?: "off" | "serve" | "shadow";
  onShadow?: ShadowSink;
  /**
   * Engine settings over the default (D112), for an embedding or a deployment (EDEN_ENGINE_CONFIG, D103), `{}` when
   * unset. With the default's `sync` on (it is), the sync timer starts: sources with a list tool (per-user MCP sources
   * that name one, D108) are read into each active user's cache in the background; static sources list nothing.
   */
  engine?: Partial<EngineConfig>;
  /**
   * Where operational lines go (default stderr, which mcp-stdio needs: stdout is its protocol). Today: the reader's
   * first failure (`readerFailureLog`).
   */
  log?: (line: string) => void;
  /**
   * How many server processes share each tenant (`ServerConfig.child.count`, D163); default 1. The tenant's daily
   * model-spend cap is divided by it, since each process holds its own `TenantSpend`.
   */
  processes?: number;
  /**
   * The partner's clock (default `Date.now`): an embedding replaying a fixed world, such as `bun run demo` over the
   * simulated user, whose items are dated around that world's own "now" (D292).
   */
  now?: () => number;
}

/**
 * The tenant spend cap one process holds (D163): `usdPerTenantDay` divided by the processes sharing each tenant, so
 * N router children together spend at most the configured cap per tenant per UTC day, as one process did.
 */
export function tenantSpendFor(usdPerTenantDay: number, processes = 1): TenantSpend {
  return new TenantSpend(usdPerTenantDay / Math.max(1, processes));
}

/** How much of a provider's error message is logged: OpenRouterModel already cuts the body at 300 characters. */
const FAILURE_CHARS = 400;

/**
 * The reader's failures, logged once per partner (one per server process): a reader that fails on every call (an
 * OpenRouter 403 for the account, a revoked key) otherwise looks exactly like a reader that found nothing, since it
 * fails open to the no-model path (D41). The line holds the provider's status and message, with the key removed
 * (`scrub`) and redacted (D10), never the request. One line and no probe: a probe at startup would be a model call
 * (CLAUDE.md, "Model last"). Later failures are counted in `AskReader.stats.failures`.
 */
export function readerFailureLog(log: (line: string) => void, scrub: (text: string) => string = (t) => t) {
  let logged = false;
  return (error: unknown): void => {
    if (logged) return;
    logged = true;
    const raw = error instanceof Error ? error.message : String(error);
    const text = sanitizeForStore(scrub(raw).slice(0, FAILURE_CHARS)).replace(/\s+/g, " ");
    log(`eden: the reader's model call failed; asks and pushes fall back to the no-model path (logged once): ${text}`);
  };
}

/** Wires a partner from its parts with the default configuration (D112). */
export function buildPartner(options: BuildOptions): ContextPartner {
  const sourceMap = options.sourceMap ?? new SourceMap(options.sourceMapPath);
  const mode = options.queryPlanner ?? "serve";
  const config = { ...DEFAULT_CONFIG, ...options.engine };
  const models = options.models ?? NO_MODELS;
  const now = options.now ?? Date.now;
  // One cap per tenant per UTC day shared by every role, besides each role's own per-session and per-user-day caps.
  const tenants = tenantSpendFor(models.usdPerTenantDay, options.processes);
  const budget = () => new Budget(DEFAULT_LIMITS, undefined, tenants);
  const cards =
    models.cards && config.cards
      ? new CardEnricher({
          maker: new ModelCardMaker(models.cards, models.cardsRetry ? { retry: models.cardsRetry } : {}),
          budget: budget(),
          now,
        })
      : undefined;
  const reader =
    models.reader && config.askReader
      ? new AskReader({
          maker: new ModelReaderMaker(models.reader),
          budget: budget(),
          now,
          onFailure: readerFailureLog(options.log ?? console.error, models.scrub),
        })
      : undefined;
  const partner = new ContextPartner({
    sources: options.sources,
    sourceMap,
    cache: new ItemCache(),
    budget: budget(),
    model: options.model ?? null,
    ...(options.now ? { now: options.now } : {}),
    ...(cards ? { cards } : {}),
    ...(reader ? { reader } : {}),
    onTrace: options.onTrace,
    ...(options.onUsage ? { onUsage: options.onUsage } : {}),
    gatePool: options.gatePool,
    planner:
      mode === "off" ? undefined : new QueryPlanner({ seed: (Math.random() * 2 ** 32) >>> 0, store: sourceMap, mode }),
    onShadow: options.onShadow,
    config: options.engine ?? {},
  });
  if (config.sync) partner.startSync();
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
