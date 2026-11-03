import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ORACLE_LABEL, proxyOf, runScenarios, unwiredFlags } from "./run";
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
const READER = { askReader: true, askReaderDrop: true, readerPush: true };

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
