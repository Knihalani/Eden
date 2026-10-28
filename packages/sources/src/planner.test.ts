import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { cueCoverage, PlannedSource, QueryPlanner } from "./planner";
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
    expect(m.terms).toBeLessThan(0.4); // Tried a few times, all empty; then rarely tried again.
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
    for (const s of [bob, other]) {
      for (const v of Object.values(planner.means(s, "substring", true))) expect(v).toBe(0.5);
    }
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
});
