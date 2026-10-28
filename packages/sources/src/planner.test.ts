import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import {
  cueCoverage,
  PlannedSource,
  QueryPlanner,
  type PlanCalls,
  type PlannerArm,
  type PlannerStore,
} from "./planner";
import type { SearchQuery, Source } from "./source";

const signal = new AbortController().signal;
const alice = { tenantId: "t", userId: "alice" };

/** Items about people; each search kind is one of the behaviours the connector lab measured. */
const DOCS = [
  { ref: "1", title: "Dinner with Jamie Fox", text: "Thursday at Barrafina with Jamie Fox" },
  { ref: "2", title: "Globex renewal", text: "Sam Ortiz wants a three year renewal for Globex" },
  { ref: "3", title: "Team lunch", text: "Lunch on Friday, everyone welcome" },
  { ref: "4", title: "Invoice 42", text: "Payment due for Globex invoice" },
];

function connector(id: string, match: (q: string, doc: (typeof DOCS)[number]) => boolean): Source & { log: string[] } {
  const log: string[] = [];
  return {
    id,
    kind: "test",
    description: id,
    log,
    async search(q: SearchQuery): Promise<ContextItem[]> {
      log.push(q.text);
      return DOCS.filter((d) => match(q.text, d)).map((d) => ({ id: `${id}:${d.ref}`, sourceId: id, ...d }));
    },
  };
}
const hay = (d: (typeof DOCS)[number]) => `${d.title} ${d.text}`.toLowerCase();
/** The whole query as one case-insensitive substring (reference memory server, CalDAV, IMAP fields). */
const substring = () => connector("substring", (q, d) => hay(d).includes(q.toLowerCase()));
/** Any query word (mcpvault). */
const anyWord = () =>
  connector("or", (q, d) =>
    q
      .toLowerCase()
      .split(" ")
      .some((w) => hay(d).includes(w)),
  );

const query = (text: string, entities: string[], scope = alice): SearchQuery => ({ scope, text, entities, limit: 5 });
const cues = [
  query("dinner jamie fox", ["Jamie Fox"]),
  query("globex renewal sam ortiz", ["Globex", "Sam Ortiz"]),
  query("invoice globex", ["Globex"]),
];

describe("QueryPlanner", () => {
  test("learns per entity on a substring connector, where the cue's terms find nothing", async () => {
    const planner = new QueryPlanner({ seed: 3, cascade: false });
    const src = substring();
    for (let i = 0; i < 60; i++) await planner.search(src, cues[i % cues.length]!, signal);
    const m = planner.means(alice, "substring", true);
    expect(m["each-entity"]).toBeGreaterThan(0.5);
    // The incumbent (terms) starts at 0.75; every try comes back empty, so it falls below the shape that works.
    expect(m.terms).toBeLessThan(0.75);
    expect(m.terms).toBeLessThan(m["each-entity"]);
    // Late lookups mostly use the learned shape (ε keeps some exploration).
    let perEntity = 0;
    for (let i = 0; i < 20; i++) {
      const r = await planner.search(src, cues[i % cues.length]!, signal);
      if (r.shapes[0] === "each-entity" || r.shapes[0] === "entities") perEntity++;
    }
    expect(perEntity).toBeGreaterThanOrEqual(15);
  });

  test("on an OR connector the cue's terms are not penalised", async () => {
    const planner = new QueryPlanner({ seed: 3, cascade: false });
    for (let i = 0; i < 60; i++) await planner.search(anyWord(), cues[i % cues.length]!, signal);
    const m = planner.means(alice, "or", true);
    expect(m.terms).toBeGreaterThan(0.6);
  });

  test("cascade: an empty result tries another shape in the same lookup, once", async () => {
    const planner = new QueryPlanner({ seed: 1, epsilon: 0 });
    const src = substring();
    let rescued = 0;
    for (let i = 0; i < 30; i++) {
      const r = await planner.search(src, cues[i % cues.length]!, signal);
      expect(r.shapes.length).toBeLessThanOrEqual(2);
      expect(r.calls).toBeLessThanOrEqual(3);
      if (r.shapes.length === 2 && r.items.length > 0) rescued++;
    }
    expect(rescued).toBeGreaterThan(0);
  });

  test("the cascade is learned: it stops where it never finds anything, and keeps going where it rescues", async () => {
    // OR search with nothing on the cue: an empty answer to the terms means every narrower shape is empty too.
    const planner = new QueryPlanner({ seed: 4 });
    const none = connector("none", () => false);
    const late = async (src: Source) => {
      let calls = 0;
      for (let i = 0; i < 40; i++) calls += (await planner.search(src, cues[i % cues.length]!, signal)).calls;
      return calls;
    };
    for (let i = 0; i < 3; i++) await late(none);
    expect(planner.cascadeMean(alice, "none", true)).toBeLessThan(0.05);
    // Mostly one call per lookup now; ε and the posterior's spread still re-try the cascade now and then.
    expect(await late(none)).toBeLessThan(40 * 1.25);
    // Where the cascade finds what the terms missed (substring search), it stays on.
    await late(substring());
    expect(planner.cascadeMean(alice, "substring", true)).toBeGreaterThan(0.5);
  });

  test("a cue with no entity uses terms, the only shape that applies", async () => {
    const planner = new QueryPlanner({ seed: 2 });
    const r = await planner.search(anyWord(), query("team lunch friday", []), signal);
    expect(r.shapes).toEqual(["terms"]);
    expect(r.items.map((i) => i.ref)).toContain("3");
  });

  test("state is per tenant and user: one user's learning never moves another's", async () => {
    const planner = new QueryPlanner({ seed: 5, cascade: false });
    for (let i = 0; i < 40; i++) await planner.search(substring(), cues[i % cues.length]!, signal);
    const bob = { tenantId: "t", userId: "bob" };
    const other = { tenantId: "t2", userId: "alice" };
    const prior = new QueryPlanner().means(alice, "substring", true);
    for (const s of [bob, other]) expect(planner.means(s, "substring", true)).toEqual(prior);
  });

  test("state is bounded: past maxStates the least recently used connector is dropped", async () => {
    const planner = new QueryPlanner({ maxStates: 3 });
    for (let u = 0; u < 10; u++) {
      await planner.search(anyWord(), query("lunch", [], { tenantId: "t", userId: `u${u}` }), signal);
    }
    expect(planner.size).toBe(3);
  });

  test("the operator words in a cue never reach the connector", async () => {
    const planner = new QueryPlanner({ seed: 9 });
    const src = anyWord();
    await planner.search(src, query("in:trash OR from:boss", ['"Jamie" OR x']), signal);
    for (const q of src.log) expect(q).not.toMatch(/["():]|\bOR\b/);
  });

  test("PlannedSource searches through the planner and reports a content-free outcome", async () => {
    const src = new PlannedSource(substring(), new QueryPlanner({ seed: 4 }));
    const items = await src.search(cues[0]!, signal);
    expect(src.id).toBe("substring");
    expect(src.last!.calls).toBeGreaterThan(0);
    expect(JSON.stringify(src.last)).not.toContain("jamie");
    if (items.length) expect(items[0]!.ref).toBe("1");
  });

  test("cueCoverage: share of cue words the best item contains, 0 when nothing came back", () => {
    const items = [{ id: "a", sourceId: "s", ref: "a", title: "Dinner", text: "with Jamie Fox" }];
    expect(cueCoverage({ text: "dinner jamie fox", entities: ["Jamie Fox"] }, items)).toBe(1);
    expect(cueCoverage({ text: "lunch jamie", entities: [] }, items)).toBe(0.5);
    expect(cueCoverage({ text: "dinner", entities: [] }, [])).toBe(0);
  });

  test("with a store, learning survives a restart, and bad stored rows are ignored", async () => {
    const rows = new Map<string, PlannerArm[]>();
    const store: PlannerStore = {
      loadArms: (sc, id) => rows.get(`${sc.tenantId}/${sc.userId}/${id}`) ?? [],
      saveArms: (sc, id, arms) => {
        const k = `${sc.tenantId}/${sc.userId}/${id}`;
        const kept = (rows.get(k) ?? []).filter((r) => !arms.some((a) => a.bucket === r.bucket && a.shape === r.shape));
        rows.set(k, [...kept, ...arms]);
      },
    };
    const first = new QueryPlanner({ seed: 3, cascade: false, store });
    for (let i = 0; i < 60; i++) await first.search(substring(), cues[i % cues.length]!, signal);
    const cascading = new QueryPlanner({ seed: 5, store });
    for (let i = 0; i < 10; i++)
      await cascading.search(
        connector("none", () => false),
        cues[0]!,
        signal,
      );
    const learned = first.means(alice, "substring", true);
    const restarted = new QueryPlanner({ seed: 4, store });
    expect(restarted.means(alice, "substring", true)).toEqual(learned);
    // The cascade's posterior persists with the arms.
    expect(cascading.cascadeMean(alice, "none", true)).toBeLessThan(0.5);
    expect(restarted.cascadeMean(alice, "none", true)).toBe(cascading.cascadeMean(alice, "none", true));
    // Nothing stored for another user; junk rows are skipped, not loaded.
    rows.set("t/bob/substring", [
      { bucket: 1, shape: "drop table", alpha: 9, beta: 1 },
      { bucket: 7, shape: "terms", alpha: 9, beta: 1 },
      { bucket: 1, shape: "terms", alpha: -1, beta: Number.NaN },
    ]);
    const prior = new QueryPlanner().means(alice, "substring", true);
    expect(restarted.means({ tenantId: "t", userId: "bob" }, "substring", true)).toEqual(prior);
  });

  test("the incumbent (terms) starts ahead, and is kept where it works", async () => {
    const prior = new QueryPlanner().means(alice, "or", true);
    expect(prior.terms).toBe(0.75);
    expect(prior["each-entity"]).toBe(0.7); // The runner-up prior (D38): below the incumbent, above the rest.
    const planner = new QueryPlanner({ seed: 6, cascade: false });
    let terms = 0;
    for (let i = 0; i < 60; i++) {
      const r = await planner.search(anyWord(), cues[i % cues.length]!, signal);
      if (i >= 30 && r.shapes[0] === "terms") terms++;
    }
    expect(terms).toBeGreaterThanOrEqual(15);
  });

  test("concurrent lookups for different users never touch each other's choices or learning", async () => {
    const planner = new QueryPlanner({ seed: 2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // A's connector answers nothing, after B's lookup has run: A's cascade happens after B changed its own choices.
    const slowEmpty: Source = { id: "x", kind: "t", description: "", search: async () => (await gate, []) };
    const aScope = { tenantId: "t", userId: "a" };
    const before = planner.means(aScope, "x", false);
    const a = planner.search(slowEmpty, query("lunch friday", [], aScope), signal);
    await planner.search(
      substring(),
      query("dinner jamie fox", ["Jamie Fox"], { tenantId: "t2", userId: "b" }),
      signal,
    );
    release();
    const r = await a;
    // A's cue has no entity: terms is the only shape that applies, so no cascade shape exists to try.
    expect(r.shapes).toEqual(["terms"]);
    const after = planner.means(aScope, "x", false);
    for (const s of ["entities", "each-entity", "entity+term", "phrase"] as const) expect(after[s]).toBe(before[s]);
  });

  test("a refused permit stops extra calls, and a shape that sent nothing is not credited", async () => {
    const planner = new QueryPlanner({ seed: 1, epsilon: 0 });
    const src = substring();
    // terms (the incumbent) finds nothing on a substring connector; the cascade's call needs a permit.
    const r = await planner.search(src, cues[0]!, signal, () => false);
    expect(r.calls).toBe(1);
    expect(src.log).toHaveLength(1);
    expect(r.shapes).toEqual(["terms"]);
  });

  test("a store that throws costs persistence, never the lookup", async () => {
    const broken: PlannerStore = {
      loadArms: () => {
        throw new Error("database is locked");
      },
      saveArms: () => {
        throw new Error("disk full");
      },
    };
    const planner = new QueryPlanner({ seed: 1, store: broken });
    const r = await planner.search(anyWord(), cues[0]!, signal);
    expect(r.items.length).toBeGreaterThan(0);
  });

  test("forget drops a user's state (one connector or all), and only theirs", async () => {
    const planner = new QueryPlanner({ seed: 3, cascade: false });
    const bob = { tenantId: "t", userId: "bob" };
    for (let i = 0; i < 30; i++) {
      await planner.search(substring(), cues[i % cues.length]!, signal);
      await planner.search(substring(), { ...cues[i % cues.length]!, scope: bob }, signal);
    }
    const prior = new QueryPlanner().means(alice, "substring", true);
    const bobs = planner.means(bob, "substring", true);
    planner.forget(alice, "other");
    expect(planner.means(alice, "substring", true)).not.toEqual(prior);
    planner.forget(alice);
    expect(planner.means(alice, "substring", true)).toEqual(prior);
    expect(planner.means(bob, "substring", true)).toEqual(bobs);
  });

  test("a lookup in flight when its user is forgotten learns nothing and writes nothing back", async () => {
    const rows: PlannerArm[] = [];
    const store: PlannerStore = { loadArms: () => [], saveArms: (_s, _id, arms) => void rows.push(...arms) };
    const planner = new QueryPlanner({ seed: 1, store });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The connector ignores the abort and answers anyway, after the user was forgotten.
    const late: Source = {
      id: "s",
      kind: "t",
      description: "",
      search: async () => (await gate, [DOCS[0]!].map((d) => ({ id: "s:1", sourceId: "s", ...d }))),
    };
    const pending = planner.search(late, cues[0]!, signal);
    planner.forget(alice);
    release();
    await pending;
    expect(rows).toEqual([]);
    const prior = new QueryPlanner().means(alice, "s", true);
    expect(planner.means(alice, "s", true)).toEqual(prior);
  });

  test("the cascade posterior is per user and forgotten with them; junk cascade rows load as the prior", async () => {
    const rows = new Map<string, PlannerArm[]>();
    const store: PlannerStore = {
      loadArms: (sc, id) => rows.get(`${sc.tenantId}/${sc.userId}/${id}`) ?? [],
      saveArms: () => {},
    };
    const planner = new QueryPlanner({ seed: 2, store });
    const none = connector("none", () => false);
    const bob = { tenantId: "t", userId: "bob" };
    const otherAlice = { tenantId: "t2", userId: "alice" };
    const prior = new QueryPlanner().cascadeMean(alice, "none", true);
    for (let i = 0; i < 20; i++) await planner.search(none, cues[i % cues.length]!, signal);
    expect(planner.cascadeMean(alice, "none", true)).toBeLessThan(prior);
    expect(planner.cascadeMean(bob, "none", true)).toBe(prior);
    expect(planner.cascadeMean(otherAlice, "none", true)).toBe(prior);
    planner.forget(alice);
    expect(planner.cascadeMean(alice, "none", true)).toBe(prior);
    // A user not seen yet, so the rows are read when their state is created.
    const carol = { tenantId: "t", userId: "carol" };
    rows.set("t/carol/none", [
      { bucket: 1, shape: "cascade", alpha: Infinity, beta: 1 },
      { bucket: 1, shape: "cascade", alpha: 1, beta: Number.NaN },
      { bucket: 3, shape: "cascade", alpha: 1, beta: 9 },
      { bucket: 1, shape: "terms", alpha: Infinity, beta: 1 },
    ]);
    expect(planner.cascadeMean(carol, "none", true)).toBe(prior);
    expect(planner.means(carol, "none", true).terms).toBe(new QueryPlanner().means(alice, "none", true).terms);
  });

  test("a cascade step aborted, forgotten or cut short by the permit teaches the cascade nothing", async () => {
    const rows: PlannerArm[] = [];
    const store: PlannerStore = { loadArms: () => [], saveArms: (_s, _id, arms) => void rows.push(...arms) };
    // The first call (terms) returns nothing, so the cascade runs; `during` happens on its first call.
    const second = (during: () => void): Source => {
      let n = 0;
      return { id: "s", kind: "t", description: "", search: async () => (++n === 2 && during(), []) };
    };
    const q = query("globex renewal sam ortiz", ["Globex", "Sam Ortiz"]);
    const run = async (during: (p: QueryPlanner, ac: AbortController) => void, seed = 1, permit?: () => boolean) => {
      rows.length = 0;
      const planner = new QueryPlanner({ seed, epsilon: 0, cascadeMin: 0, store });
      const ac = new AbortController();
      const r = await planner.search(
        second(() => during(planner, ac)),
        q,
        ac.signal,
        permit,
      );
      return { r, cascadeRows: rows.filter((x) => x.shape === "cascade") };
    };
    expect((await run(() => {})).cascadeRows.length).toBe(1);
    expect((await run((_p, ac) => ac.abort())).cascadeRows).toEqual([]);
    expect((await run((p) => p.forget(alice))).cascadeRows).toEqual([]);
    // Two entities: each-entity is two calls. With only the cascade's first call permitted, it is cut short.
    let cutShort = 0;
    for (let seed = 1; seed <= 30; seed++) {
      let permits = 0;
      const { r, cascadeRows } = await run(
        () => {},
        seed,
        () => ++permits === 1,
      );
      if (r.shapes[1] !== "each-entity") continue;
      cutShort++;
      expect(r.calls).toBe(2);
      expect(cascadeRows).toEqual([]);
      expect(rows.some((x) => x.shape === "each-entity")).toBe(false);
    }
    expect(cutShort).toBeGreaterThan(0);
  });

  test("no call is started that cannot answer before the caller's deadline; a cut step is not credited", async () => {
    // A slow substring connector: the cue's terms find nothing, so the cascade (one call per entity) would follow.
    const slow: Source = {
      id: "slow",
      kind: "t",
      description: "",
      search: async (q) => (
        await Bun.sleep(40),
        q.text === "Globex" ? [{ id: "slow:2", sourceId: "slow", ...DOCS[1]! }] : []
      ),
    };
    const rows: PlannerArm[] = [];
    const store: PlannerStore = { loadArms: () => [], saveArms: (_s, _id, arms) => void rows.push(...arms) };
    const q = query("globex renewal sam ortiz", ["Globex", "Sam Ortiz"]);
    // A 60 ms deadline: after a 40 ms call 20 ms are left, and a second call needs 80 (40 ms times the margin, 2).
    const tight = new QueryPlanner({ seed: 1, epsilon: 0, cascadeMin: 0, store });
    const r = await tight.search(slow, q, signal, undefined, undefined, performance.now() + 60);
    expect(r.calls).toBe(1);
    expect(rows.filter((x) => x.shape === "cascade")).toEqual([]);
    // The margin decides: with 110 ms, about 70 are left after the first call. Margin 1 needs 40, so it sends the
    // next call; the default (2) needs 80, so it does not.
    const loose = new QueryPlanner({ seed: 1, epsilon: 0, cascadeMin: 0, deadlineMargin: 1 });
    expect((await loose.search(slow, q, signal, undefined, undefined, performance.now() + 110)).calls).toBe(2);
    const strict = new QueryPlanner({ seed: 1, epsilon: 0, cascadeMin: 0 });
    expect((await strict.search(slow, q, signal, undefined, undefined, performance.now() + 110)).calls).toBe(1);
    // With time to spare, the cascade runs as before.
    const roomy = new QueryPlanner({ seed: 1, epsilon: 0, cascadeMin: 0 });
    expect(
      (await roomy.search(slow, q, signal, undefined, undefined, performance.now() + 5_000)).calls,
    ).toBeGreaterThan(1);
    // No deadline: no cut.
    expect(
      (await new QueryPlanner({ seed: 1, epsilon: 0, cascadeMin: 0 }).search(slow, q, signal)).calls,
    ).toBeGreaterThan(1);
  });

  test("the deadline check also expects the connector's recent latency, not only this lookup's calls", async () => {
    const quick: Source = {
      id: "quick",
      kind: "t",
      description: "",
      search: async () => (await Bun.sleep(5), []),
    };
    // The connector's recent calls took 400 ms at the 0.9 quantile; this lookup's first call took 5 ms.
    const via: PlanCalls = {
      cached: () => undefined,
      call: (q, s) => quick.search(q, s),
      expectMs: (_q, quantile) => (quantile === 0.9 ? 400 : 0),
    };
    const q = query("globex renewal sam ortiz", ["Globex", "Sam Ortiz"]);
    const planner = new QueryPlanner({ seed: 1, epsilon: 0, cascadeMin: 0 });
    // 200 ms left: the history says a call needs 800 (400 times the margin), so the cascade is not sent.
    expect((await planner.search(quick, q, signal, undefined, via, performance.now() + 200)).calls).toBe(1);
    // With the history off (quantile 0), the lookup's own 5 ms call is the estimate, and the cascade runs.
    const own = new QueryPlanner({ seed: 1, epsilon: 0, cascadeMin: 0, latencyQuantile: 0 });
    expect((await own.search(quick, q, signal, undefined, via, performance.now() + 200)).calls).toBeGreaterThan(1);
  });

  test("a shape cut short by the deadline partway keeps its items but is not credited", async () => {
    const slow: Source = {
      id: "slow",
      kind: "t",
      description: "",
      search: async (q) => (
        await Bun.sleep(40),
        q.text === "Globex" ? [{ id: "slow:2", sourceId: "slow", ...DOCS[1]! }] : []
      ),
    };
    const rows: PlannerArm[] = [];
    const store: PlannerStore = { loadArms: () => [], saveArms: (_s, _id, arms) => void rows.push(...arms) };
    // One call per entity leads: "Globex" is sent, then "Sam Ortiz" would not answer before the deadline.
    const planner = new QueryPlanner({
      seed: 1,
      epsilon: 0,
      store,
      incumbent: { shape: "each-entity", mean: 0.99, strength: 100 },
    });
    const q = query("globex renewal sam ortiz", ["Globex", "Sam Ortiz"]);
    const r = await planner.search(slow, q, signal, undefined, undefined, performance.now() + 60);
    expect(r.shapes).toEqual(["each-entity"]);
    expect(r.calls).toBe(1);
    expect(r.items.map((i) => i.id)).toEqual(["slow:2"]);
    expect(rows).toEqual([]);
    // PlannedSource passes its lookup's deadline through.
    const p = new PlannedSource(
      slow,
      new QueryPlanner({ seed: 1, epsilon: 0, cascadeMin: 0 }),
      undefined,
      undefined,
      performance.now() + 60,
    );
    await p.search(q, signal);
    expect(p.last!.calls).toBe(1);
  });

  test("a lookup aborted mid-flight (session ended) learns nothing", async () => {
    const rows: PlannerArm[] = [];
    const store: PlannerStore = { loadArms: () => [], saveArms: (_s, _id, arms) => void rows.push(...arms) };
    const planner = new QueryPlanner({ seed: 1, store });
    const ac = new AbortController();
    const late: Source = { id: "s", kind: "t", description: "", search: async () => (ac.abort(), []) };
    await planner.search(late, cues[0]!, ac.signal);
    expect(rows).toEqual([]);
  });
});

describe("QueryPlanner cascade order (D38)", () => {
  test("on a fresh connector the incumbent goes first, and the cascade falls back to one call per entity", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = await new QueryPlanner({ seed, epsilon: 0, cascadeMin: 0 }).search(substring(), cues[0]!, signal);
      expect(r.shapes).toEqual(["terms", "each-entity"]);
      expect(r.items.length).toBeGreaterThan(0);
    }
  });

  test("the runner-up prior applies only below an incumbent", async () => {
    const none = new QueryPlanner({ incumbent: { shape: "terms", mean: 0.75, strength: 0 } });
    expect(none.means(alice, "or", true)["each-entity"]).toBe(0.5);
    const low = new QueryPlanner({ incumbent: { shape: "terms", mean: 0.6, strength: 8 } });
    expect(low.means(alice, "or", true)["each-entity"]).toBe(0.5);
    expect(new QueryPlanner().means(alice, "or", true)["each-entity"]).toBe(0.7);
  });

  test("without the runner-up prior or the greedy step, the first cascade is a draw among the rest", async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const planner = new QueryPlanner({ seed, epsilon: 0, cascadeMin: 0, cascadeGreedy: false });
      const r = await planner.search(substring(), cues[0]!, signal);
      seen.add(r.shapes[1]!);
    }
    expect(seen.size).toBeGreaterThan(1);
    const flat = new QueryPlanner({
      seed: 1,
      epsilon: 0,
      cascadeMin: 0,
      runnerUp: { shape: "each-entity", mean: 0.7, strength: 0 },
    });
    expect((await flat.search(substring(), cues[0]!, signal)).shapes[1]).toBe("entities"); // The first on a tie.
  });

  test("the cascade follows evidence: a shape that found things comes before the runner-up", async () => {
    // Train "entities" (all entities as one query) to succeed. A margin of 1 keeps the incumbent first, so the
    // cascade's choice between "entities" and the runner-up is what is tested, on every seed.
    for (let seed = 1; seed <= 20; seed++) {
      const planner = new QueryPlanner({ seed, epsilon: 0, cascadeMin: 0, margin: 1 });
      type Inner = { state: (s: unknown, id: string) => { bandits: { update(a: number, r: number): void }[] } };
      const bucket = (planner as unknown as Inner).state(alice, "or");
      for (let i = 0; i < 20; i++) bucket.bandits[1]!.update(1, 1); // SHAPES[1] is "entities".
      const empty = { ...anyWord(), search: async () => [] as ContextItem[] };
      const r = await planner.search(empty, cues[0]!, signal);
      expect(r.shapes).toEqual(["terms", "entities"]);
    }
  });
});
