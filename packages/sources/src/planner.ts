/**
 * The query planner: for each lookup and each connector, which query shape to send (docs/plans/query-planner.md).
 *
 * Connectors differ in what their search does with a query, and the difference decides recall. In the connector lab
 * the cue's terms reached 0% of needed items on the six connectors that match the whole query as one substring, where
 * one call per entity reached 27–77%; on OR and vector search the terms did best (docs/research/connector-lab.md).
 * A tenant can connect any MCP server, so the planner learns per (tenant, user, connector) instead of being told.
 *
 * - Arms are shapes (`shapes.ts`), learned separately for cues with and without an entity (shapes that need an
 *   entity do not apply to the second). Thompson sampling over Beta posteriors (`BetaBandit`): per-arm decay so a
 *   connector that changes is relearned, an ε floor so every applicable shape keeps a chance and logged propensities
 *   stay usable for off-policy evaluation.
 * - Reward, at once: how much of the cue the best returned item covers (`cueCoverage`); 0 for nothing returned. It
 *   is a proxy for "a needed item came back": cheap, available on every call, and measured against the lab's labels.
 * - Cascade: when the chosen shape returns nothing and another shape applies, another one is tried once, within
 *   the same lookup: the rest's best posterior mean (a Thompson draw on an ε step), so it goes straight to what has
 *   worked rather than drawing at random while little is known. The runner-up prior (one call per entity, the best
 *   fixed shape where the cue's terms fail in the lab) makes that the first fallback until evidence says otherwise.
 *   An empty result costs one more call, not the lookup.
 *   Whether to cascade is learned too, per (connector, bucket): a Beta posterior on "the cascade found something".
 *   On OR and ranked search an empty answer to the cue's terms means nothing is there, and every narrower shape
 *   comes back empty as well; there the cascade stops once its draws fall below `cascadeMin`, with an ε floor so it
 *   is re-tried now and then.
 *
 * No query text is stored: state is two numbers per (connector, bucket, shape). State is keyed by tenant and user
 * (CLAUDE.md: isolation) and bounded in memory: the least recently used connectors' state is dropped past
 * `maxStates`. With a `store` (the source map), arms are loaded when a connector's state is created and written after
 * each update, so learning survives a restart and an eviction.
 */
import type { ContextItem, Scope } from "@eden/protocol";
import { BetaBandit, Xoshiro128 } from "@eden/primitives";
import { buildShape, SHAPES, type Shape, type ShapeInput } from "./shapes";
import type { SearchQuery, Source } from "./source";

export interface PlannerOptions {
  seed?: number;
  /** Probability a decision is a uniform choice among applicable shapes (exploration floor). */
  epsilon?: number;
  /** Per-update discount of an arm's evidence toward its prior; memory ≈ 1 / (1 − gamma) updates of that arm. */
  gamma?: number;
  /** Prior pseudo-observations per arm (prior mean 0.5). */
  priorStrength?: number;
  /**
   * The incumbent: what Eden sent before the planner (the cue's terms), with a stronger prior, so the planner leaves
   * it only on evidence that it fails. Without one, on connectors where every shape returns something (OR and vector
   * search) the reward barely separates shapes, and exploring cost reach the terms already had
   * (docs/research/query-planner-results.md). `strength` 0 disables it.
   */
  incumbent?: { shape: Shape; mean: number; strength: number };
  /**
   * Items whose cue coverage is averaged for the reward, in the order the connector returned them: 1 scores only the
   * best-covering item; more also rewards ranking cue-heavy items first, which separates shapes on connectors where
   * every shape returns something.
   */
  rewardTopK?: number;
  /**
   * How much better (posterior mean) a shape must look than the incumbent to replace it; 0 is plain Thompson
   * sampling. Exploration still sends a non-incumbent shape with probability `epsilon`, so evidence keeps coming.
   */
  margin?: number;
  /** Most calls a lookup makes for one connector, cascade included. */
  maxCalls?: number;
  /** Try the next shape when the chosen one returns nothing (subject to `cascadeMin`). */
  cascade?: boolean;
  /**
   * The cascade step sends the remaining shape with the best posterior mean (a Thompson draw on an ε step) rather
   * than a Thompson draw: a draw among near-uniform priors spends early cascades on shapes that rarely help. The
   * uniform floor on cascade steps is then ε² (an ε step that `select` itself also made uniform), not ε.
   */
  cascadeGreedy?: boolean;
  /**
   * A prior for the shape to fall back to while little is known; below the incumbent's mean, so it is not sent first
   * on a fresh connector. `strength` 0 disables it. One call per entity, mean 0.7, strength 4 was chosen on the
   * simulation's tune set (D38).
   */
  runnerUp?: { shape: Shape; mean: number; strength: number };
  /**
   * The cascade runs when a draw from its posterior (chance it finds something, per connector and bucket) is at least
   * this, or on an ε exploration step. 0 always cascades. 0.05 was tuned on the simulation's tune set with a perfect
   * judge (docs/research/query-planner-results.md, iteration 1).
   */
  cascadeMin?: number;
  /** Connectors whose search takes `"a b"` as a phrase (operator config; unknown connectors get no quotes). */
  quotes?: (sourceId: string) => boolean;
  /**
   * Answer a shape's query from the fan-out's cache when it was sent recently (`PlanCalls.cached`). Off only to
   * measure what the reuse saves.
   */
  reuse?: boolean;
  /**
   * A call after a lookup's first is sent only if this many times the lookup's slowest call so far still fits
   * before the caller's deadline (default 2, chosen in a timed run; docs/research/query-planner-results.md).
   */
  deadlineMargin?: number;
  /**
   * The deadline check also expects a call to take at least this quantile of the connector's recent call latency
   * (`PlanCalls.expectMs`), not only the lookup's slowest call so far; 0 uses the lookup's own calls alone.
   */
  latencyQuantile?: number;
  /** Connector states kept in memory, across all users. */
  maxStates?: number;
  /** Where arms persist (`SourceMap` implements it). Absent: learning lives in memory only. */
  store?: PlannerStore;
  /**
   * "serve" (default): lookups go through the planner. "shadow": the engine serves as if there were no planner, and
   * runs the planner's lookup beside it to learn and to report what it would have found (D28's phase 5), delivering
   * nothing from it. Mutable on the planner (`mode`), so a deployment can promote shadow learning to serving.
   */
  mode?: "serve" | "shadow";
}

/**
 * How a planned lookup's calls reach the connector when they go through the fan-out (`SourceFanout.planCalls`): a
 * shape's query already answered recently (one call per entity repeats across a session's lookups) is served from the
 * fan-out's result cache, at no call; others are made once (singleflight), sanitized and cached. Without one, calls go
 * straight to the source and nothing is cached (shadow lookups, D29).
 */
export interface PlanCalls {
  /** Fresh, sanitized results already held for this query, if any. */
  cached(query: SearchQuery): ContextItem[] | undefined;
  /** One call to the connector; its results come back sanitized and are cached. */
  call(query: SearchQuery, signal: AbortSignal): Promise<ContextItem[]>;
  /** The connector's recent latency per call for this user at `quantile` (ms), or 0 while too few are known. */
  expectMs?(query: SearchQuery, quantile: number): number;
}

/** One learned arm as stored: content-free. */
export interface PlannerArm {
  bucket: number;
  shape: string;
  alpha: number;
  beta: number;
}

export interface PlannerStore {
  loadArms(scope: Scope, sourceId: string): PlannerArm[];
  saveArms(scope: Scope, sourceId: string, arms: PlannerArm[]): void;
}

/** What one lookup did with one connector, for traces (content-free: shape names and counts only). */
export interface PlanOutcome {
  shapes: Shape[];
  calls: number;
  reward: number;
  /** Items the lookup returned (after merging its shapes' results). */
  found: number;
}

interface ConnectorState {
  /** Bucket 0: the cue names no entity; bucket 1: it names at least one. */
  bandits: [BetaBandit, BetaBandit];
  /** Per bucket, one arm: does a cascade step after an empty result find anything? */
  cascades: [BetaBandit, BetaBandit];
}

/** The eligible arm with the highest posterior mean (the first on a tie). */
function bestMean(bandit: BetaBandit, eligible: Uint8Array): number {
  let best = -1;
  for (let i = 0; i < eligible.length; i++) {
    if (eligible[i] === 1 && (best < 0 || bandit.mean(i) > bandit.mean(best))) best = i;
  }
  return best;
}

/** The stored name of a bucket's cascade posterior (`PlannerArm.shape`); not a shape. */
const CASCADE = "cascade";

const DEFAULTS = {
  seed: 1,
  epsilon: 0.05,
  gamma: 0.98,
  priorStrength: 2,
  maxCalls: 3,
  cascade: true,
  cascadeGreedy: true,
  runnerUp: { shape: "each-entity" as Shape, mean: 0.7, strength: 4 },
  cascadeMin: 0.05,
  reuse: true,
  deadlineMargin: 2,
  latencyQuantile: 0.9,
  maxStates: 50_000,
  incumbent: { shape: "terms" as Shape, mean: 0.75, strength: 8 },
  rewardTopK: 1,
  margin: 0.1,
};

export class QueryPlanner {
  private readonly states = new Map<string, ConnectorState>();
  private readonly rng: Xoshiro128;
  private readonly o: typeof DEFAULTS & Pick<PlannerOptions, "quotes" | "store">;
  private readonly picked = new Int32Array(SHAPES.length);
  private readonly incumbentArm: number;
  /** See `PlannerOptions.mode`. */
  mode: "serve" | "shadow";
  private readonly eligible = new Uint8Array(SHAPES.length);

  constructor(options: PlannerOptions = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.rng = new Xoshiro128(this.o.seed);
    this.incumbentArm = this.o.incumbent.strength > 0 ? SHAPES.indexOf(this.o.incumbent.shape) : -1;
    this.mode = options.mode ?? "serve";
  }

  /**
   * Runs one lookup against `source`, choosing and crediting shapes. Errors from the source propagate; errors from the
   * store do not (learning fails open). `permit` is asked before every call after the first: the caller's rate limit
   * applies per call, not per lookup, and a refused permit ends the lookup with what it has.
   */
  async search(
    source: Source,
    query: SearchQuery,
    signal: AbortSignal,
    permit?: () => boolean,
    via?: PlanCalls,
    /** When the caller stops waiting (`performance.now()` ms): no call is started that cannot answer by then. */
    deadlineAt?: number,
  ): Promise<{ items: ContextItem[] } & PlanOutcome> {
    const input: ShapeInput = { text: query.text, entities: query.entities };
    const quotes = this.o.quotes?.(source.id) ?? false;
    const built = SHAPES.map((s) => buildShape(s, input, { quotes, maxCalls: this.o.maxCalls }));
    const bucket = query.entities.length > 0 ? 1 : 0;
    const state = this.state(query.scope, source.id);
    const bandit = state.bandits[bucket];
    // Per lookup, never shared: lookups for other users and connectors run concurrently and must not see these.
    const eligible = new Uint8Array(SHAPES.length);
    const picked = new Int32Array(1);
    for (let i = 0; i < SHAPES.length; i++) eligible[i] = built[i]!.length > 0 ? 1 : 0;
    const shapes: Shape[] = [];
    let calls = 0;
    let reward = 0;
    const seen = new Set<string>();
    const items: ContextItem[] = [];
    // What the next call is expected to take (ms): the lookup's slowest call so far, and at least the connector's
    // recent latency at `latencyQuantile` (one lookup does not show the tail; the last 10–20 minutes of calls may).
    let callMs = this.o.latencyQuantile > 0 && via?.expectMs ? via.expectMs(query, this.o.latencyQuantile) : 0;
    while (calls < this.o.maxCalls) {
      const n = bandit.select(this.rng, 1, eligible, null, this.o.epsilon, picked);
      if (n === 0) break;
      let arm = picked[0]!;
      if (shapes.length > 0 && this.o.cascadeGreedy && this.rng.uniform() >= this.o.epsilon)
        arm = bestMean(bandit, eligible);
      // Conservative: the incumbent is sent unless the draw's winner beats it, on posterior means, by `margin`. Where
      // the reward cannot tell shapes apart, today's query stays; where it fails, the means part quickly.
      const inc = this.incumbentArm;
      if (
        shapes.length === 0 &&
        inc >= 0 &&
        arm !== inc &&
        eligible[inc] === 1 &&
        bandit.mean(arm) - bandit.mean(inc) < this.o.margin &&
        this.rng.uniform() >= this.o.epsilon
      ) {
        arm = inc;
      }
      const queries = built[arm]!.slice(0, this.o.maxCalls - calls);
      const got: ContextItem[] = [];
      let sent = 0;
      for (const text of queries) {
        // Shapes carry the whole query in `text`; entities are cleared so a source does not re-add its own.
        const q = { ...query, text, entities: [] };
        const held = this.o.reuse ? via?.cached(q) : undefined;
        if (held) {
          // Answered recently: no call, no rate token.
          for (const it of held) got.push(it);
          sent++;
          continue;
        }
        // A call after the first is sent only if it can answer before the caller's deadline, at this lookup's
        // slowest call so far (with a margin): one the deadline cuts off costs the connector a call, returns nothing,
        // and counts as a timeout against it. A shape cut short here is not credited (below).
        if (calls > 0 && deadlineAt !== undefined && performance.now() + callMs * this.o.deadlineMargin > deadlineAt)
          break;
        if (calls > 0 && permit && !permit()) break;
        calls++;
        sent++;
        const t0 = performance.now();
        try {
          for (const it of await (via ? via.call(q, signal) : source.search(q, signal))) got.push(it);
          callMs = Math.max(callMs, performance.now() - t0);
        } catch (e) {
          // What came back before the failure is reported with it, so a caller can account for the calls made.
          throw new PlanError(e, { items: [...items, ...got], shapes: [...shapes, SHAPES[arm]!], calls });
        }
      }
      // A shape that sent nothing (the permit was refused) is not credited: nothing was learned about it. A lookup
      // aborted meanwhile (session ended, user forgotten) learns nothing either (D17), and neither does one whose
      // user's state was dropped while it waited: writing it back would undo `forget`.
      if (sent === 0 || signal.aborted || !this.current(query.scope, source.id, state)) break;
      const r = this.o.rewardTopK > 1 ? rankedCoverage(input, got, this.o.rewardTopK) : cueCoverage(input, got);
      shapes.push(SHAPES[arm]!);
      reward = Math.max(reward, r);
      for (const it of got) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
      // A shape cut short by the permit (one call per entity, the later ones refused) is not credited either: its
      // reward may be 0 only because the query that would have found something was never sent. Its items are kept.
      if (sent < queries.length) break;
      bandit.decayArm(arm, 1);
      bandit.update(arm, r);
      this.save(query.scope, source.id, bucket, arm, bandit);
      if (shapes.length > 1) {
        // The cascade step's outcome teaches whether to cascade on this connector.
        const c = state.cascades[bucket];
        c.decayArm(0, 1);
        c.update(0, r > 0 ? 1 : 0);
        this.saveCascade(query.scope, source.id, bucket, c);
        break;
      }
      // One cascade step at most, and only after an empty result: a non-empty one is the lookup's answer.
      if (got.length > 0 || !this.o.cascade || !this.cascadeWorth(state.cascades[bucket])) break;
      eligible[arm] = 0;
    }
    const kept = items.slice(0, query.limit);
    return { items: kept, shapes, calls, reward, found: kept.length };
  }

  /** Whether to try one more shape after an empty result: a Thompson draw against `cascadeMin`, or exploration. */
  private cascadeWorth(c: BetaBandit): boolean {
    if (this.o.cascadeMin <= 0 || this.rng.uniform() < this.o.epsilon) return true;
    return this.rng.beta(c.alpha[0]!, c.beta[0]!) >= this.o.cascadeMin;
  }

  /** Drops what was learned for a user (and one connector, when given), in memory; the store forgets its own. */
  forget(scope: Scope, sourceId?: string): void {
    const prefix = `${scope.tenantId}\u0000${scope.userId}\u0000`;
    for (const key of [...this.states.keys()]) {
      if (sourceId ? key === prefix + sourceId : key.startsWith(prefix)) this.states.delete(key);
    }
  }

  /** Whether `state` is still the one held for this user's connector (not forgotten or evicted since). */
  private current(scope: Scope, sourceId: string, state: ConnectorState): boolean {
    return this.states.get(`${scope.tenantId}\u0000${scope.userId}\u0000${sourceId}`) === state;
  }

  private save(scope: Scope, sourceId: string, bucket: number, arm: number, bandit: BetaBandit): void {
    try {
      this.o.store?.saveArms(scope, sourceId, [
        { bucket, shape: SHAPES[arm]!, alpha: bandit.alpha[arm]!, beta: bandit.beta[arm]! },
      ]);
    } catch {
      // Learning fails open: a store that cannot write (locked, full, closing) costs persistence, not the lookup.
    }
  }

  private saveCascade(scope: Scope, sourceId: string, bucket: number, c: BetaBandit): void {
    try {
      this.o.store?.saveArms(scope, sourceId, [{ bucket, shape: CASCADE, alpha: c.alpha[0]!, beta: c.beta[0]! }]);
    } catch {
      // As for arms: persistence fails open.
    }
  }

  /** Posterior mean usefulness of each shape for one connector and bucket, for tests and reports. */
  means(scope: Scope, sourceId: string, withEntity: boolean): Record<Shape, number> {
    const b = this.state(scope, sourceId).bandits[withEntity ? 1 : 0];
    return Object.fromEntries(SHAPES.map((s, i) => [s, b.mean(i)])) as Record<Shape, number>;
  }

  /** Posterior chance that a cascade step finds something, for one connector and bucket (tests and reports). */
  cascadeMean(scope: Scope, sourceId: string, withEntity: boolean): number {
    return this.state(scope, sourceId).cascades[withEntity ? 1 : 0].mean(0);
  }

  get size(): number {
    return this.states.size;
  }

  private state(scope: Scope, sourceId: string): ConnectorState {
    const key = `${scope.tenantId}\u0000${scope.userId}\u0000${sourceId}`;
    let s = this.states.get(key);
    if (s) {
      // Re-insert: Map order is least recently used first, for eviction.
      this.states.delete(key);
      this.states.set(key, s);
      return s;
    }
    const prior = new Float64Array(SHAPES.length).fill(0.5);
    const inc = this.o.incumbent;
    const incArm = SHAPES.indexOf(inc.shape);
    const runner = this.o.runnerUp;
    const runnerArm = SHAPES.indexOf(runner.shape);
    const make = () => {
      const b = new BetaBandit(SHAPES.length, prior, this.o.priorStrength, this.o.gamma, 1);
      if (incArm >= 0 && inc.strength > 0) b.setPrior(incArm, inc.mean, inc.strength);
      if (runnerArm >= 0 && runner.strength > 0) b.setPrior(runnerArm, runner.mean, runner.strength);
      return b;
    };
    const cascade = () => new BetaBandit(1, new Float64Array([0.5]), this.o.priorStrength, this.o.gamma, 1);
    s = { bandits: [make(), make()], cascades: [cascade(), cascade()] };
    let stored: PlannerArm[] = [];
    try {
      stored = this.o.store?.loadArms(scope, sourceId) ?? [];
    } catch {
      // As for saving: an unreadable store means starting from the priors, not failing the lookup.
    }
    for (const a of stored) {
      // Stored rows are checked, not trusted: an unknown shape or a non-positive parameter is skipped.
      const ok = (x: number) => Number.isFinite(x) && x > 0;
      if ((a.bucket !== 0 && a.bucket !== 1) || !ok(a.alpha) || !ok(a.beta)) continue;
      const i = a.shape === CASCADE ? 0 : SHAPES.indexOf(a.shape as Shape);
      if (i < 0) continue;
      const b = a.shape === CASCADE ? s.cascades[a.bucket] : s.bandits[a.bucket];
      b.alpha[i] = a.alpha;
      b.beta[i] = a.beta;
    }
    this.states.set(key, s);
    while (this.states.size > this.o.maxStates) this.states.delete(this.states.keys().next().value!);
    return s;
  }
}

/**
 * A lookup that failed part-way: the connector's error (its message kept, so rate-limit detection still sees it), and
 * what the lookup had already returned and spent.
 */
export class PlanError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly partial: { items: ContextItem[]; shapes: Shape[]; calls: number },
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = cause instanceof Error ? cause.name : "Error";
  }
}

/** Lower-cased words of at least two characters, the way the planner compares a cue with an item. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*[\p{L}\p{N}]/gu) ?? [];
}

/**
 * How much of the cue the best returned item covers, in [0, 1]: the share of the cue's words (terms and entity
 * words) the item's title and text contain, as whole words. 0 when nothing came back.
 */
export function cueCoverage(input: ShapeInput, items: ContextItem[]): number {
  const cue = new Set([...words(input.text), ...input.entities.flatMap(words)]);
  if (cue.size === 0 || items.length === 0) return 0;
  let best = 0;
  for (const it of items) {
    const have = new Set(words(`${it.title} ${it.text}`));
    let n = 0;
    for (const w of cue) if (have.has(w)) n++;
    if (n > best) best = n;
  }
  return best / cue.size;
}

/** Mean cue coverage of the first `k` items as returned (fewer if fewer came back); 0 for nothing. */
export function rankedCoverage(input: ShapeInput, items: ContextItem[], k: number): number {
  const top = items.slice(0, k);
  if (top.length === 0) return 0;
  let sum = 0;
  for (const it of top) sum += cueCoverage(input, [it]);
  return sum / top.length;
}

/** A source whose lookups go through the planner: what the engine searches when the planner is on. */
export class PlannedSource implements Source {
  readonly id: string;
  readonly kind: string;
  readonly description: string;
  /** The last lookup's outcome, for traces. */
  last: PlanOutcome | null = null;

  constructor(
    readonly inner: Source,
    private readonly planner: QueryPlanner,
    /** Asked before each call after a lookup's first (the caller's per-call rate limit). */
    private readonly permit?: () => boolean,
    /** The fan-out's cached, sanitized path for each call; absent: calls go straight to `inner`. */
    readonly via?: PlanCalls,
    /** When the lookup's caller stops waiting (`performance.now()` ms). */
    private readonly deadlineAt?: number,
  ) {
    this.id = inner.id;
    this.kind = inner.kind;
    this.description = inner.description;
  }

  async search(query: SearchQuery, signal: AbortSignal): Promise<ContextItem[]> {
    const r = await this.planner.search(this.inner, query, signal, this.permit, this.via, this.deadlineAt);
    this.last = { shapes: r.shapes, calls: r.calls, reward: r.reward, found: r.found };
    return r.items;
  }

  fetch(ref: string, scope: Scope, signal: AbortSignal): Promise<ContextItem | null> {
    return this.inner.fetch ? this.inner.fetch(ref, scope, signal) : Promise.resolve(null);
  }

  close(): Promise<void> {
    return this.inner.close ? this.inner.close() : Promise.resolve();
  }
}
