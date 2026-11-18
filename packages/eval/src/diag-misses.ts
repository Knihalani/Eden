// Per-turn replay of the weakest eval categories: what each turn asked for, what it expected and what was
// delivered, with the engine's trace decision for each turn. Diagnosis only, not a repo test.
//   bun packages/eval/src/diag-misses.ts [category ...]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";
import { Budget, DEFAULT_LIMITS } from "@eden/llm";
import type { AgentEvent, Injection } from "@eden/protocol";
import { QueryPlanner, StaticSource } from "@eden/sources";
import { ItemCache } from "../../engine/src/cache";
import { ContextPartner } from "../../engine/src/partner";
import { DEFAULT_CONFIG } from "../../engine/src/config";
import { scenarioClock, EVAL_TENANT } from "./run";
import type { Scenario } from "./scenario";

const want = process.argv.slice(2);
const dir = join(import.meta.dir, "..", "scenarios");
const scenarios: Scenario[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario)
  .filter((s) => want.length === 0 || want.includes(s.category ?? "general"));

for (const scenario of scenarios) {
  let clock = scenarioClock(scenario);
  const sources = scenario.sources.map((s) => new StaticSource(s.id, s.description, s.docs));
  const now = () => clock;
  const traces: { decision: string; reason: string; itemIds?: string[] }[] = [];
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(DEFAULT_LIMITS, now),
    model: null,
    config: DEFAULT_CONFIG,
    onTrace: (t) => traces.push(t as never),
    now,
    planner: new QueryPlanner({ seed: 1 }),
  });
  const who = { tenantId: EVAL_TENANT, userId: scenario.id };
  console.log(`\n=== ${scenario.id} (${scenario.category}) — ${scenario.description ?? ""}`);
  for (const session of scenario.sessions) {
    for (const [ti, turn] of session.turns.entries()) {
      traces.length = 0;
      const event = { ...who, sessionId: session.id, at: clock++, ...turn.event } as AgentEvent;
      const result = await partner.observe(event, { waitMs: 2_000 });
      const got: Injection[] = [
        ...(result.injection ? [result.injection] : []),
        ...partner.takePending({ ...who, sessionId: session.id }),
      ];
      const ids = got.flatMap((i) => i.citations.map((c) => c.itemId));
      const expect = turn.expect;
      const expected = typeof expect === "object" ? expect.items : [];
      const text = "text" in turn.event ? turn.event.text : turn.event.kind;
      const tag = typeof expect === "object" ? "EXPECT" : expect === "silent" ? "silent" : "      ";
      const mark = expected.length > 0 && !expected.every((id) => ids.includes(id)) ? "MISS" : "ok  ";
      console.log(`  [${mark}] ${tag} turn${ti} "${String(text).slice(0, 80)}"`);
      if (expected.length) console.log(`       expected: ${expected.join(", ")}`);
      if (ids.length) console.log(`       got:      ${ids.join(", ")}`);
      for (const t of traces) console.log(`       trace:    ${t.decision} | ${t.reason} | ${(t.itemIds ?? []).join(",")}`);
    }
    await partner.observe({ ...who, sessionId: session.id, at: clock++, kind: "session_end" } as AgentEvent, {
      waitMs: 50,
    });
  }
}
