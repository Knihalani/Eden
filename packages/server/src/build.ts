import {
  AskReader,
  CardEnricher,
  ContextPartner,
  DEFAULT_CONFIG,
  GATE_MODULE,
  ItemCache,
  ModelCardMaker,
  ModelReaderMaker,
  PushChecker,
  type EngineConfig,
  type FrozenDisk,
  type ShadowSink,
  type TraceSink,
  type UsageSink,
} from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, DEFAULT_LIMITS, ModelHeldError, TenantSpend, type Model } from "@eden/llm";
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
   * The tenant spend cap every model role shares, when the caller holds it (main.ts, for `/v1/usage`, D326);
   * otherwise `tenantSpendFor(models.usdPerTenantDay, processes)`.
   */
  tenants?: TenantSpend;
  /**
   * The partner's clock (default `Date.now`): an embedding replaying a fixed world, such as `bun run demo` over the
   * simulated user, whose items are dated around that world's own "now" (D292).
   */
  now?: () => number;
  /**
   * D425 (opt-in): where frozen users are also written, encrypted (`EncryptedFrozenDisk`, from EDEN_PERSIST_FROZEN_DIR
   * and EDEN_PERSIST_KEY). Unset, the default: no item content reaches the disk (D8).
   */
  persist?: FrozenDisk;
}

/**
 * The startup line when the turn gate's weights cannot be read (R1): the gate fails open (D1014), so without it a
 * missing `turn-gate.bin` in an image would show only in the push's numbers. Null when there is nothing to say.
 */
export function turnGateNotice(pushGate: boolean, gate: unknown): string | null {
  return pushGate && gate === null
    ? "eden: turn-gate.bin could not be read; the push's start rule decides alone (D1014)"
    : null;
}

/**
 * The tenant spend cap one process holds (D163): `usdPerTenantDay` divided by the processes sharing each tenant, so
 * N router children together spend at most the configured cap per tenant per UTC day, as one process did.
 */
export function tenantSpendFor(usdPerTenantDay: number, processes = 1): TenantSpend {
  return new TenantSpend(usdPerTenantDay / Math.max(1, processes));
}

/** The model roles whose failures are counted for `/metrics` (`eden_model_failures_total{role,kind}`). */
export type ModelRole = "reader" | "check";

/**
 * Model calls that failed in this process, by role and kind, since it started (D1690). The log line above is written
 * once; this keeps counting, so an account the provider refuses (an OpenRouter 403), a revoked key or an empty balance
 * shows on `/metrics` and pages through `EdenModelFailing` instead of reading as silence (Eden fails open, D41).
 * `error` is a call that threw (the provider's status, a timeout); `unreadable` is a reply that came back but did not
 * parse, which happens on about 2% of healthy checks (docs/research/n5-widen-check.md), so the alert reads `error`
 * only. Card calls are not counted here: `CardEnricher` has no failure hook.
 */
export const modelFailures: Record<`${ModelRole}:${"error" | "unreadable" | "held"}`, number> = {
  "reader:error": 0,
  "reader:unreadable": 0,
  "reader:held": 0,
  "check:error": 0,
  "check:unreadable": 0,
  "check:held": 0,
};

/** The model roles whose prompt-cache use is counted for `/metrics` (D1800): the card role's calls too. */
export type CacheRole = ModelRole | "cards";

/** One role's calls and their prompt-cache tokens, summed over the process's life (`modelCache`). */
export interface CacheCounts {
  /** Calls answered, and those whose request carried a cache breakpoint (`ChatResponse.cacheBreakpoints`). */
  calls: number;
  breakpointCalls: number;
  /** Input tokens, those read from the provider's cache, and those written to it (counted only when reported). */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * The roles' prompt-cache use in this process since it started (D1800), for `/metrics`
 * (`eden_model_cache_*_total{role}`): whether the route honours D1790's breakpoints shows only here, as reads against
 * calls that carried one. Counts only, no content. The push check and the reader share one model, told apart here by
 * the role that called it (`countedModel`).
 */
export const modelCache: Record<CacheRole, CacheCounts> = {
  reader: { calls: 0, breakpointCalls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  check: { calls: 0, breakpointCalls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cards: { calls: 0, breakpointCalls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

/** A role's model with its answered calls counted into `modelCache`; the request and the reply pass through as is. */
export function countedModel(model: Model, role: CacheRole): Model {
  return {
    id: model.id,
    chat: async (request) => {
      const res = await model.chat(request);
      const c = modelCache[role];
      c.calls++;
      if ((res.cacheBreakpoints ?? 0) > 0) c.breakpointCalls++;
      c.inputTokens += res.usage.inputTokens;
      c.cacheReadTokens += res.usage.cachedInputTokens;
      c.cacheWriteTokens += res.usage.cacheWriteTokens ?? 0;
      return res;
    },
  };
}

/** The engine's own wording for a reply that did not parse (`reader.ts`, `push-check.ts`). */
const UNREADABLE = /reply unreadable/;

/** How much of a provider's error message is logged: OpenRouterModel already cuts the body at 300 characters. */
const FAILURE_CHARS = 400;

/**
 * An account id a provider puts in its error body (OpenRouter's 403 carries `"user_id":"user_…"`): not a secret the
 * gate knows, but it names the operator's account, so it never reaches a log. The JSON form (cut off or whole) and a
 * bare `user_id=…`.
 */
const ACCOUNT_ID = /("user_id"\s*:\s*)"[^"]*"?|\buser_id=[^\s&,;"']+/g;
const withoutAccountId = (text: string) =>
  text.replace(ACCOUNT_ID, (_m, json: string | undefined) => (json !== undefined ? `${json}"[id]"` : "user_id=[id]"));

/**
 * The reader's failures, logged once per partner (one per server process): a reader that fails on every call (an
 * OpenRouter 403 for the account, a revoked key) otherwise looks exactly like a reader that found nothing, since it
 * fails open to the no-model path (D41). The line holds the provider's status and message, with the key removed
 * (`scrub`) and redacted (D10), never the request. One line and no probe: a probe at startup would be a model call
 * (CLAUDE.md, "Model last"). Later failures are counted in `AskReader.stats.failures`.
 */
export function readerFailureLog(
  log: (line: string) => void,
  scrub: (text: string) => string = (t) => t,
  what = "the reader's model call failed; asks and pushes fall back to the no-model path",
  role: ModelRole = "reader",
) {
  let logged = false;
  return (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    // A held call sent nothing (D2046): it counts under `held`, not as a provider error.
    const kind = error instanceof ModelHeldError ? "held" : UNREADABLE.test(message) ? "unreadable" : "error";
    modelFailures[`${role}:${kind}`]++;
    if (error instanceof ModelHeldError) return;
    if (logged) return;
    logged = true;
    const raw = error instanceof Error ? error.message : String(error);
    const text = sanitizeForStore(withoutAccountId(scrub(raw)).slice(0, FAILURE_CHARS)).replace(/\s+/g, " ");
    log(`eden: ${what} (logged once): ${text}`);
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
  const tenants = options.tenants ?? tenantSpendFor(models.usdPerTenantDay, options.processes);
  const budget = () => new Budget(DEFAULT_LIMITS, undefined, tenants);
  const cards =
    models.cards && config.cards
      ? new CardEnricher({
          maker: new ModelCardMaker(
            countedModel(models.cards, "cards"),
            models.cardsRetry ? { retry: countedModel(models.cardsRetry, "cards") } : {},
          ),
          budget: budget(),
          now,
        })
      : undefined;
  const reader =
    models.reader && config.askReader
      ? new AskReader({
          maker: new ModelReaderMaker(countedModel(models.reader, "reader")),
          budget: budget(),
          now,
          onFailure: readerFailureLog(options.log ?? console.error, models.scrub),
        })
      : undefined;
  // `pushCheck` (D500, in the default since D828): the push check runs on the reader's model, with a budget of its own.
  const checker =
    models.reader && config.pushCheck
      ? new PushChecker({
          model: countedModel(models.reader, "check"),
          budget: budget(),
          onFailure: readerFailureLog(
            options.log ?? console.error,
            models.scrub,
            "the push check's model call failed; pushes hand the default's candidates",
            "check",
          ),
        })
      : undefined;
  const cache = new ItemCache();
  // Before the partner is built: it wires the sync's state into what a persisted user carries.
  if (options.persist) cache.persist(options.persist);
  const partner = new ContextPartner({
    sources: options.sources,
    sourceMap,
    cache,
    budget: budget(),
    model: options.model ?? null,
    ...(options.now ? { now: options.now } : {}),
    ...(cards ? { cards } : {}),
    ...(reader ? { reader } : {}),
    ...(checker ? { checker } : {}),
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
