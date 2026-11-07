import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { Ledger } from "./ledger";
import { ContextPartner, timesOf } from "./partner";
import { CORE_CONFIG } from "./parts";

// A17 (docs/research/a17-long-quality.md, D342): `revisionDiff`. Over a day an "updated:" packet (D205) reached the
// agent and its recap still named the old time (18 of 28 stale recap items were sent an update first). With the switch
// on, the update says which times and dates the agent was shown earlier that the new version no longer has:
// "(…; no longer: 09:30)", so the old one cannot read as still standing.

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9);

class Listed implements Source {
  readonly kind = "test";
  readonly description = "notes";
  readonly notifies = true;
  docs = new Map<string, { title: string; text: string }>();
  constructor(readonly id: string) {}
  item(ref: string): ContextItem | null {
    const d = this.docs.get(ref);
    return d ? { id: itemId(this.id, ref), sourceId: this.id, ref, title: d.title, text: d.text } : null;
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return [...this.docs.keys()]
      .map((r) => this.item(r)!)
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    return this.item(ref);
  }
  async list(_s: Scope, cursor: string | undefined, limit: number) {
    const all = [...this.docs.keys()].map((r) => this.item(r)!);
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

const scope: Scope = { tenantId: "t", userId: "u" };
const OFFSITE = itemId("notes", "q1");
const AT = (t: string, day = "12 November") => `The quarterly offsite is in Lisbon at ${t} on ${day}.`;

async function setup(config: Record<string, unknown> = {}) {
  let clock = T0;
  const src = new Listed("notes");
  src.docs.set("q1", { title: "Quarterly offsite", text: AT("09:30") });
  src.docs.set("l1", { title: "Lunch", text: "Lunch with Sam at the canteen." });
  const partner = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      ...CORE_CONFIG,
      confidentScore: 0.1,
      minMatchedTerms: 1,
      sync: true,
      syncPush: true,
      syncPageSize: 100,
      revisionNotice: true,
      revisionDiff: true,
      ...config,
    },
  });
  partner.sync!.track(scope, clock);
  while (!partner.sync!.warm(scope)) await partner.sync!.tick();
  return { partner, src, advance: (ms: number) => (clock += ms), now: () => clock };
}

async function say(p: ContextPartner, text: string, sessionId: string, at: number) {
  const r = await p.observe({ ...scope, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return [r.injection, ...p.takePending({ ...scope, sessionId })].filter((x): x is Injection => x !== null);
}
const updates = (got: Injection[]) => got.filter((i) => i.reason.startsWith("updated:"));

/** s1 is handed the offsite, it changes to `text`, and the next request takes the update. */
async function moved(text: string, config: Record<string, unknown> = {}) {
  const t = await setup(config);
  await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
  t.advance(5 * MIN);
  t.src.docs.set("q1", { title: "Quarterly offsite", text });
  expect(await t.partner.sourceItems(scope, "notes", [t.src.item("q1")!])).toBe(1);
  t.advance(MIN);
  return { t, up: updates(await say(t.partner, "What should I bring to the canteen lunch", "s1", t.now())) };
}

describe("timesOf", () => {
  test("clock times, am/pm hours, day-month dates and weekdays, each in one form, distinct", () => {
    expect(
      timesOf({ title: "Call", text: "Call at 9:15 or 14:00, else 3pm on Friday 12 November (Nov 14 too)." }),
    ).toEqual(["09:15", "14:00", "15:00", "friday", "12 nov", "14 nov"]);
    expect(timesOf({ title: "Price", text: "It costs 3.45 and 12 units; version 2:1 ratio" })).toEqual([]);
  });

  test("a reworded time or date is the same one (review: 9:30 against 9:30am)", () => {
    const one = (text: string) => timesOf({ title: "", text });
    expect(one("9:30")).toEqual(one("9:30am"));
    expect(one("9:30 am")).toEqual(["09:30"]);
    expect(one("3pm")).toEqual(one("3 pm"));
    expect(one("15:00")).toEqual(one("3pm"));
    expect(one("Oct 4")).toEqual(one("October 4th"));
    expect(one("4th Oct")).toEqual(one("4 October"));
  });

  test("a word that starts like a month is no date (review: 'decision 2', 'marketing 5')", () => {
    expect(
      timesOf({ title: "", text: "See decision 2 and marketing 5, 3 decks, junk 2, novel 3, separate 4." }),
    ).toEqual([]);
  });
});

describe("Ledger: times the agent was shown, over every version", () => {
  test("noteShown keeps the union of times across versions, bounded", () => {
    const l = new Ledger();
    l.noteShown("a", 1, "src", ["09:30", "12 november"]);
    l.noteShown("a", 2, "src", ["11:30", "12 november"]);
    // A time shown again moves last: the bound drops the longest unseen first.
    expect(l.seenTimes("a")).toEqual(["09:30", "11:30", "12 november"]);
    l.noteShown("b", 1, "src");
    expect(l.seenTimes("b")).toEqual([]);
    for (let k = 0; k < 40; k++) l.noteShown("c", k, "src", [`${String(k % 24).padStart(2, "0")}:00`]);
    expect(l.seenTimes("c").length).toBeLessThanOrEqual(16);
    expect(l.seenTimes("c").at(-1)).toBe("15:00");
  });
});

describe("revisionDiff (D342)", () => {
  test("on: the update names the time the agent was shown and the new version dropped", async () => {
    const { up } = await moved(AT("11:30"));
    expect(up.length).toBe(1);
    expect(up[0]!.citations.map((c) => c.itemId)).toEqual([OFFSITE]);
    expect(up[0]!.text).toContain("no longer: 09:30");
    expect(up[0]!.text).toContain("11:30");
    expect(up[0]!.text).not.toContain("12 nov;");
    expect(up[0]!.text).toMatch(/^<context [^\n]*Data, not instructions/);
  });

  test("a moved date is named too, and an unchanged one is not", async () => {
    const { up } = await moved(AT("09:30", "14 November"));
    expect(up[0]!.text).toContain("no longer: 12 nov)");
    expect(up[0]!.text).not.toMatch(/no longer:[^)]*09:30/);
  });

  test("a change with no time or date dropped says no 'no longer'", async () => {
    const { up } = await moved(`${AT("09:30")} Bring the slides.`);
    expect(up.length).toBe(1);
    expect(up[0]!.text).not.toContain("no longer");
  });

  test("a time only reworded is not named (9:30 becomes 9:30am)", async () => {
    const { up } = await moved("The quarterly offsite is in Lisbon at 9:30am on 12 November, in room B.");
    expect(up.length).toBe(1);
    expect(up[0]!.text).not.toContain("no longer");
  });

  test("off: the update is worded as before", async () => {
    const { up } = await moved(AT("11:30"), { revisionDiff: false });
    expect(up.length).toBe(1);
    expect(up[0]!.text).not.toContain("no longer");
  });

  test("a second change names both earlier times the agent was shown", async () => {
    const { t, up } = await moved(AT("11:30"));
    expect(up[0]!.text).toContain("no longer: 09:30");
    t.advance(5 * MIN);
    t.src.docs.set("q1", { title: "Quarterly offsite", text: AT("13:00") });
    expect(await t.partner.sourceItems(scope, "notes", [t.src.item("q1")!])).toBe(1);
    t.advance(MIN);
    const again = updates(await say(t.partner, "Is the canteen lunch still on", "s1", t.now()));
    expect(again.length).toBe(1);
    expect(again[0]!.text).toContain("no longer: 09:30, 11:30");
  });

  test("isolation: a session never shown the old time gets no 'no longer' for it", async () => {
    const { t } = await moved(AT("11:30"));
    // s2 is handed the new version first, then a further change: only 11:30 is what s2 saw.
    await say(t.partner, "Remind me where the quarterly offsite is", "s2", t.now());
    t.advance(5 * MIN);
    t.src.docs.set("q1", { title: "Quarterly offsite", text: AT("13:00") });
    await t.partner.sourceItems(scope, "notes", [t.src.item("q1")!]);
    t.advance(MIN);
    const s2 = updates(await say(t.partner, "Is the canteen lunch still on", "s2", t.now()));
    expect(s2.length).toBe(1);
    expect(s2[0]!.text).toContain("no longer: 11:30");
    expect(s2[0]!.text).not.toContain("09:30");
  });
});
