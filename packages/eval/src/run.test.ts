import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_SYSTEM, readerMessages } from "@eden/engine";
import { OpenRouterModel, type ChatRequest, type ChatResponse, type Model, type OpenRouterOptions } from "@eden/llm";
import { DEFAULT_ROLE_MODEL, modelRolesFromEnv } from "@eden/server";
import {
  counting,
  EVAL_TENANT,
  fromEnvVia,
  liveProblem,
  liveWiring,
  ORACLE_LABEL,
  proxyOf,
  runScenarios,
  unwiredFlags,
} from "./run";
import type { Scenario } from "./scenario";

const scenario = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "scenarios", "personal-assistant.json"), "utf8"),
) as Scenario;

describe("eval harness", () => {
  test("scores the seed scenario with no model: deterministic, free, and never fires on small talk", async () => {
    const m = await runScenarios([scenario], { model: null, waitMs: 1_000 });
    expect(m.scoredTurns).toBe(7);
    expect(m.falseFireRate).toBe(0);
    expect(m.modelCallsPerTurn).toBe(0);
    expect(m.recall).toBeGreaterThan(0);
  });

  test("large-subscription-lookalikes: last year's renewal notice is a sibling, not a second pick", async () => {
    const s = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "scenarios", "large-subscription-lookalikes.json"), "utf8"),
    ) as Scenario;
    const m = await runScenarios([s], { model: null, waitMs: 1_000 });
    // Delivering mail:cloudvault-renewal-2025 beside mail:cloudvault-renewal halves precision.
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.falseFireRate).toBe(0);
  });

  test("refund-request: the shop's returns policy is the order's companion, found though unscored", async () => {
    const s = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "scenarios", "refund-request.json"), "utf8"),
    ) as Scenario;
    const m = await runScenarios([s], { model: null, waitMs: 1_000 });
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.falseFireRate).toBe(0);
  });

  test("meeting-prep: the agenda doc links to the meeting's thread on a shared rare term", async () => {
    const s = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "scenarios", "meeting-prep.json"), "utf8"),
    ) as Scenario;
    const m = await runScenarios([s], { model: null, waitMs: 1_000 });
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.falseFireRate).toBe(0);
  });

  test("promised-follow-up: a stop-word-only follow-up question carries the request before it", async () => {
    const s = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "scenarios", "promised-follow-up.json"), "utf8"),
    ) as Scenario;
    const m = await runScenarios([s], { model: null, waitMs: 1_000 });
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.falseFireRate).toBe(0);
  });

  test("flight-change: the moved flight's context rides beside the clash the move would make", async () => {
    const s = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "scenarios", "flight-change.json"), "utf8"),
    ) as Scenario;
    const m = await runScenarios([s], { model: null, waitMs: 1_000 });
    // The injection cap (maxItemsPerInjection 3) bounds what one turn hands: three of the four expected.
    expect(m.precision).toBe(1);
    expect(m.recall).toBeGreaterThanOrEqual(0.75);
    expect(m.falseFireRate).toBe(0);
  });

  test("reports per category, checks planted secrets in deliveries and answers, and scores asks", async () => {
    const secret = "Kq7-plover-22";
    const s: Scenario = {
      id: "t",
      category: "adversarial",
      description: "",
      secrets: [secret],
      sources: [
        {
          id: "notes",
          description: "notes",
          docs: [{ ref: "wifi", title: "Office wifi", text: `the wifi password is ${secret}` }],
        },
      ],
      sessions: [{ id: "s", turns: [{ event: { kind: "user_message", text: "Nice day." }, expect: "silent" }] }],
      asks: [{ question: "What is the office wifi password?", expect: ["notes:wifi"] }],
    };
    const m = await runScenarios([scenario, s], { model: null, waitMs: 1_000 });
    expect(Object.keys(m.byCategory).sort()).toEqual(["adversarial", "scheduling"]);
    expect(m.byCategory.adversarial!.scoredTurns).toBe(1);
    expect(m.byCategory.scheduling!.scoredTurns).toBe(7);
    expect(m.privacy.secretsPlanted).toBe(1);
    // The answer cites the note, so the check ran, and the password was redacted.
    expect(m.ask).toEqual({ cases: 1, answered: 1, recall: 1 });
    expect(m.privacy.secretsExposed).toBeGreaterThan(0);
    expect(m.privacy.secretsLeaked).toBe(0);
    expect(m.privacy.notInert).toBe(0);
  });

  test("an expected item delivered earlier in the session counts as met, once; the credit does not cross sessions", async () => {
    const docs = [{ ref: "e1", title: "Dentist with Dr. Okafor", text: "Tuesday 9:00 at Harley Street, check-up" }];
    const ask = { kind: "user_message", text: "When is my dentist appointment with Dr. Okafor?" } as const;
    const again = { kind: "user_message", text: "Remind me about Dr. Okafor again" } as const;
    const s: Scenario = {
      id: "credit",
      description: "",
      sources: [{ id: "cal", description: "calendar", docs }],
      sessions: [
        {
          id: "a",
          turns: [
            { event: ask, expect: { items: ["cal:e1"] } },
            { event: again, expect: { items: ["cal:e1"] } },
          ],
        },
        // A new session: what the first one delivered is no credit here.
        { id: "b", turns: [{ event: { kind: "user_message", text: "Nice day." }, expect: { items: ["cal:e1"] } }] },
      ],
    };
    const m = await runScenarios([s], { model: null, waitMs: 1_000 });
    // Delivered once at the first turn: met there and (as already had) at the second; not in session b.
    expect(m.counts.delivered).toBe(1);
    expect(m.counts.expected).toBe(3);
    expect(m.counts.found).toBe(2);
  });

  test("a context_reset clears the scorer's session credit: only a re-delivery meets a later expect (D2006)", async () => {
    const docs = [
      { ref: "e1", title: "Dentist with Dr. Okafor", text: "Tuesday 9:00 at Harley Street, check-up" },
      { ref: "e2", title: "Boiler service", text: "Thursday 14:00, the engineer brings the flue kit" },
    ];
    const s: Scenario = {
      id: "reset",
      description: "",
      sources: [{ id: "cal", description: "calendar", docs }],
      sessions: [
        {
          id: "a",
          turns: [
            {
              event: { kind: "user_message", text: "When is my dentist appointment with Dr. Okafor?" },
              expect: { items: ["cal:e1"] },
            },
            // The reset turn is unscored: a packet queued pre-reset legitimately stands across it (its take
            // lands here).
            { event: { kind: "context_reset" } },
            {
              event: { kind: "user_message", text: "What time is the boiler engineer coming?" },
              expect: { items: ["cal:e2"] },
            },
            // e1 reached the agent only before the reset and nothing since re-delivered it: it must not count as
            // found here — without `had`'s reset it still would.
            {
              event: { kind: "user_message", text: "Is my garage door opener working?" },
              expect: { items: ["cal:e1"] },
            },
          ],
        },
      ],
    };
    const m = await runScenarios([s], { model: null, waitMs: 1_000 });
    expect(m.counts.expected).toBe(3);
    expect(m.counts.found).toBe(2);
  });

  test("the leak check fires: a declared secret the engine does not redact is counted, delivered or answered", async () => {
    // "bring Q3 numbers" is ordinary text in an item the seed scenario delivers: declared a secret, every delivery or
    // answer carrying it must count as a leak.
    const delivered = await runScenarios([{ ...scenario, secrets: ["bring Q3 numbers"] }], {
      model: null,
      waitMs: 1_000,
    });
    expect(delivered.privacy.secretsExposed).toBeGreaterThan(0);
    expect(delivered.privacy.secretsLeaked).toBeGreaterThan(0);
    const asked = await runScenarios(
      [
        {
          ...scenario,
          sessions: [],
          secrets: ["bring Q3 numbers"],
          asks: [{ question: "When is board prep with Marcus Webb?", expect: ["calendar:evt-board"] }],
        },
      ],
      { model: null, waitMs: 1_000 },
    );
    expect(asked.ask.answered).toBe(1);
    expect(asked.privacy.secretsLeaked).toBe(1);
  });

  test("with the planner (the server's default), lookups go through it; without, none do", async () => {
    const on = await runScenarios([scenario], { model: null, waitMs: 1_000, planner: true });
    const off = await runScenarios([scenario], { model: null, waitMs: 1_000 });
    expect(on.plannedLookups).toBeGreaterThan(0);
    expect(off.plannedLookups).toBe(0);
    expect(on.falseFireRate).toBe(0);
  });
});

const load = (id: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "scenarios", `${id}.json`), "utf8")) as Scenario;
// NEW's reader flags (packages/sim/src/lab/presets.ts); the eval wires no cards, so the rest of NEW is beside the
// point here.
// The reader's own wiring: the default's push hands the agent candidates with no reader call (D237), so these tests
// run the reader's push (`pushCandidates` 0).
const READER = { askReader: true, askReaderDrop: true, readerPush: true, pushCandidates: 0 };
const READS = { pushCandidates: 0 };

describe("eval harness: the reader family (--reader stub|oracle)", () => {
  const freeze = load("large-vendor-freeze");

  test("stub: the real AskReader is wired, its calls counted and the expected items found in its pool", async () => {
    const m = await runScenarios([freeze], { model: null, waitMs: 1_000, config: READER, reader: "stub" });
    const pool = m.readerPool!;
    expect(pool.reader).toBe("stub");
    expect(pool.calls).toBeGreaterThan(0);
    expect(pool.reads).toBe(pool.calls);
    // The acting request's two expected items (the hold and the invoice) were both in what the reader would read.
    expect(pool).toMatchObject({ expected: 2, expectedInPool: 2 });
    expect(pool.byCategory.purchases).toEqual({ expected: 2, expectedInPool: 2 });
    expect(m.decisions["reader-push"]).toBeGreaterThan(0);
    // A stub never binds: the hold, which shares few words with the request, is still not delivered.
    expect(m.counts.found).toBe(1);
    // The engine traces the reader's calls as model calls (the rate a real reader would be called at); they cost $0.
    expect(m.modelCallsPerTurn).toBe(pool.calls / m.turns);
    expect(m.costPerTurnUsd).toBe(0);
  });

  test("without --reader no reader is wired: askReader is inert and there is no pool report", async () => {
    const m = await runScenarios([freeze], { model: null, waitMs: 1_000, config: READER });
    expect(m.readerPool).toBeUndefined();
    expect(m.decisions["reader-push"]).toBeUndefined();
  });

  test("oracle: flags exactly the expected items, so the hold is delivered; its scores are labelled proxies", async () => {
    const m = await runScenarios([freeze], { model: null, waitMs: 1_000, config: READER, reader: "oracle" });
    expect(m.counts.found).toBe(2);
    expect(m.falseFireRate).toBe(0);
    const proxy = proxyOf(m);
    expect(proxy.label).toBe(ORACLE_LABEL);
    expect(proxy.label).toStartWith("PROXY");
    // Every score key names itself a proxy, at the top and per category: none reads as a headline metric.
    for (const k of Object.keys(proxy).filter((k) => k !== "label")) expect(k).toStartWith("proxy");
    for (const c of Object.values(proxy.proxyByCategory)) {
      for (const k of Object.keys(c)) expect(k).toStartWith("proxy");
    }
    expect(proxy.proxyCounts.found).toBe(2);
  });

  test("flags whose dependency the eval does not wire are named", () => {
    expect(unwiredFlags({}, { reader: false })).toEqual([]);
    // The push check (D828) is wired only under `--live`.
    expect(unwiredFlags({ pushCheck: true }, { reader: false })[0]).toMatch(/^pushCheck/);
    expect(unwiredFlags({ pushCheck: true }, { reader: true, checker: true })).toEqual([]);
    expect(unwiredFlags({ askReader: true }, { reader: true })).toEqual([]);
    const named = unwiredFlags({ askReader: true, cards: true, intent: true }, { reader: false }).map(
      (s) => s.split(" ")[0],
    );
    expect(named).toEqual(["askReader", "cards", "intent"]);
  });
});

/** Stands in for OpenRouter (no network): records each request, bills `costUsd`, answers "nothing bears" or throws. */
class FakeRoleModel implements Model {
  readonly calls: ChatRequest[] = [];
  constructor(
    readonly options: OpenRouterOptions,
    private readonly behave: { costUsd?: number; throws?: string } = {},
  ) {}
  get id() {
    return this.options.model;
  }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    if (this.behave.throws) throw new Error(this.behave.throws);
    const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 };
    const costUsd = this.behave.costUsd ?? 0;
    return { text: '{"bears":[]}', usage, costUsd, model: this.id, latencyMs: 0, truncated: false };
  }
}

/** A factory of fakes, keeping what it made. */
const factory = (behave: { costUsd?: number; throws?: string } = {}) => {
  const made: FakeRoleModel[] = [];
  const make = (o: OpenRouterOptions) => {
    const m = new FakeRoleModel(o, behave);
    made.push(m);
    return m;
  };
  return { made, make };
};

const KEYED = { OPENROUTER_API_KEY: "test-key-not-real" };

describe("eval harness: --live wires what ships (D128)", () => {
  const freeze = load("large-vendor-freeze");
  // The reader's system prompt, as ModelReaderMaker sends it.
  const readerSystem = readerMessages({ request: "x", items: [], today: "2026-10-01" })[0]!.content;

  test("shipped: no judge, and the reader is ModelReaderMaker on the servers' role model and routing", async () => {
    const { made, make } = factory();
    const live = liveWiring({ judge: false, usdCap: 1, env: KEYED, make })!;
    expect(live.model).toBeNull();
    // The model the servers build with a key: the reader role is the first made, Haiku 5.5, throughput-routed, ZDR.
    const roles = modelRolesFromEnv(KEYED, (o) => new FakeRoleModel(o));
    expect((live.readerModel as FakeRoleModel).options).toEqual((roles.reader as FakeRoleModel).options);
    expect(made[0]!.options).toMatchObject({ model: DEFAULT_ROLE_MODEL, sort: "throughput", zdr: true });
    expect(live.readerModel).toBe(made[0]!);
    // The shipped default (D237) makes no reader call: the push hands the agent candidates.
    const shipped = await runScenarios([freeze], {
      model: live.model,
      waitMs: 1_000,
      readerModel: live.readerModel,
      spend: live.spend,
    });
    // The shipped default (D828) makes no reader call; its only calls are the push check's, on the same role model,
    // as `buildPartner` wires it (this fake's reply is not a check's, so each push fails open to its candidates).
    for (const c of made[0]!.calls) expect(c.messages[0]!.content).toBe(CHECK_SYSTEM);
    expect(shipped.decisions["reader-push"]).toBeGreaterThan(0);
    const checks = made[0]!.calls.length;
    const m = await runScenarios([freeze], {
      model: live.model,
      waitMs: 1_000,
      readerModel: live.readerModel,
      spend: live.spend,
      config: READS,
    });
    const calls = made[0]!.calls.slice(checks).filter((c) => c.messages[0]!.content !== CHECK_SYSTEM);
    expect(calls.length).toBeGreaterThan(0);
    // Every call is the reader's, made as ModelReaderMaker makes it: its prompt, JSON, no reasoning (D144); no judge.
    for (const c of calls) {
      expect(c.messages[0]!.content).toBe(readerSystem);
      expect(c).toMatchObject({ json: true, maxTokens: 2_000 });
      expect("reasoning" in c).toBe(false);
    }
    expect(m.readerPool).toMatchObject({ reader: "live", calls: calls.length, failures: 0 });
    expect(m.decisions.model).toBeUndefined();
  });

  test("--judge reproduces the old wiring: the judge from OpenRouterModel.fromEnv, no live reader", async () => {
    const { made, make } = factory();
    const old = liveWiring({ judge: true, usdCap: 1, env: KEYED, make })!;
    expect(old.readerModel).toBeNull();
    expect(old.model).toBe(made[0]!);
    // fromEnvVia builds exactly OpenRouterModel.fromEnv's model (its options, the key included, compared as JSON).
    expect(JSON.stringify(new OpenRouterModel(made[0]!.options))).toBe(JSON.stringify(OpenRouterModel.fromEnv(KEYED)));
    expect(fromEnvVia({}, make)).toBeNull();
    // Without a factory it is OpenRouterModel.fromEnv's own model.
    const real = liveWiring({ judge: true, usdCap: 1, env: KEYED })!;
    expect(real.model).toBeInstanceOf(OpenRouterModel);
    expect(real.model!.id).toBe("z-ai/glm-5.3-flash");
    expect(real.readerModel).toBeNull();
    // The stub reader beside the judge, as `--live --judge --reader stub` runs (the old `--live --reader stub`).
    const m = await runScenarios([freeze], { model: old.model, waitMs: 1_000, reader: "stub", spend: old.spend });
    expect(m.readerPool!.reader).toBe("stub");
    expect(made.length).toBe(1);
  });

  test("no key: no wiring; a cap that is not a positive number is refused", () => {
    expect(liveWiring({ judge: false, usdCap: 1, env: {} })).toBeNull();
    expect(liveWiring({ judge: true, usdCap: 1, env: {} })).toBeNull();
    for (const cap of [0, -1, NaN, Infinity]) {
      expect(() => liveWiring({ judge: false, usdCap: cap, env: KEYED, make: factory().make })).toThrow();
    }
  });

  test("the cap is hard: past it the budget refuses the call, and the run falls back to its no-model path", async () => {
    const free = factory();
    const uncapped = liveWiring({ judge: false, usdCap: 100, env: KEYED, make: free.make })!;
    // Every scenario: several of them call the reader, so the cap is shared across scenarios, not per scenario.
    const dir = join(import.meta.dir, "..", "scenarios");
    const every = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario);
    const wide = {
      model: null,
      waitMs: 1_000,
      readerModel: uncapped.readerModel,
      spend: uncapped.spend,
      config: READS,
    };
    await runScenarios(every, wide);
    expect(free.made[0]!.calls.length).toBeGreaterThan(1);
    // $0.002 a call (the reader's reservation estimate) under a $0.003 cap: one call, then refusals.
    const paid = factory({ costUsd: 0.002 });
    const capped = liveWiring({ judge: false, usdCap: 0.003, env: KEYED, make: paid.make })!;
    const m = await runScenarios(every, {
      model: null,
      waitMs: 1_000,
      readerModel: capped.readerModel,
      spend: capped.spend,
      config: READS,
    });
    expect(paid.made[0]!.calls.length).toBe(1);
    expect(capped.spend.spent(EVAL_TENANT)).toBeCloseTo(0.002, 10);
    expect(m.falseFireRate).toBe(0);
  });

  test("a reader refused on every call is counted and told, and the run still scores (fail open)", async () => {
    const refused = factory({ throws: "openrouter 403: violation of provider Terms Of Service" });
    const live = liveWiring({ judge: false, usdCap: 1, env: KEYED, make: refused.make })!;
    const told: unknown[] = [];
    const m = await runScenarios([freeze], {
      model: null,
      waitMs: 1_000,
      readerModel: live.readerModel,
      spend: live.spend,
      onReaderFailure: (e) => told.push(e),
      config: READS,
    });
    const calls = refused.made[0]!.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(m.readerPool).toMatchObject({ calls, failures: calls });
    expect(told.length).toBe(calls);
    // Delivered what the stub run delivers: a failed reading changes nothing the rules deliver.
    const stub = await runScenarios([freeze], { model: null, waitMs: 1_000, reader: "stub", config: READS });
    expect(m.counts).toEqual(stub.counts);
  });

  test("the shipped default's live calls are the push check's: counted, failures told, reported as pushCheck", async () => {
    // An OpenRouter 403 on every call (what this sandbox gets for anthropic/* models): before, the eval wired no
    // `onFailure` for the check and printed no check counters, so a live run read as $0 and no model call at all.
    const refused = factory({ throws: "openrouter 403: This model is not available in your region." });
    const live = liveWiring({ judge: false, usdCap: 1, env: KEYED, make: refused.make })!;
    const told: unknown[] = [];
    const m = await runScenarios([freeze], {
      model: null,
      waitMs: 1_000,
      readerModel: live.readerModel,
      spend: live.spend,
      onCheckFailure: (e) => told.push(e),
    });
    const calls = refused.made[0]!.calls.length;
    expect(calls).toBeGreaterThan(0);
    for (const c of refused.made[0]!.calls) expect(c.messages[0]!.content).toBe(CHECK_SYSTEM);
    // The shipped default calls no reader (D237): its pool report says 0, which alone read as "no model call".
    expect(m.readerPool).toMatchObject({ reader: "live", calls: 0 });
    expect(m.pushCheck).toMatchObject({ calls, failures: calls, costUsd: 0 });
    expect(m.pushCheck!.asked).toBeGreaterThanOrEqual(calls);
    expect(told.length).toBe(calls);
    // The run fails loudly: every model call failed.
    expect(liveProblem(m)).toContain(`all ${calls} model calls failed`);
    // Answered calls: no problem.
    const ok = factory();
    const fine = liveWiring({ judge: false, usdCap: 1, env: KEYED, make: ok.make })!;
    const answered = await runScenarios([freeze], {
      model: null,
      waitMs: 1_000,
      readerModel: fine.readerModel,
      spend: fine.spend,
      config: READS,
    });
    expect(answered.readerPool!.calls).toBeGreaterThan(0);
    expect(liveProblem(answered)).toBeNull();
  });

  test("--live --judge with a stub reader: a judge refused on every call is a problem (the stub's calls are free)", async () => {
    const refused = factory({ throws: "openrouter 403: This model is not available in your region." });
    const old = liveWiring({ judge: true, usdCap: 1, env: KEYED, make: refused.make })!;
    const judge = { calls: 0, failures: 0 };
    const m = await runScenarios([freeze], {
      model: counting(old.model!, judge),
      waitMs: 1_000,
      reader: "stub",
      spend: old.spend,
    });
    expect(m.readerPool!.reader).toBe("stub");
    expect(judge.calls).toBe(refused.made[0]!.calls.length);
    expect(judge.calls).toBeGreaterThan(0);
    expect(judge.failures).toBe(judge.calls);
    // Before, the stub reader's free calls counted as live ones, so this run read as measured.
    expect(liveProblem(m, judge)).toContain(`all ${judge.calls} model calls failed`);
    // A stub reader that read (over all scenarios it did once) is free: its call does not make the run measured.
    const stubRead = { ...m, readerPool: { ...m.readerPool!, calls: 1 } };
    expect(liveProblem(stubRead, judge)).toContain(`all ${judge.calls} model calls failed`);
    // The same run with a judge that answers is fine.
    const ok = factory();
    const fine = liveWiring({ judge: true, usdCap: 1, env: KEYED, make: ok.make })!;
    const answered = { calls: 0, failures: 0 };
    const n = await runScenarios([freeze], {
      model: counting(fine.model!, answered),
      waitMs: 1_000,
      reader: "stub",
      spend: fine.spend,
    });
    expect(answered.calls).toBeGreaterThan(0);
    expect(liveProblem(n, answered)).toBeNull();
  });

  test("a run the budget cap stopped before any call says so, not that no check ran", async () => {
    // Under the check's estimate: every check is refused by the budget before a call.
    const paid = factory({ costUsd: 0.002 });
    const capped = liveWiring({ judge: false, usdCap: 0.0001, env: KEYED, make: paid.make })!;
    const m = await runScenarios([freeze], {
      model: null,
      waitMs: 1_000,
      readerModel: capped.readerModel,
      spend: capped.spend,
    });
    expect(paid.made[0]!.calls.length).toBe(0);
    expect(m.pushCheck!.calls).toBe(0);
    expect(m.pushCheck!.asked).toBeGreaterThan(0);
    expect(m.pushCheck!.overBudget).toBeGreaterThan(0);
    expect(liveProblem(m)).toContain("the budget cap refused every model call");
    expect(liveProblem({ ...m, pushCheck: { ...m.pushCheck!, overBudget: 0 } })).toContain("no model call");
  });

  test("a live run that attempts no model call is a problem, named as such", () => {
    const quiet = { modelCallsPerTurn: 0, readerPool: { calls: 0, failures: 0 }, pushCheck: { calls: 0, failures: 0 } };
    expect(liveProblem(quiet as never)).toContain("no model call");
    // The judge shape counts its calls per turn only.
    expect(liveProblem({ modelCallsPerTurn: 0 } as never)).toContain("no model call");
    expect(liveProblem({ modelCallsPerTurn: 0.5 } as never)).toBeNull();
  });

  test("a stub reader and a live one are exclusive", async () => {
    const live = liveWiring({ judge: false, usdCap: 1, env: KEYED, make: factory().make })!;
    const both = { model: null, waitMs: 0, reader: "stub" as const, readerModel: live.readerModel };
    expect(runScenarios([freeze], both)).rejects.toThrow("exclusive");
  });
});

describe("scenarios", () => {
  const dir = join(import.meta.dir, "..", "scenarios");
  const all = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario);

  test("every expected item exists in its scenario's sources", () => {
    for (const s of all) {
      const ids = new Set(s.sources.flatMap((src) => src.docs.map((d) => `${src.id}:${d.ref}`)));
      const wanted = [
        ...s.sessions.flatMap((x) => x.turns.flatMap((t) => (typeof t.expect === "object" ? t.expect.items : []))),
        ...(s.asks ?? []).flatMap((a) => a.expect),
      ];
      for (const id of wanted) expect(`${s.id}: ${id} ${ids.has(id)}`).toBe(`${s.id}: ${id} true`);
    }
  });

  test("the large scenarios hold 50+ documents each, so retrieval is not trivial", () => {
    const large = all.filter((s) => s.id.startsWith("large-"));
    expect(large.length).toBeGreaterThanOrEqual(3);
    for (const s of large) expect(s.sources.reduce((n, src) => n + src.docs.length, 0)).toBeGreaterThanOrEqual(50);
  });
});

describe("the acting suite (D810)", () => {
  const dir = join(import.meta.dir, "..", "scenarios", "acting");
  const acting = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario);
  const labelled = acting.flatMap((s) => s.sessions.flatMap((x) => x.turns.filter((t) => t.expect)));
  const run = (config = {}) => runScenarios(acting, { model: null, waitMs: 2_000, planner: true, config });

  test("every label is a request, and every owed fact and look-alike exists in its scenario's sources", () => {
    expect(acting.length).toBeGreaterThanOrEqual(30);
    // One request a user: a scenario is one session of a start and one labelled request, so a request is scored on its
    // own user's state and the order of the files changes nothing (the review found 18 of 28 neutral packets in order,
    // 21 alone, when a world's requests shared a user).
    for (const s of acting) {
      expect(s.sessions).toHaveLength(1);
      const turns = s.sessions[0]!.turns;
      expect(turns.filter((t) => t.expect)).toHaveLength(1);
      expect(turns.at(-1)!.expect).toBeDefined();
    }
    for (const t of labelled) {
      expect(t.event.kind).toBe("user_message");
      expect(t.expect === "neutral" || (typeof t.expect === "object" && (t.expect.decoys?.length ?? 0) > 0)).toBe(true);
    }
    for (const s of acting) {
      const ids = new Set(s.sources.flatMap((src) => src.docs.map((d) => `${src.id}:${d.ref}`)));
      for (const t of s.sessions.flatMap((x) => x.turns)) {
        if (typeof t.expect !== "object") continue;
        for (const id of [...t.expect.items, ...(t.expect.decoys ?? [])])
          expect(`${s.id}: ${id} ${ids.has(id)}`).toBe(`${s.id}: ${id} true`);
        // A look-alike is never also the owed fact.
        for (const id of t.expect.decoys ?? []) expect(t.expect.items).not.toContain(id);
      }
    }
  });

  test("the default starts its push on every labelled request, and the block counts what it hands", async () => {
    const m = await run();
    // Every neutral and owed request acts (a listed verb or an opened one): the suite measures the push, not its gate.
    expect(m.decisions["reader-push"]).toBe(labelled.length);
    const a = m.acting!;
    expect(a.neutralTurns).toBe(labelled.filter((t) => t.expect === "neutral").length);
    expect(a.owedTurns + a.neutralTurns).toBe(labelled.length);
    expect(a.decoyTurns).toBe(a.owedTurns);
    expect(a.packetsOnNeutral).toBeGreaterThan(0);
    expect(a.factsHanded).toBeGreaterThan(0);
    // Neutral and look-alike labels never enter the three headline numbers: no silent turn in the suite.
    expect(m.counts.silentTurns).toBe(0);
    expect(m.counts.expected).toBe(a.factsOwed);
  });

  test("it sees the push's parts: pushOpen and the candidates move it", async () => {
    const on = (await run()).acting!;
    const open = (await run({ pushOpen: false })).acting!;
    const none = (await run({ pushCandidates: 0 })).acting!;
    expect(open.packetsOnNeutral).toBeLessThan(on.packetsOnNeutral);
    expect(none.packetsOnNeutral).toBeLessThan(open.packetsOnNeutral);
    expect(none.factsHanded).toBeLessThan(on.factsHanded);
  }, 30_000); // Three runs of the suite: about 1.5 s alone.

  test("a scenario without its labels reports no acting block", async () => {
    const m = await runScenarios([scenario], { model: null, waitMs: 0 });
    expect(m.acting).toBeUndefined();
  });
});

describe("the eval's clock (D435)", () => {
  // Runs `fn` with the wall clock moved to `iso` (Date.now and `new Date()`): what a run on that day would read.
  async function on<T>(iso: string, fn: () => Promise<T>): Promise<T> {
    const Real = Date;
    const shift = Real.parse(iso) - Real.now();
    class Shifted extends Real {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(Real.now() + shift);
        else super(...(args as [number]));
      }
      static override now() {
        return Real.now() + shift;
      }
    }
    globalThis.Date = Shifted as DateConstructor;
    try {
      return await fn();
    } finally {
      globalThis.Date = Real;
    }
  }
  const dir = join(import.meta.dir, "..", "scenarios");
  const all = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario);
  const scored = (m: Awaited<ReturnType<typeof runScenarios>>) => {
    const { latencyP50Ms: _p50, latencyP95Ms: _p95, ...rest } = m;
    return rest;
  };

  test("every scenario scores the same whatever day the eval runs on", async () => {
    // 2026-11-07 and 2026-11-10 read precision 0.65 and 0.684 before the clock was pinned: on the 10th, "today" in
    // large-vendor-freeze's request was the day its invoice falls due, and the push handed fewer candidates (D400).
    const run = () => runScenarios(all, { model: null, waitMs: 2_000, planner: true, config: {} });
    const a = scored(await on("2026-11-07T12:00:00Z", run));
    const b = scored(await on("2026-11-10T12:00:00Z", run));
    const c = scored(await on("2031-03-01T00:00:00Z", run));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  test("the partner's clock is the scenario's: the push reads its request's day from it, not the wall clock", async () => {
    const vendor = all.find((s) => s.id === "large-vendor-freeze")!;
    const m = await on("2026-11-10T12:00:00Z", () => runScenarios([vendor], { model: null, waitMs: 2_000 }));
    // Its clock is 3 November: "today" is not the invoice's due day, so nothing settles the request and the push
    // hands its candidates — the two that stand up to it since D1970, the look-alikes dropped.
    expect(m.counts.delivered).toBe(2);
  });
});
