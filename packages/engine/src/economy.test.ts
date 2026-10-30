import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { FRESH_WARMUP, ProbeEconomy, YIELD_WARMUP } from "./economy";
import { ContextPartner } from "./partner";

const alice = { tenantId: "t", userId: "alice" };
const bob = { tenantId: "t", userId: "bob" };
const MIN = 60_000;
const item = (id: string, text = `about ${id}`): ContextItem => ({ id, sourceId: "mail", ref: id, title: id, text });

/** Asks a query `times` times, `gap` apart, with the same answer each time. */
const steady = (e: ProbeEconomy, scope = alice, query = "Dana Lee", times = FRESH_WARMUP + 1, gap = 2 * MIN) => {
  for (let k = 0; k < times; k++) e.answered(scope, "mail", query, [item("m1")], k * gap);
  return (times - 1) * gap;
};

describe("probe economy: has the answer changed? (probeFresh)", () => {
  test("a query never asked, or a user too new to say, is always worth asking", () => {
    const e = new ProbeEconomy();
    expect(e.changeChance(alice, "mail", "Dana Lee", 0)).toBe(1);
    e.answered(alice, "mail", "Dana Lee", [item("m1")], 0);
    e.answered(alice, "mail", "Dana Lee", [item("m1")], MIN);
    expect(e.changeChance(alice, "mail", "Dana Lee", 2 * MIN)).toBe(1);
  });

  test("an answer that has not been changing is unlikely to have changed soon after; much later it may have", () => {
    const e = new ProbeEconomy();
    const last = steady(e);
    expect(e.changeChance(alice, "mail", "Dana Lee", last + MIN)).toBeLessThan(0.15);
    expect(e.changeChance(alice, "mail", "Dana Lee", last + 6 * 60 * MIN)).toBeGreaterThan(0.9);
    // Another query of the same user borrows their rate once asked: asked a minute ago, it is not asked again.
    e.answered(alice, "mail", "Sam Ortiz", [item("m2")], last);
    expect(e.changeChance(alice, "mail", "Sam Ortiz", last + MIN)).toBeLessThan(0.15);
  });

  test("an answer that changes every time stays worth asking; a changed text is a change", () => {
    const e = new ProbeEconomy();
    for (let k = 0; k <= FRESH_WARMUP; k++)
      e.answered(alice, "mail", "Dana Lee", [item("m1", `version ${k}`)], k * MIN);
    expect(e.changeChance(alice, "mail", "Dana Lee", FRESH_WARMUP * MIN + MIN)).toBeGreaterThan(0.5);
    // The last answer's ids stand in for a skipped call.
    expect(e.lastIds(alice, "mail", "Dana Lee")).toEqual(["m1"]);
  });

  test("what one user's probes learned is theirs alone, and is forgotten with them or their source", () => {
    const e = new ProbeEconomy();
    const last = steady(e);
    expect(e.changeChance(bob, "mail", "Dana Lee", last + MIN)).toBe(1);
    expect(e.lastIds(bob, "mail", "Dana Lee")).toBeNull();
    e.forget(alice, "drive");
    expect(e.changeChance(alice, "mail", "Dana Lee", last + MIN)).toBeLessThan(0.15);
    e.forget(alice, "mail");
    expect(e.changeChance(alice, "mail", "Dana Lee", last + MIN)).toBe(1);
    steady(e);
    e.forget(alice);
    expect(e.userCount).toBe(0);
  });
});

describe("probe economy: is this kind of probe worth a call to this source? (probeYield)", () => {
  test("an arm is called while new; one whose calls never reach the judge is dropped", () => {
    const e = new ProbeEconomy();
    for (let k = 0; k < YIELD_WARMUP; k++) {
      expect(e.worth(alice, "topic", "crm", 0.05)).toBe(true);
      e.called(alice, "topic", "crm", [`c${k}`]);
    }
    let calls = YIELD_WARMUP;
    while (e.worth(alice, "topic", "crm", 0.05) && calls < 200) e.called(alice, "topic", "crm", [`c${calls++}`]);
    expect(calls).toBeLessThan(80);
    // Another user, and another kind at the same source, are not affected.
    expect(e.worth(bob, "topic", "crm", 0.05)).toBe(true);
    expect(e.worth(alice, "person", "crm", 0.05)).toBe(true);
  });

  test("a dropped arm's evidence fades with each skip, so it is tried again", () => {
    const e = new ProbeEconomy();
    let k = 0;
    while (e.worth(alice, "topic", "crm", 0.05) && k < 200) e.called(alice, "topic", "crm", [`c${k++}`]);
    let skips = 0;
    while (!e.worth(alice, "topic", "crm", 0.05) && skips < 1_000) skips++;
    expect(skips).toBeGreaterThan(0);
    expect(skips).toBeLessThan(1_000);
  });

  test("a call whose find reaches the judge later is a hit; one the lookup's own search found too is not", () => {
    const hits = new ProbeEconomy();
    const claimed = new ProbeEconomy();
    for (let k = 0; k < 60; k++) {
      hits.called(alice, "person", "mail", [`m${k}`]);
      claimed.called(alice, "person", "mail", [`m${k}`]);
      claimed.claimed(alice, [`m${k}`]);
      // Reached a turn later, from the cache; reaching twice is one hit.
      hits.reached(alice, [`m${k}`, `m${k}`]);
      claimed.reached(alice, [`m${k}`]);
    }
    expect(hits.worth(alice, "person", "mail", 0.05)).toBe(true);
    expect(claimed.worth(alice, "person", "mail", 0.05)).toBe(false);
    // Bob's deliveries never credit Alice's probes.
    const e = new ProbeEconomy();
    for (let k = 0; k < 60; k++) {
      e.called(alice, "person", "mail", [`m${k}`]);
      e.reached(bob, [`m${k}`]);
    }
    expect(e.worth(alice, "person", "mail", 0.05)).toBe(false);
  });
});

describe("the probe economy in the engine", () => {
  const t0 = Date.parse("2026-10-27T09:00:00Z");
  const counting = (source: Source, log: string[]): Source => ({
    ...source,
    id: source.id,
    kind: "test",
    description: source.description,
    search: (q, signal) => (log.push(`${source.id}:${q.text}`), source.search(q, signal)),
  });
  const engine = (sources: Source[], config: Record<string, unknown>) => {
    let clock = t0;
    const p = new ContextPartner({
      sources: async () => sources,
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      // No confident fast-path answer and no 10-minute memo: every turn looks up and probes afresh.
      config: { probes: true, confidentScore: 99, probeMemoMs: 0, ...config },
    });
    const say = async (userId: string, minutes: number, text: string) => {
      clock = t0 + minutes * MIN;
      await p.observe(
        // A session per turn: the cue cooldown is per session, the probe economy per user.
        { tenantId: "t", userId, sessionId: `s${minutes}`, at: clock, kind: "user_message", text } as AgentEvent,
        { waitMs: 1_000 },
      );
    };
    return { p, say };
  };
  const GIFTS = ["chocolates", "flowers", "a card", "wine", "a cake", "tea", "books", "socks", "a plant", "coffee"];

  test("probeFresh: a person asked about again soon after, whose answer has not been changing, is not re-asked", async () => {
    const run = async (probeFresh: boolean) => {
      const log: string[] = [];
      const mail = new StaticSource("mail", "Mail", [{ ref: "d1", title: "Dana Lee", text: "Dana Lee: nut allergy" }]);
      const { say } = engine([counting(mail, log)], { probeFresh });
      // Two minutes apart (past the fan-out's one-minute result cache), each a new request.
      for (let k = 0; k < 10; k++) await say("u1", 2 * k, `Order ${GIFTS[k]} for Dana Lee`);
      const mine = log.filter((q) => q === "mail:Dana Lee").length;
      // Another user's first ask is theirs: probed.
      await say("u2", 20, "Order chocolates for Dana Lee");
      return { mine, theirs: log.filter((q) => q === "mail:Dana Lee").length - mine };
    };
    const off = await run(false);
    const on = await run(true);
    expect(off.mine).toBe(10);
    expect(on.mine).toBeLessThan(off.mine);
    expect(on.mine).toBeGreaterThanOrEqual(FRESH_WARMUP + 1);
    expect(on.theirs).toBe(1);
  });

  test("probeFresh: an answer that keeps changing keeps being asked", async () => {
    const log: string[] = [];
    let version = 0;
    const live: Source = {
      id: "mail",
      kind: "test",
      description: "Mail",
      search: async (q) => {
        log.push(q.text);
        version++;
        return [{ ...item("m1", `Dana Lee update ${version}`), title: "Dana Lee" }];
      },
    };
    const { say } = engine([live], { probeFresh: true });
    for (let k = 0; k < 10; k++) await say("u1", 2 * k, `Order ${GIFTS[k]} for Dana Lee`);
    expect(log.filter((q) => q === "Dana Lee").length).toBe(10);
  });

  test("probeYield: a source that never holds the user's people stops getting person probes; others keep them", async () => {
    // Sixty people sharing no word, so no request's own search finds another's note; the mail holds a note on every
    // third of them (the CRM on none).
    const syllables = ["ka", "lo", "mi", "ne", "ru", "sa", "to", "vi"];
    const word = (k: number, salt: number) =>
      syllables[(k + salt) % 8]! + syllables[Math.floor(k / 8) % 8]! + syllables[(k * 3 + salt) % 8]!;
    const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);
    const names = Array.from({ length: 60 }, (_, k) => `${cap(word(k, 0))}n ${cap(word(k, 5))}x`);
    const log: string[] = [];
    // A mail search that matches all of a query's words, as most do: the request's own words find nothing there, the
    // person probe finds their note.
    const notes = names
      .filter((_, k) => k % 3 === 0)
      .map((n, k) => ({ ...item(`m${k}`, `${n}: allergic to shellfish`), title: `Note from ${n}` }));
    const mail: Source = {
      id: "mail",
      kind: "test",
      description: "Mail",
      search: async (q) => {
        log.push(`mail:${q.text}`);
        const words = q.text.toLowerCase().split(/\s+/).filter(Boolean);
        return notes.filter((x) => words.length > 0 && words.every((w) => x.text.toLowerCase().includes(w)));
      },
    };
    const crm = new StaticSource("crm", "CRM", [{ ref: "c1", title: "Pipeline", text: "Q3 pipeline review" }]);
    const { say } = engine([mail, counting(crm, log)], { probeYield: true });
    for (let k = 0; k < names.length; k++) await say("u1", 2 * k, `Order ${GIFTS[k % 10]} for ${names[k]}`);
    const probed = (source: string) => log.filter((q) => names.some((n) => q === `${source}:${n}`)).length;
    expect(probed("mail")).toBe(names.length);
    expect(probed("crm")).toBeGreaterThanOrEqual(YIELD_WARMUP);
    // Dropped after a few dozen misses, then tried again now and then (a source that starts to matter is found).
    expect(probed("crm")).toBeLessThan((names.length * 2) / 3);
    // Another user starts from nothing: their first person probe goes to every source.
    const before = probed("crm");
    await say("u2", 200, `Order wine for ${names[0]}`);
    expect(probed("crm")).toBe(before + 1);
  });

  test("probeYield sends the first person to every source; off, to probePeopleSources of them", async () => {
    const run = async (probeYield: boolean) => {
      const log: string[] = [];
      const sources = Array.from({ length: 5 }, (_, k) =>
        counting(
          new StaticSource(`s${k}`, `Source ${k}`, [{ ref: "a", title: "Dana Lee", text: "Dana Lee notes" }]),
          log,
        ),
      );
      const { say } = engine(sources, { probeYield, probePeopleSources: 3 });
      await say("u1", 0, "Order chocolates for Dana Lee");
      return log.filter((q) => q.endsWith(":Dana Lee")).length;
    };
    expect(await run(false)).toBe(3);
    expect(await run(true)).toBe(5);
  });
});
