/**
 * Plays scenarios through a real `ContextPartner` and scores what it delivered. Deterministic with no model or a
 * `FakeModel`; with `--live` it uses OpenRouter and reports real cost.
 */
import { ContextPartner, ItemCache, type EngineConfig, type Trace } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, type Model } from "@eden/llm";
import type { AgentEvent, Injection } from "@eden/protocol";
import { QueryPlanner, StaticSource } from "@eden/sources";
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

export async function runScenarios(scenarios: Scenario[], options: RunOptions): Promise<Metrics> {
  let turns = 0;
  const total = tally();
  const byCategory = new Map<string, Tally>();
  const privacy = { secretsPlanted: 0, secretsExposed: 0, secretsLeaked: 0, injections: 0, notInert: 0 };
  const ask = { cases: 0, answered: 0, expected: 0, found: 0 };
  const latencies: number[] = [];
  const traces: Trace[] = [];

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
    const sources = scenario.sources.map((s) => new StaticSource(s.id, s.description, s.docs));
    const partner = new ContextPartner({
      sources: async () => sources,
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: options.model,
      config: options.config,
      onTrace: (t) => traces.push(t),
      ...(options.planner ? { planner: new QueryPlanner({ seed: 1 }) } : {}),
    });
    const who = { tenantId: "eval", userId: scenario.id };
    let clock = scenario.clock ? Date.parse(scenario.clock) : Date.UTC(2026, 9, 1);
    for (const session of scenario.sessions) {
      const traceStart = traces.length;
      const deliveries: string[][] = [];
      for (const turn of session.turns) {
        turns++;
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
      const res = await partner.ask({ ...who, sessionId: `${scenario.id}-ask`, question: c.question, maxItems: 5 });
      ask.cases++;
      if (res.citations.length > 0) ask.answered++;
      if (res.answer.length > 0) inspect(res.answer, res.citations);
      const cited = new Set(res.citations.map((x) => x.itemId));
      ask.expected += c.expect.length;
      ask.found += c.expect.filter((id) => cited.has(id)).length;
    }
  }

  const decisions: Record<string, number> = {};
  for (const t of traces) {
    // No-model fallback deliveries (D36) are counted apart from confident ones, so a change in either shows.
    const k = t.decision === "sources" && t.reason.startsWith("fallback:") ? "fallback" : t.decision;
    decisions[k] = (decisions[k] ?? 0) + 1;
  }
  const sum = (f: (t: Trace) => number) => traces.reduce((s, t) => s + f(t), 0);
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
  };
}
