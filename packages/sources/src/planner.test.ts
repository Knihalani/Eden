import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { cueCoverage, PlannedSource, QueryPlanner, type PlannerArm, type PlannerStore } from "./planner";
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
    const learned = first.means(alice, "substring", true);
    const restarted = new QueryPlanner({ seed: 4, store });
    expect(restarted.means(alice, "substring", true)).toEqual(learned);
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
    expect(prior["each-entity"]).toBe(0.5);
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
});
