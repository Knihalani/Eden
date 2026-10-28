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
 * - Cascade: when the chosen shape returns nothing and another shape applies, another one (a fresh Thompson draw
 *   among the rest) is tried once, within the same lookup. An empty result costs one more call, not the lookup.
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
  /** Try the next shape when the chosen one returns nothing. */
  cascade?: boolean;
  /** Connectors whose search takes `"a b"` as a phrase (operator config; unknown connectors get no quotes). */
  quotes?: (sourceId: string) => boolean;
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
}

interface ConnectorState {
  /** Bucket 0: the cue names no entity; bucket 1: it names at least one. */
  bandits: [BetaBandit, BetaBandit];
}

const DEFAULTS = {
  seed: 1,
  epsilon: 0.05,
  gamma: 0.98,
  priorStrength: 2,
  maxCalls: 3,
  cascade: true,
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
    while (calls < this.o.maxCalls) {
      const n = bandit.select(this.rng, 1, eligible, null, this.o.epsilon, picked);
      if (n === 0) break;
      let arm = picked[0]!;
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
        if (calls > 0 && permit && !permit()) break;
        calls++;
        sent++;
        // Shapes carry the whole query in `text`; entities are cleared so a source does not re-add its own.
        for (const it of await source.search({ ...query, text, entities: [] }, signal)) got.push(it);
      }
      // A shape that sent nothing (the permit was refused) is not credited: nothing was learned about it. A lookup
      // aborted meanwhile (session ended, user forgotten) learns nothing either (D17), and neither does one whose
      // user's state was dropped while it waited: writing it back would undo `forget`.
      if (sent === 0 || signal.aborted || !this.current(query.scope, source.id, state)) break;
      const r = this.o.rewardTopK > 1 ? rankedCoverage(input, got, this.o.rewardTopK) : cueCoverage(input, got);
      bandit.decayArm(arm, 1);
      bandit.update(arm, r);
      this.save(query.scope, source.id, bucket, arm, bandit);
      shapes.push(SHAPES[arm]!);
      reward = Math.max(reward, r);
      for (const it of got) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
      // One cascade step at most, and only after an empty result: a non-empty one is the lookup's answer.
      if (got.length > 0 || !this.o.cascade || shapes.length > 1) break;
      eligible[arm] = 0;
    }
    return { items: items.slice(0, query.limit), shapes, calls, reward };
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

  /** Posterior mean usefulness of each shape for one connector and bucket, for tests and reports. */
  means(scope: Scope, sourceId: string, withEntity: boolean): Record<Shape, number> {
    const b = this.state(scope, sourceId).bandits[withEntity ? 1 : 0];
    return Object.fromEntries(SHAPES.map((s, i) => [s, b.mean(i)])) as Record<Shape, number>;
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
    const make = () => {
      const b = new BetaBandit(SHAPES.length, prior, this.o.priorStrength, this.o.gamma, 1);
      if (incArm >= 0 && inc.strength > 0) b.setPrior(incArm, inc.mean, inc.strength);
      return b;
    };
    s = { bandits: [make(), make()] };
    let stored: PlannerArm[] = [];
    try {
      stored = this.o.store?.loadArms(scope, sourceId) ?? [];
    } catch {
      // As for saving: an unreadable store means starting from the priors, not failing the lookup.
    }
    for (const a of stored) {
      const i = SHAPES.indexOf(a.shape as Shape);
      // Stored rows are checked, not trusted: an unknown shape or a non-positive parameter is skipped.
      if (i < 0 || (a.bucket !== 0 && a.bucket !== 1) || !(a.alpha > 0) || !(a.beta > 0)) continue;
      s.bandits[a.bucket].alpha[i] = a.alpha;
      s.bandits[a.bucket].beta[i] = a.beta;
    }
    this.states.set(key, s);
    while (this.states.size > this.o.maxStates) this.states.delete(this.states.keys().next().value!);
    return s;
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
  ) {
    this.id = inner.id;
    this.kind = inner.kind;
    this.description = inner.description;
  }

  async search(query: SearchQuery, signal: AbortSignal): Promise<ContextItem[]> {
    const r = await this.planner.search(this.inner, query, signal, this.permit);
    this.last = { shapes: r.shapes, calls: r.calls, reward: r.reward };
    return r.items;
  }

  fetch(ref: string, scope: Scope, signal: AbortSignal): Promise<ContextItem | null> {
    return this.inner.fetch ? this.inner.fetch(ref, scope, signal) : Promise.resolve(null);
  }

  close(): Promise<void> {
    return this.inner.close ? this.inner.close() : Promise.resolve();
  }
}
