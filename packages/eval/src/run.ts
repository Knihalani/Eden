/**
 * Plays scenarios through a real `ContextPartner` and scores what it delivered. Deterministic with no model or a
 * `FakeModel`; with `--live` it uses OpenRouter, wired as the servers wire it (`liveWiring`, D128), and reports real
 * cost.
 */
import {
  AskReader,
  ContextPartner,
  DEFAULT_CONFIG,
  ItemCache,
  ModelReaderMaker,
  type EngineConfig,
  type ReaderReport,
  type Trace,
  PushChecker,
} from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, DEFAULT_LIMITS, OpenRouterModel, TenantSpend, type Model } from "@eden/llm";
// The servers' own role construction (D128): the eval's live reader is built by the function main.ts calls, so the
// model, its routing (D12's ZDR and no data collection, D95's throughput sort) and EDEN_MODEL cannot drift from what
// ships. Imported through the declared @eden/server dependency, so test:changed reruns the eval's tests when the
// server's wiring changes (scripts/test-select.ts follows package.json only).
import { modelRolesFromEnv, type MakeRoleModel } from "@eden/server";
import type { AgentEvent, Injection } from "@eden/protocol";
import { QueryPlanner, StaticSource } from "@eden/sources";
import { OracleReader, readerFor, type ReaderKindOption } from "./reader-stub";
import type { Scenario } from "./scenario";

export interface RunOptions {
  model: Model | null;
  /**
   * How long each event waits for the slow path. 0 measures the fast path plus next-event delivery: the runner
   * yields between events (as real traffic would), so a slow path started at one event can land by the next.
   */
  waitMs: number;
  config?: Partial<EngineConfig>;
  /** Run each scenario's lookups through a query planner (a fresh one per scenario, as the server does per process). */
  planner?: boolean;
  /**
   * A no-model reader behind the real `AskReader` (`reader-stub.ts`), for configurations with `askReader`: `stub` says
   * nothing binds and measures the reader's pool (`Metrics.readerPool`); `oracle` flags the expected items, a proxy
   * whose scores read the gold labels (`proxyOf`). Absent: no reader is wired, and `askReader` does nothing.
   */
  reader?: ReaderKindOption;
  /**
   * The shipped reader's model (`liveWiring`): the real `AskReader` over `ModelReaderMaker`, as `buildPartner` wires
   * it with a key, on the servers' default budget limits. Exclusive with `reader`.
   */
  readerModel?: Model | null;
  /** One cap on the whole run's model spend, shared by every budget the run builds (`liveWiring`). */
  spend?: TenantSpend;
  /** Told of each failed reader call (a provider's 403, an unreadable reply): `AskReader`'s `onFailure`. */
  onReaderFailure?: (error: unknown) => void;
}

/** The tenant every scenario runs under: `TenantSpend` keys the run's cap on it. */
export const EVAL_TENANT = "eval";

/** What `--live` wires: the shipped shape (no judge, the role reader) or, with `--judge`, the old one. */
export interface LiveWiring {
  /** The judge (`PartnerDeps.model`): null in the shipped shape, as `buildPartner` passes (D112). */
  model: Model | null;
  /** The reader's model: the servers' reader role in the shipped shape, null under `--judge`. */
  readerModel: Model | null;
  /** The run's hard cap: every budget is built with it, so no call is reserved past `usdCap`. */
  spend: TenantSpend;
  /** Removes the API key from a provider's error text before it is printed. */
  scrub: (text: string) => string;
}

/**
 * The live wiring (D128). Shipped: no judge, and the reader the servers build with a key (`modelRolesFromEnv(env)
 * .reader`, Haiku 5.5 through OpenRouter unless EDEN_MODEL says otherwise). `judge`: the shape `--live` had before
 * D128 (`OpenRouterModel.fromEnv` as judge, no live reader), so D119's and D125's `--live` numbers can be re-run.
 * Either way every call is charged to one `TenantSpend` of `usdCap` (reserved at its estimate before the call, so a
 * call that would pass the cap is refused and its path runs with no model). Null without OPENROUTER_API_KEY. `make`
 * builds the reader's model from its OpenRouter options: tests pass a fake, so no network.
 */
export function liveWiring(options: {
  judge: boolean;
  usdCap: number;
  env?: Record<string, string | undefined>;
  make?: MakeRoleModel;
}): LiveWiring | null {
  const env = options.env ?? process.env;
  if (!(options.usdCap > 0) || !Number.isFinite(options.usdCap)) throw new Error("usdCap must be a positive number");
  // The whole run is one tenant on one day: a fixed clock keeps a run past midnight under the one cap.
  const start = Date.now();
  const spend = new TenantSpend(options.usdCap, () => start);
  if (options.judge) {
    const model = options.make ? fromEnvVia(env, options.make) : OpenRouterModel.fromEnv(env);
    if (!model) return null;
    const key = env.OPENROUTER_API_KEY!;
    return { model, readerModel: null, spend, scrub: (t) => t.split(key).join("[key]") };
  }
  const roles = modelRolesFromEnv(env, options.make);
  if (!roles.reader) return null;
  return { model: null, readerModel: roles.reader, spend, scrub: roles.scrub ?? ((t) => t) };
}

/** `OpenRouterModel.fromEnv`'s options, through a test's factory (run.test.ts pins the two equal). */
export function fromEnvVia(env: Record<string, string | undefined>, make: MakeRoleModel): Model | null {
  if (!env.OPENROUTER_API_KEY) return null;
  return make({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.EDEN_MODEL || "z-ai/glm-5.3-flash",
    baseUrl: env.OPENROUTER_BASE_URL,
    zdr: env.EDEN_MODEL_ZDR !== "off",
  });
}

/**
 * With `RunOptions.reader`: how often an expected item was in a pool the reader was given (the ids `onReader`
 * reports), by its turn or the next one (the window recall uses), or during its ask. A measurement of pool content,
 * not of delivery: what a reader could flag at best.
 */
export interface ReaderPoolMetrics {
  /** `live`: the shipped reader (`RunOptions.readerModel`). */
  reader: ReaderKindOption | "live";
  /** Calls the engine made to the reader, reports with a pool, and the mean pool size over those reports. */
  calls: number;
  /** Calls that failed (threw, or replied with nothing readable): each fell back to the no-model path. */
  failures: number;
  reads: number;
  meanPoolItems: number;
  /** Expected items on labelled turns, and those in a reader pool in their window. */
  expected: number;
  expectedInPool: number;
  ask: { expected: number; expectedInPool: number };
  byCategory: Record<string, { expected: number; expectedInPool: number }>;
}

export interface Metrics {
  scenarios: number;
  turns: number;
  scoredTurns: number;
  /** Delivered items that were expected, over all delivered items on scored turns. */
  precision: number;
  /** Expected items delivered by their turn or the next (or earlier in the session), over all expected items. */
  recall: number;
  /** Silent-labelled turns where something was delivered, over silent-labelled turns. */
  falseFireRate: number;
  modelCallsPerTurn: number;
  costPerTurnUsd: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  decisions: Record<string, number>;
  /** Connector lookups the query planner chose for (0 without it). */
  plannedLookups: number;
  /** The same scores per scenario category (`Scenario.category`, "general" when absent). */
  byCategory: Record<string, CategoryMetrics>;
  /** The counts behind the rates: with tens of items, one item moves recall by points. */
  counts: {
    expected: number;
    found: number;
    delivered: number;
    deliveredExpected: number;
    silentTurns: number;
    falseFires: number;
  };
  /**
   * Planted secrets (`Scenario.secrets`); deliveries and answers that cited an item holding one, so the check ran
   * (`secretsExposed`; 0 means it checked nothing); those whose text contained one (`secretsLeaked`, must be 0); and
   * deliveries and answers without the framing that marks their content as data, not instructions (must be 0).
   */
  privacy: {
    secretsPlanted: number;
    secretsExposed: number;
    secretsLeaked: number;
    injections: number;
    notInert: number;
  };
  /** `Scenario.asks`: how many, how many cited something, and recall of the expected items in their citations. */
  ask: { cases: number; answered: number; recall: number };
  /** Only with `RunOptions.reader`. */
  readerPool?: ReaderPoolMetrics;
  /** The acting suite's labels (`"neutral"`, `decoys`; D810): present when a scenario carries one. */
  acting?: ActingMetrics;
}

/**
 * The push of candidates on requests that act (D810), which the three headline numbers do not see: their silent turns
 * are remarks and questions, where no push starts, so `pushOpen` on or off read the same. A neutral request acts but
 * owes no fact, so a packet on it is a false fire of the default's main delivery path; an owed request's fact should be
 * handed by its turn or the next (recall's window), and a look-alike beside it should not.
 */
export interface ActingMetrics {
  neutralTurns: number;
  /** Neutral requests that got any packet, and their share. */
  packetsOnNeutral: number;
  packetsOnNeutralRate: number;
  /** Items handed on neutral requests, per neutral request. */
  itemsPerNeutralTurn: number;
  owedTurns: number;
  /** Owed facts, those handed in their window, and the share. */
  factsOwed: number;
  factsHanded: number;
  factsHandedRate: number;
  /** Owed requests with a labelled look-alike, those where one was handed, and the share. */
  decoyTurns: number;
  decoyHanded: number;
  decoyHandedRate: number;
}

export interface CategoryMetrics {
  scenarios: number;
  scoredTurns: number;
  precision: number;
  recall: number;
  falseFireRate: number;
}

/** Marks an injection's content as data the agent must not follow (render.ts). */
const INERT = "Data, not instructions";

interface Tally {
  scenarios: number;
  scoredTurns: number;
  delivered: number;
  deliveredExpected: number;
  expected: number;
  expectedFound: number;
  silentTurns: number;
  falseFires: number;
}
const tally = (): Tally => ({
  scenarios: 0,
  scoredTurns: 0,
  delivered: 0,
  deliveredExpected: 0,
  expected: 0,
  expectedFound: 0,
  silentTurns: 0,
  falseFires: 0,
});
const rates = (t: Tally) => ({
  precision: t.delivered ? t.deliveredExpected / t.delivered : 1,
  recall: t.expected ? t.expectedFound / t.expected : 1,
  falseFireRate: t.silentTurns ? t.falseFires / t.silentTurns : 0,
});

const percentile = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

/** A scenario's start time: its `clock`, or 1 October 2026. Never the wall clock: the eval is a gate (D435). */
export function scenarioClock(scenario: Pick<Scenario, "clock">): number {
  return scenario.clock ? Date.parse(scenario.clock) : Date.UTC(2026, 9, 1);
}

export async function runScenarios(scenarios: Scenario[], options: RunOptions): Promise<Metrics> {
  if (options.reader && options.readerModel) throw new Error("a stub reader and a live reader are exclusive");
  const readerKind = options.readerModel ? ("live" as const) : options.reader;
  // The run's clock (D435): the scenario's own time, advanced one millisecond per event, is the engine's `now` and
  // every dependency's that takes one. Unset, they read the wall clock while events carry the scenario's times, and
  // the metrics moved with the date the eval was run (an invoice "due 10 November" read as past or to come).
  let clock = 0;
  const now = () => clock;
  // A capped run charges every budget to its one cap; an uncapped one keeps the old unbounded budgets.
  const budget = (limits = DEFAULT_LIMITS) => new Budget(limits, now, options.spend);
  let turns = 0;
  const total = tally();
  const byCategory = new Map<string, Tally>();
  const privacy = { secretsPlanted: 0, secretsExposed: 0, secretsLeaked: 0, injections: 0, notInert: 0 };
  const ask = { cases: 0, answered: 0, expected: 0, found: 0 };
  const latencies: number[] = [];
  const traces: Trace[] = [];
  const reports: ReaderReport[] = [];
  const pool = {
    expected: 0,
    expectedInPool: 0,
    ask: { expected: 0, expectedInPool: 0 },
    byCategory: new Map<string, { expected: number; expectedInPool: number }>(),
  };
  let readerCalls = 0;
  let readerFailures = 0;
  const acting = { labelled: false, neutral: 0, neutralFired: 0, neutralItems: 0, owed: 0, facts: 0, handed: 0 };
  const decoy = { turns: 0, handed: 0 };

  for (const scenario of scenarios) {
    const category = scenario.category ?? "general";
    if (!byCategory.has(category)) byCategory.set(category, tally());
    const tallies = [total, byCategory.get(category)!];
    for (const t of tallies) t.scenarios++;
    const secrets = scenario.secrets ?? [];
    privacy.secretsPlanted += secrets.length;
    // Items whose source text holds a planted secret: citing one is what puts the redaction to the test.
    const secretItems = new Set(
      scenario.sources.flatMap((src) =>
        src.docs
          .filter((d) => secrets.some((x) => `${d.title} ${d.text}`.includes(x)))
          .map((d) => `${src.id}:${d.ref}`),
      ),
    );
    const inspect = (text: string, citations: { itemId: string }[]) => {
      privacy.injections++;
      if (!text.includes(INERT)) privacy.notInert++;
      if (citations.some((c) => secretItems.has(c.itemId))) privacy.secretsExposed++;
      for (const secret of secrets) if (text.includes(secret)) privacy.secretsLeaked++;
    };
    const check = (got: Injection[]) => {
      for (const inj of got) inspect(inj.text, inj.citations);
    };
    clock = scenarioClock(scenario);
    const sources = scenario.sources.map((s) => new StaticSource(s.id, s.description, s.docs));
    // A fresh reader per scenario, as each scenario is its own user. Uncapped, as the lab's no-model readers are: the
    // pool is what is measured, and a stub costs nothing.
    const maker = options.reader ? readerFor(options.reader) : null;
    const oracle = maker instanceof OracleReader ? maker : null;
    const uncapped = { callsPerSession: Infinity, usdPerSession: Infinity, usdPerUserDay: Infinity };
    // The live reader is the one `buildPartner` wires: `ModelReaderMaker` on the role model, the default limits.
    const reader = maker
      ? new AskReader({ maker, budget: budget(uncapped), now })
      : options.readerModel
        ? new AskReader({
            maker: new ModelReaderMaker(options.readerModel),
            budget: budget(),
            now,
            ...(options.onReaderFailure ? { onFailure: options.onReaderFailure } : {}),
          })
        : null;
    // The push check (D828) on the reader's model, as `buildPartner` wires it with a key: only under `--live`.
    const checker =
      options.readerModel && { ...DEFAULT_CONFIG, ...options.config }.pushCheck
        ? new PushChecker({ model: options.readerModel, budget: budget() })
        : null;
    if (!pool.byCategory.has(category)) pool.byCategory.set(category, { expected: 0, expectedInPool: 0 });
    const poolTally = pool.byCategory.get(category)!;
    const partner = new ContextPartner({
      sources: async () => sources,
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: budget(),
      model: options.model,
      config: options.config,
      onTrace: (t) => traces.push(t),
      now,
      ...(options.planner ? { planner: new QueryPlanner({ seed: 1 }) } : {}),
      ...(reader ? { reader, onReader: (r: ReaderReport) => reports.push(r) } : {}),
      ...(checker ? { checker } : {}),
    });
    // The ids in the pools reported for a session between two `reports` indexes.
    const pooled = (sessionId: string, from: number, to: number) =>
      new Set(reports.slice(from, to).flatMap((r) => (r.sessionId === sessionId ? r.pool : [])));
    const who = { tenantId: EVAL_TENANT, userId: scenario.id };
    for (const session of scenario.sessions) {
      const traceStart = traces.length;
      const deliveries: string[][] = [];
      // `reports.length` as each turn starts, and once more after the trailing wait.
      const marks: number[] = [];
      for (const turn of session.turns) {
        turns++;
        marks.push(reports.length);
        // The oracle flags what this turn expects (the push's reader reads the request inside this observe).
        if (oracle) oracle.bearing = new Set(typeof turn.expect === "object" ? turn.expect.items : []);
        const event = { ...who, sessionId: session.id, at: clock++, ...turn.event } as AgentEvent;
        const t0 = performance.now();
        const result = await partner.observe(event, { waitMs: options.waitMs });
        latencies.push(performance.now() - t0);
        const got: Injection[] = [
          ...(result.injection ? [result.injection] : []),
          ...partner.takePending({ ...who, sessionId: session.id }),
        ];
        deliveries.push(got.flatMap((i) => i.citations.map((c) => c.itemId)));
        check(got);
        await Bun.sleep(1);
      }
      // Let a trailing slow path land, so the last turn's late delivery counts.
      await Bun.sleep(5);
      const trailing = partner.takePending({ ...who, sessionId: session.id });
      check(trailing);
      deliveries.push(trailing.flatMap((i) => i.citations.map((c) => c.itemId)));
      marks.push(reports.length);
      if (reader) {
        // An expected item counts as in the pool when a reader pool held it by its turn or the next one.
        session.turns.forEach((turn, i) => {
          if (typeof turn.expect !== "object") return;
          const seen = pooled(session.id, marks[i]!, marks[Math.min(i + 2, marks.length - 1)]!);
          const hit = turn.expect.items.filter((id) => seen.has(id)).length;
          for (const t of [pool, poolTally]) {
            t.expected += turn.expect.items.length;
            t.expectedInPool += hit;
          }
        });
      }

      // Score each delivered item against the turn that caused it, not the turn it arrived at: the slow path
      // may land one event late, and that must not change whether a delivery counts as a false fire. The engine's
      // traces say which turn (1-based, one per event) chose each item.
      const origin = new Map<string, number>();
      for (const t of traces.slice(traceStart)) {
        if (t.sessionId !== session.id || !["fast", "sources", "model"].includes(t.decision)) continue;
        for (const id of t.itemIds) origin.set(id, t.turn - 1);
      }
      const byOrigin: string[][] = session.turns.map(() => []);
      deliveries.forEach((ids, arrivedAt) => {
        for (const id of ids) byOrigin[Math.min(origin.get(id) ?? arrivedAt, byOrigin.length - 1)]!.push(id);
      });
      // An expected item the agent already has (delivered earlier in the session) counts as met: delivering it again
      // would be a repeat, which the engine rightly suppresses.
      const had = new Set<string>();
      session.turns.forEach((turn, i) => {
        const got = byOrigin[i]!;
        const before = new Set(had);
        for (const id of got) had.add(id);
        if (!turn.expect) return;
        // The acting suite's labels (D810) are scored apart, so the three headline numbers keep their meaning.
        if (turn.expect === "neutral") {
          acting.labelled = true;
          acting.neutral++;
          if (got.length > 0) acting.neutralFired++;
          acting.neutralItems += got.length;
          return;
        }
        if (turn.expect !== "silent" && turn.expect.decoys) {
          acting.labelled = true;
          // Scored as recall is: on what the turn caused (its own delivery, or a late one traced to it).
          decoy.turns++;
          if (turn.expect.decoys.some((id) => got.includes(id))) decoy.handed++;
          acting.owed++;
          acting.facts += turn.expect.items.length;
          acting.handed += turn.expect.items.filter((id) => got.includes(id) || before.has(id)).length;
        }
        const want = turn.expect === "silent" ? null : new Set(turn.expect.items);
        for (const t of tallies) {
          t.scoredTurns++;
          t.delivered += got.length;
          if (!want) {
            t.silentTurns++;
            if (got.length > 0) t.falseFires++;
            continue;
          }
          t.deliveredExpected += got.filter((id) => want.has(id)).length;
          t.expected += want.size;
          t.expectedFound += [...want].filter((id) => got.includes(id) || before.has(id)).length;
        }
      });
      await partner.observe({ ...who, sessionId: session.id, at: clock++, kind: "session_end" });
    }
    for (const c of scenario.asks ?? []) {
      const before = reports.length;
      if (oracle) oracle.bearing = new Set(c.expect);
      const res = await partner.ask({ ...who, sessionId: `${scenario.id}-ask`, question: c.question, maxItems: 5 });
      if (reader) {
        const seen = pooled(`${scenario.id}-ask`, before, reports.length);
        pool.ask.expected += c.expect.length;
        pool.ask.expectedInPool += c.expect.filter((id) => seen.has(id)).length;
      }
      ask.cases++;
      if (res.citations.length > 0) ask.answered++;
      if (res.answer.length > 0) inspect(res.answer, res.citations);
      const cited = new Set(res.citations.map((x) => x.itemId));
      ask.expected += c.expect.length;
      ask.found += c.expect.filter((id) => cited.has(id)).length;
    }
    readerCalls += maker?.calls ?? reader?.stats.calls ?? 0;
    readerFailures += reader?.stats.failures ?? 0;
  }

  const decisions: Record<string, number> = {};
  for (const t of traces) {
    // No-model fallback deliveries (D36) are counted apart from confident ones, so a change in either shows.
    const k = t.decision === "sources" && t.reason.startsWith("fallback:") ? "fallback" : t.decision;
    decisions[k] = (decisions[k] ?? 0) + 1;
  }
  const sum = (f: (t: Trace) => number) => traces.reduce((s, t) => s + f(t), 0);
  const readsWithPool = reports.filter((r) => r.pool.length > 0).length;
  return {
    scenarios: scenarios.length,
    turns,
    scoredTurns: total.scoredTurns,
    ...rates(total),
    counts: {
      expected: total.expected,
      found: total.expectedFound,
      delivered: total.delivered,
      deliveredExpected: total.deliveredExpected,
      silentTurns: total.silentTurns,
      falseFires: total.falseFires,
    },
    modelCallsPerTurn: turns ? sum((t) => t.modelCalls) / turns : 0,
    costPerTurnUsd: turns ? sum((t) => t.costUsd) / turns : 0,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    decisions,
    plannedLookups: traces.reduce((n, t) => n + (t.plans?.length ?? 0), 0),
    byCategory: Object.fromEntries(
      [...byCategory]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, t]) => [k, { scenarios: t.scenarios, scoredTurns: t.scoredTurns, ...rates(t) }]),
    ),
    privacy,
    ask: { cases: ask.cases, answered: ask.answered, recall: ask.expected ? ask.found / ask.expected : 1 },
    ...(readerKind
      ? {
          readerPool: {
            reader: readerKind,
            calls: readerCalls,
            failures: readerFailures,
            reads: readsWithPool,
            meanPoolItems: readsWithPool ? reports.reduce((n, r) => n + r.pool.length, 0) / readsWithPool : 0,
            expected: pool.expected,
            expectedInPool: pool.expectedInPool,
            ask: pool.ask,
            byCategory: Object.fromEntries([...pool.byCategory].sort(([a], [b]) => a.localeCompare(b))),
          },
        }
      : {}),
    ...(acting.labelled
      ? {
          acting: {
            neutralTurns: acting.neutral,
            packetsOnNeutral: acting.neutralFired,
            packetsOnNeutralRate: acting.neutral ? acting.neutralFired / acting.neutral : 0,
            itemsPerNeutralTurn: acting.neutral ? acting.neutralItems / acting.neutral : 0,
            owedTurns: acting.owed,
            factsOwed: acting.facts,
            factsHanded: acting.handed,
            factsHandedRate: acting.facts ? acting.handed / acting.facts : 0,
            decoyTurns: decoy.turns,
            decoyHanded: decoy.handed,
            decoyHandedRate: decoy.turns ? decoy.handed / decoy.turns : 0,
          },
        }
      : {}),
  };
}

/** The label every proxy block carries: the oracle reads the gold labels. */
export const ORACLE_LABEL =
  "PROXY (--reader oracle): the reader flags exactly the expected items, reading the gold labels; an upper bound on " +
  "what a perfect reader adds over this pool, not a measurement, and excluded from the headline metrics";

/**
 * An oracle run's scores, every key named as a proxy so none can be read as a headline metric. The headline metrics
 * of an oracle invocation come from a stub run (cli.ts).
 */
export function proxyOf(m: Metrics) {
  return {
    label: ORACLE_LABEL,
    proxyPrecision: m.precision,
    proxyRecall: m.recall,
    proxyFalseFireRate: m.falseFireRate,
    proxyCounts: m.counts,
    proxyAskRecall: m.ask.recall,
    proxyByCategory: Object.fromEntries(
      Object.entries(m.byCategory).map(([k, c]) => [
        k,
        { proxyPrecision: c.precision, proxyRecall: c.recall, proxyFalseFireRate: c.falseFireRate },
      ]),
    ),
    proxyDecisions: m.decisions,
  };
}

/**
 * Flags in `config` whose dependency the eval does not wire: each runs as if off. The lab's precedent is the funnel,
 * which refuses `askReader` without `--reader` (funnel.ts); cli.ts refuses that too and labels the rest.
 */
export function unwiredFlags(config: Partial<EngineConfig>, wired: { reader: boolean; checker?: boolean }): string[] {
  const out: string[] = [];
  // The push's candidates (D237) run with no reader (D276): only the reader's own reading is unwired then.
  if (config.askReader && !wired.reader) {
    out.push(
      (config.pushCandidates ?? 0) > 0
        ? "askReader's reading (needs a reader: pass --reader stub|oracle; the push's candidates run without one, D276)"
        : "askReader (needs a reader: pass --reader stub|oracle)",
    );
  }
  if (config.cards) out.push("cards (needs a card maker; the eval wires none, so no card is made or matched)");
  if (config.intent) out.push("intent (needs the card maker's intent requests; not wired)");
  // The push check (D828) needs a checker on a model: `--live` wires one on the reader's model, as the servers do.
  if (config.pushCheck && !wired.checker)
    out.push("pushCheck (needs a checker: only `--live` wires one, so no push is checked)");
  return out;
}
