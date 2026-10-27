/**
 * Plays scenarios through a real `ContextPartner` and scores what it delivered. Deterministic with no model or a
 * `FakeModel`; with `--live` it uses OpenRouter and reports real cost.
 */
import { ContextPartner, ItemCache, type EngineConfig, type Trace } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, type Model } from "@eden/llm";
import type { AgentEvent, Injection } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import type { Scenario } from "./scenario";

export interface RunOptions {
  model: Model | null;
  /**
   * How long each event waits for the slow path. 0 measures the fast path plus next-event delivery: the runner
   * yields between events (as real traffic would), so a slow path started at one event can land by the next.
   */
  waitMs: number;
  config?: Partial<EngineConfig>;
}

export interface Metrics {
  scenarios: number;
  turns: number;
  scoredTurns: number;
  /** Delivered items that were expected, over all delivered items on scored turns. */
  precision: number;
  /** Expected items delivered by their turn or the next, over all expected items. */
  recall: number;
  /** Silent-labelled turns where something was delivered, over silent-labelled turns. */
  falseFireRate: number;
  modelCallsPerTurn: number;
  costPerTurnUsd: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  decisions: Record<string, number>;
}

const percentile = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

export async function runScenarios(scenarios: Scenario[], options: RunOptions): Promise<Metrics> {
  let turns = 0;
  let scoredTurns = 0;
  let delivered = 0;
  let deliveredExpected = 0;
  let expected = 0;
  let expectedFound = 0;
  let silentTurns = 0;
  let falseFires = 0;
  const latencies: number[] = [];
  const traces: Trace[] = [];

  for (const scenario of scenarios) {
    const sources = scenario.sources.map((s) => new StaticSource(s.id, s.description, s.docs));
    const partner = new ContextPartner({
      sources: async () => sources,
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: options.model,
      config: options.config,
      onTrace: (t) => traces.push(t),
    });
    const who = { tenantId: "eval", userId: scenario.id };
    let clock = Date.UTC(2026, 9, 1);
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
        await Bun.sleep(1);
      }
      // Let a trailing slow path land, so the last turn's late delivery counts.
      await Bun.sleep(5);
      deliveries.push(
        partner.takePending({ ...who, sessionId: session.id }).flatMap((i) => i.citations.map((c) => c.itemId)),
      );

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
      session.turns.forEach((turn, i) => {
        if (!turn.expect) return;
        scoredTurns++;
        const got = byOrigin[i]!;
        delivered += got.length;
        if (turn.expect === "silent") {
          silentTurns++;
          if (got.length > 0) falseFires++;
          return;
        }
        const want = new Set(turn.expect.items);
        deliveredExpected += got.filter((id) => want.has(id)).length;
        expected += want.size;
        expectedFound += [...want].filter((id) => got.includes(id)).length;
      });
      await partner.observe({ ...who, sessionId: session.id, at: clock++, kind: "session_end" });
    }
  }

  const decisions: Record<string, number> = {};
  for (const t of traces) decisions[t.decision] = (decisions[t.decision] ?? 0) + 1;
  const sum = (f: (t: Trace) => number) => traces.reduce((s, t) => s + f(t), 0);
  return {
    scenarios: scenarios.length,
    turns,
    scoredTurns,
    precision: delivered ? deliveredExpected / delivered : 1,
    recall: expected ? expectedFound / expected : 1,
    falseFireRate: silentTurns ? falseFires / silentTurns : 0,
    modelCallsPerTurn: turns ? sum((t) => t.modelCalls) / turns : 0,
    costPerTurnUsd: turns ? sum((t) => t.costUsd) / turns : 0,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    decisions,
  };
}
