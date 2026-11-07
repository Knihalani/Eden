import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readerMessages } from "@eden/engine";
import { OpenRouterModel, type ChatRequest, type ChatResponse, type Model, type OpenRouterOptions } from "@eden/llm";
import { DEFAULT_ROLE_MODEL, modelRolesFromEnv } from "@eden/server";
import { EVAL_TENANT, fromEnvVia, liveWiring, ORACLE_LABEL, proxyOf, runScenarios, unwiredFlags } from "./run";
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
    expect(made[0]!.calls.length).toBe(0);
    // The push ran and read nothing: its traces are there, with no model call.
    expect(shipped.decisions["reader-push"]).toBeGreaterThan(0);
    const m = await runScenarios([freeze], {
      model: live.model,
      waitMs: 1_000,
      readerModel: live.readerModel,
      spend: live.spend,
      config: READS,
    });
    const calls = made[0]!.calls;
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
        ...s.sessions.flatMap((x) => x.turns.flatMap((t) => (t.expect && t.expect !== "silent" ? t.expect.items : []))),
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
