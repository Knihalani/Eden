import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { Ledger } from "./ledger";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// `revisionNotice` (D205, on in the default): an item a session was handed that changes at its source is sent
// again, once per revision, as an "updated:" packet before the agent's next model call.

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9);

/** A connector that lists and notifies; its items can change between calls. */
class Listed implements Source {
  readonly kind = "test";
  readonly description = "notes";
  readonly notifies = true;
  searches = 0;
  lists = 0;
  fetches = 0;
  /** Listing answers with nothing (an index that has not caught up): no failure, no breaker. */
  blind = false;
  /** When set, a listing waits for it (a call still on the wire). */
  gate: Promise<void> | null = null;
  docs = new Map<string, { title: string; text: string; meta?: Record<string, string> }>();
  constructor(readonly id: string) {}
  item(ref: string): ContextItem | null {
    const d = this.docs.get(ref);
    if (!d) return null;
    return {
      id: itemId(this.id, ref),
      sourceId: this.id,
      ref,
      title: d.title,
      text: d.text,
      ...(d.meta ? { meta: d.meta } : {}),
    };
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.searches++;
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return [...this.docs.keys()]
      .map((r) => this.item(r)!)
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    return this.item(ref);
  }
  async list(_s: Scope, cursor: string | undefined, limit: number) {
    this.lists++;
    if (this.gate) await this.gate;
    if (this.blind) return { items: [], next: null };
    const all = [...this.docs.keys()].map((r) => this.item(r)!);
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

const scope: Scope = { tenantId: "t", userId: "u" };
const other: Scope = { tenantId: "t", userId: "u2" };
const OFFSITE = itemId("notes", "q1");

const seed = (src: Listed) => {
  src.docs.set("q1", {
    title: "Quarterly offsite",
    text: "The quarterly offsite is in Lisbon at 09:30 on 12 November.",
  });
  src.docs.set("l1", { title: "Lunch", text: "Lunch with Sam at the canteen." });
  src.docs.set("r1", { title: "Budget review", text: "The budget review with finance is at 14:00 on Friday." });
};
const REVIEW = itemId("notes", "r1");
const moveText = (at: string) => `The quarterly offsite is in Lisbon at ${at} on 12 November.`;
const move = (src: Listed, text = "The quarterly offsite is in Lisbon at 11:30 on 12 November.") =>
  src.docs.set("q1", { title: "Quarterly offsite", text });

/** A partner whose sync has read every item of each scope's source once. */
async function setup(config: Record<string, unknown> = {}, scopes: Scope[] = [scope]) {
  let clock = T0;
  const srcs = new Map<string, Listed>();
  for (const sc of scopes) {
    const src = new Listed("notes");
    seed(src);
    srcs.set(sc.userId, src);
  }
  const partner = new ContextPartner({
    sources: async (sc) => [srcs.get(sc.userId)!],
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
      ...config,
    },
  });
  for (const sc of scopes) {
    partner.sync!.track(sc, clock);
    while (!partner.sync!.warm(sc)) await partner.sync!.tick();
  }
  return {
    partner,
    src: (sc: Scope = scope) => srcs.get(sc.userId)!,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

async function say(p: ContextPartner, text: string, sessionId: string, at: number, sc: Scope = scope) {
  const r = await p.observe({ ...sc, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return [r.injection, ...p.takePending({ ...sc, sessionId })].filter((x): x is Injection => x !== null);
}
const updates = (got: Injection[]) => got.filter((i) => i.reason.startsWith("updated:"));
const cites = (got: Injection[], id: string) => got.some((i) => i.citations.some((c) => c.itemId === id));

describe("revisionNotice: a changed item the session was handed is sent again before the next model call", () => {
  test("a change notice, then an unrelated request: one updated packet with the new version, inside the envelope", async () => {
    const t = await setup();
    const first = await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    expect(cites(first, OFFSITE)).toBe(true);
    t.advance(5 * MIN);
    move(t.src());
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    t.advance(1 * MIN);
    const got = await say(t.partner, "What should I bring to the canteen lunch", "s1", t.now());
    const up = updates(got);
    expect(up.length).toBe(1);
    expect(up[0]!.citations.map((c) => c.itemId)).toEqual([OFFSITE]);
    expect(up[0]!.text).toContain("11:30");
    expect(up[0]!.text).not.toContain("09:30");
    expect(up[0]!.text).toMatch(/^<context [^\n]*Data, not instructions/);
    expect(up[0]!.text).toContain("updated:");
    expect(up[0]!.text.trimEnd().endsWith("</context>")).toBe(true);
  });

  test("once per revision: no second packet for the same version, a new one for a second change", async () => {
    const t = await setup();
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    t.advance(5 * MIN);
    move(t.src());
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    expect(updates(await say(t.partner, "What should I bring to the canteen lunch", "s1", t.now())).length).toBe(1);
    t.advance(5 * MIN);
    t.partner.sourceChanged(scope, "notes"); // A signal with nothing changed at the source.
    await t.partner.revisionsSettled(scope);
    expect(updates(await say(t.partner, "Anything about the canteen lunch", "s1", t.now())).length).toBe(0);
    t.advance(5 * MIN);
    move(t.src(), "The quarterly offsite is in Porto at 11:30 on 12 November.");
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    const again = updates(await say(t.partner, "Is the canteen lunch still on", "s1", t.now()));
    expect(again.length).toBe(1);
    expect(again[0]!.text).toContain("Porto");
  });

  test("off (the minus-freshness arm): no updated packet", async () => {
    const t = await setup({ revisionNotice: false });
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    t.advance(5 * MIN);
    move(t.src());
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    expect(updates(await say(t.partner, "What should I bring to the canteen lunch", "s1", t.now())).length).toBe(0);
  });

  test("only real content changes: a metadata-only change sends nothing", async () => {
    const t = await setup();
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    t.advance(5 * MIN);
    const d = t.src().docs.get("q1")!;
    t.src().docs.set("q1", { ...d, meta: { labels: "starred" } });
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    expect(updates(await say(t.partner, "What should I bring to the canteen lunch", "s1", t.now())).length).toBe(0);
  });

  test("a notice that carries the item (sourceItems) queues the update for the next take", async () => {
    const t = await setup();
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    t.advance(5 * MIN);
    move(t.src());
    t.partner.sourceChanged(scope, "notes");
    expect(await t.partner.sourceItems(scope, "notes", [t.src().item("q1")!])).toBe(1);
    const up = updates(t.partner.takePending({ ...scope, sessionId: "s1" }));
    expect(up.length).toBe(1);
    expect(up[0]!.text).toContain("11:30");
  });

  test("isolation: a session or user never shown the item gets nothing; each shown session gets its own", async () => {
    const t = await setup({}, [scope, other]);
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    await say(t.partner, "Remind me where the quarterly offsite is", "s3", t.now());
    // Same user, a session that was never shown the offsite.
    await say(t.partner, "What should I bring to the canteen lunch", "s2", t.now());
    // Another user with the same item id, shown it.
    await say(t.partner, "Remind me where the quarterly offsite is", "o1", t.now(), other);
    t.advance(5 * MIN);
    move(t.src());
    t.partner.sourceChanged(scope, "notes");
    expect(await t.partner.sourceItems(scope, "notes", [t.src().item("q1")!])).toBe(1);
    expect(updates(t.partner.takePending({ ...scope, sessionId: "s2" })).length).toBe(0);
    expect(updates(t.partner.takePending({ ...other, sessionId: "o1" })).length).toBe(0);
    expect(updates(t.partner.takePending({ ...scope, sessionId: "s1" })).length).toBe(1);
    expect(updates(t.partner.takePending({ ...scope, sessionId: "s3" })).length).toBe(1);
  });

  test("an update still queued is replaced by a newer revision, not joined", async () => {
    const t = await setup();
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    t.advance(5 * MIN);
    move(t.src());
    t.partner.sourceChanged(scope, "notes");
    await t.partner.sourceItems(scope, "notes", [t.src().item("q1")!]);
    t.advance(1 * MIN);
    move(t.src(), "The quarterly offsite is in Porto at 11:30 on 12 November.");
    t.partner.sourceChanged(scope, "notes");
    await t.partner.sourceItems(scope, "notes", [t.src().item("q1")!]);
    const up = updates(t.partner.takePending({ ...scope, sessionId: "s1" }));
    expect(up.length).toBe(1);
    expect(up[0]!.text).toContain("Porto");
  });

  test("a notice polls at once only when a live session was handed a copy from that source", async () => {
    const t = await setup();
    await say(t.partner, "What should I bring to the canteen lunch", "s1", t.now());
    const before = t.src().lists;
    t.partner.sourceChanged(scope, "other-source");
    await t.partner.revisionsSettled(scope);
    expect(t.src().lists).toBe(before);
    const u = await setup();
    const quiet = u.src().lists;
    u.partner.sourceChanged(scope, "notes"); // No session at all.
    await u.partner.revisionsSettled(scope);
    expect(u.src().lists).toBe(quiet);
    await say(u.partner, "Remind me where the quarterly offsite is", "s1", u.now());
    const shown = u.src().lists;
    u.partner.sourceChanged(scope, "notes");
    await u.partner.revisionsSettled(scope);
    expect(u.src().lists).toBe(shown + 1);
  });

  test("a closed session queues nothing", async () => {
    const t = await setup();
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    await t.partner.observe({ ...scope, sessionId: "s1", at: t.now(), kind: "session_end" } as AgentEvent);
    t.advance(5 * MIN);
    move(t.src());
    t.partner.sourceChanged(scope, "notes");
    await t.partner.sourceItems(scope, "notes", [t.src().item("q1")!]);
    expect(t.partner.takePending({ ...scope, sessionId: "s1" }).length).toBe(0);
  });
});

describe("revisionNotice: review regressions", () => {
  test("a second notice while the notice poll is on the wire does not lose the update (reviewer finding 1)", async () => {
    const t = await setup();
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    t.advance(5 * MIN);
    move(t.src());
    let open!: () => void;
    t.src().gate = new Promise<void>((r) => (open = r));
    t.partner.sourceChanged(scope, "notes");
    await Bun.sleep(5);
    t.partner.sourceChanged(scope, "notes"); // Lands while the listing is held: the copy it brings is doubted.
    open();
    t.src().gate = null;
    await t.partner.revisionsSettled(scope);
    const got = updates(await say(t.partner, "What should I bring to the canteen lunch", "s1", t.now()));
    expect(got.length).toBe(1);
    expect(got[0]!.text).toContain("11:30");
  });

  test("a burst of notices polls at most once at a time and 30 s apart (reviewer finding 3)", async () => {
    const t = await setup();
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    t.advance(5 * MIN);
    const before = t.src().lists;
    for (let i = 0; i < 20; i++) {
      t.partner.sourceChanged(scope, "notes");
      await Bun.sleep(1);
    }
    await t.partner.revisionsSettled(scope);
    expect(t.src().lists - before).toBe(1);
    t.advance(31_000);
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    expect(t.src().lists - before).toBe(2);
  });

  test("a re-read before an answer: no update for the answering session, one for another (reviewer finding 2)", async () => {
    const t = await setup({ verifyDelivery: true });
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    await say(t.partner, "Remind me where the quarterly offsite is", "s2", t.now());
    t.advance(5 * MIN);
    move(t.src());
    t.src().blind = true; // The notice's poll brings nothing: only the answer's re-read finds the change.
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    t.advance(5 * MIN);
    const answer = await t.partner.ask({ ...scope, sessionId: "s1", question: "Where is the quarterly offsite" });
    expect(t.src().fetches).toBeGreaterThanOrEqual(1);
    expect(answer.citations.map((c) => c.itemId)).toContain(OFFSITE);
    expect(answer.answer).toContain("11:30");
    expect(updates(t.partner.takePending({ ...scope, sessionId: "s1" })).length).toBe(0);
    const other = updates(t.partner.takePending({ ...scope, sessionId: "s2" }));
    expect(other.length).toBe(1);
    expect(other[0]!.text).toContain("11:30");
  });

  test("an item the size cut left out of a packet was not shown: no update for it (reviewer finding 4)", async () => {
    const t = await setup({ maxInjectionBytes: 165 });
    const first = await say(t.partner, "When are the quarterly offsite and the budget review", "s1", t.now());
    const text = first.map((i) => i.text).join("\n");
    const cited = first.flatMap((i) => i.citations.map((c) => c.itemId));
    expect(cited).toContain(OFFSITE);
    expect(cited).toContain(REVIEW);
    const offsiteShown = text.includes("Quarterly offsite");
    expect(offsiteShown).not.toBe(text.includes("Budget review")); // One line fits, the other is cut.
    t.advance(5 * MIN);
    move(t.src());
    t.src().docs.set("r1", { title: "Budget review", text: "The budget review with finance is at 16:00 on Friday." });
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    const up = updates(t.partner.takePending({ ...scope, sessionId: "s1" }));
    expect(up.flatMap((i) => i.citations.map((c) => c.itemId))).toEqual([offsiteShown ? OFFSITE : REVIEW]);
  });

  test("changes too big for one update packet are split, every item said (reviewer finding 4)", async () => {
    const t = await setup({ maxInjectionBytes: 200 });
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    await say(t.partner, "When is the budget review with finance", "s1", t.now());
    t.advance(5 * MIN);
    move(t.src());
    t.src().docs.set("r1", { title: "Budget review", text: "The budget review with finance is at 16:00 on Friday." });
    t.partner.sourceChanged(scope, "notes");
    await t.partner.sourceItems(scope, "notes", [t.src().item("q1")!, t.src().item("r1")!]);
    const up = updates(t.partner.takePending({ ...scope, sessionId: "s1" }));
    expect(up.length).toBe(2);
    for (const i of up) {
      expect(i.citations.length).toBe(1);
      expect(i.text).toContain("updated:");
    }
    expect(up.flatMap((i) => i.citations.map((c) => c.itemId)).sort()).toEqual([OFFSITE, REVIEW].sort());
  });

  test("an ask's answer counts as handed: its items get updates", async () => {
    const t = await setup();
    const answer = await t.partner.ask({ ...scope, sessionId: "s1", question: "Where is the quarterly offsite" });
    expect(answer.citations.map((c) => c.itemId)).toContain(OFFSITE);
    t.advance(5 * MIN);
    move(t.src());
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    const up = updates(t.partner.takePending({ ...scope, sessionId: "s1" }));
    expect(up.length).toBe(1);
    expect(up[0]!.text).toContain("11:30");
  });
});

describe("revisionNotice: second review regressions", () => {
  test("a re-read for an answer that cuts the item's line still leaves the update queued (second review 1, 2)", async () => {
    const t = await setup({ verifyDelivery: true });
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    // A long review item answers first and fills the answer: the offsite's line is cut, though it is cited.
    t.src().docs.set("r1", {
      title: "Budget review",
      text: `The budget review with finance is on Friday. ${"Agenda line. ".repeat(400)}`,
    });
    t.advance(5 * MIN);
    move(t.src());
    t.src().blind = true;
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    t.advance(5 * MIN);
    const answer = await t.partner.ask({
      ...scope,
      sessionId: "s1",
      question: "When are the budget review with finance and the quarterly offsite",
    });
    const said = answer.answer.includes("11:30");
    const up = updates(t.partner.takePending({ ...scope, sessionId: "s1" }));
    expect(answer.citations.map((c) => c.itemId)).toContain(OFFSITE);
    expect(said).toBe(false); // Cited, but its line was cut.
    expect(t.src().fetches).toBeGreaterThanOrEqual(1);
    expect(up.length).toBe(1);
    expect(up[0]!.text).toContain("11:30");
  });

  test("an update queued beside a packet that renders the same version is dropped from the batch", async () => {
    const t = await setup({ verifyDelivery: true });
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    t.advance(5 * MIN);
    move(t.src());
    t.src().blind = true;
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    t.advance(5 * MIN);
    // The ledger holds the offsite as delivered: only its re-read and update can carry the new time.
    const got = await say(t.partner, "Is the quarterly offsite in Lisbon at 11:30", "s1", t.now());
    const carrying = got.filter((i) => cites([i], OFFSITE));
    expect(carrying.length).toBeLessThanOrEqual(1);
    if (carrying.length === 1) expect(carrying[0]!.text).toContain("11:30");
  });

  test("an engine clock that steps back does not hold notice polls back an hour", async () => {
    const t = await setup();
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    // Counted at the sync: whether its listing then runs under a clock gone back is the sync's own business.
    const sync = t.partner.sync!;
    const freshen = sync.freshen.bind(sync);
    let polls = 0;
    sync.freshen = (...a: Parameters<typeof freshen>) => (polls++, freshen(...a));
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    expect(polls).toBe(1);
    t.advance(-60 * MIN);
    t.partner.sourceChanged(scope, "notes");
    await t.partner.revisionsSettled(scope);
    expect(polls).toBe(2);
  });

  test("a maxInjectionBytes too small for one line still says the update", async () => {
    const t = await setup();
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    (t.partner.config as { maxInjectionBytes: number }).maxInjectionBytes = 90;
    t.advance(5 * MIN);
    move(t.src());
    t.partner.sourceChanged(scope, "notes");
    await t.partner.sourceItems(scope, "notes", [t.src().item("q1")!]);
    const up = updates(t.partner.takePending({ ...scope, sessionId: "s1" }));
    expect(up.length).toBe(1);
    expect(up[0]!.text).toContain("11:30");
  });
});

describe("Ledger: shown copies", () => {
  test("superseded only for a shown item whose version differs; bounded, oldest dropped first", () => {
    const l = new Ledger(40);
    l.noteShown("a", 1, "src");
    expect(l.superseded("a", 1)).toBe(false);
    expect(l.superseded("a", 2)).toBe(true);
    expect(l.superseded("b", 2)).toBe(false);
    for (let i = 0; i < 300; i++) l.noteShown(`x${i}`, i, "src");
    expect(l.superseded("a", 2)).toBe(false);
    expect(l.shownCount).toBeLessThanOrEqual(256);
  });
});

describe("a revision stored while a packet with the old copy waits in the queue (wave-1 review)", () => {
  test("the agent takes the old copy, then is told of the new one", async () => {
    const t = await setup();
    // White-box: a session, then a packet built the way the slow path or the reader push builds one, queued untaken.
    const P = t.partner as any;
    await say(t.partner, "What should I bring to the canteen lunch", "s1", t.now());
    const s = P.sessions.get("t/u#s1");
    const v1 = P.deps.cache.get(scope, OFFSITE, t.now());
    expect(v1.text).toContain("09:30");
    const cue = { raw: "offsite", terms: new Uint32Array(0), entities: [], span: 0 };
    s.pending.push(P.build(s, [{ item: v1, score: 1 }], "proactive", "probe", cue, 0));
    t.advance(MIN);
    const moved = "The quarterly offsite is in Lisbon at 11:30 on 12 November.";
    const stored = await t.partner.sourceItems(scope, "notes", [
      { id: OFFSITE, sourceId: "notes", ref: "q1", title: "Quarterly offsite", text: moved },
    ]);
    expect(stored).toBe(1);
    const taken = t.partner.takePending({ ...scope, sessionId: "s1" });
    t.advance(5 * MIN);
    const next = await say(t.partner, "Anything for the budget review with finance", "s1", t.now());
    const all = [...taken, ...next];
    expect(all.some((i) => i.text.includes("09:30"))).toBe(true);
    expect(updates(all).some((i) => i.text.includes("11:30"))).toBe(true);
  });
});

test("stopSync clears a revision poll held back by its gap (wave-1 review)", async () => {
  const t = await setup();
  const P = t.partner as any;
  let fired = false;
  const st = { running: false, again: false, at: t.now(), timer: setTimeout(() => (fired = true), 5) };
  P.revisionSources.set("t/u\u0000notes", st);
  t.partner.stopSync();
  expect(st.timer).toBeNull();
  await new Promise((r) => setTimeout(r, 20));
  expect(fired).toBe(false);
});

test("a session's first packet, queued untaken when its item is revised: the update follows it (wave-1 review)", async () => {
  const t = await setup();
  const P = t.partner as any;
  // Nothing handed yet: the session is not watching.
  await t.partner.observe(
    { ...scope, sessionId: "s1", at: t.now(), kind: "user_message", text: "ok thanks" } as AgentEvent,
    { waitMs: 2_000 },
  );
  t.partner.takePending({ ...scope, sessionId: "s1" });
  const s = P.sessions.get("t/u#s1");
  const v1 = P.deps.cache.get(scope, OFFSITE, t.now());
  const cue = { raw: "offsite", terms: new Uint32Array(0), entities: [], span: 0 };
  s.pending.push(P.build(s, [{ item: v1, score: 1 }], "proactive", "probe", cue, 0));
  t.advance(MIN);
  const moved = "The quarterly offsite is in Lisbon at 11:30 on 12 November.";
  await t.partner.sourceItems(scope, "notes", [
    { id: OFFSITE, sourceId: "notes", ref: "q1", title: "Quarterly offsite", text: moved },
  ]);
  const taken = t.partner.takePending({ ...scope, sessionId: "s1" });
  t.advance(5 * MIN);
  const next = await say(t.partner, "Anything for the budget review with finance", "s1", t.now());
  const all = [...taken, ...next];
  expect(all.some((i) => i.text.includes("09:30"))).toBe(true);
  expect(updates(all).filter((i) => i.text.includes("11:30"))).toHaveLength(1);
});

describe("one revision, one update, whichever is queued first (D232)", () => {
  for (const order of ["packet-first", "update-first"] as const) {
    test(order, async () => {
      const t = await setup();
      const P = t.partner as any;
      const first = await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
      expect(cites(first, OFFSITE)).toBe(true);
      const s = P.sessions.get("t/u#s1");
      const v1 = P.deps.cache.get(scope, OFFSITE, t.now());
      const v1copy = { ...v1, text: v1.text, title: v1.title };
      t.advance(MIN);
      const cue = { raw: "offsite", terms: new Uint32Array(0), entities: [], span: 0 };
      // A slow-path packet built from the copy read before the revision.
      const stale = () => P.build(s, [{ item: v1copy, score: 1 }], "proactive", "probe", cue, 0);
      if (order === "packet-first") s.pending.push(stale());
      await t.partner.sourceItems(scope, "notes", [
        {
          id: OFFSITE,
          sourceId: "notes",
          ref: "q1",
          title: "Quarterly offsite",
          text: "The quarterly offsite is in Lisbon at 11:30 on 12 November.",
        },
      ]);
      if (order === "update-first") s.pending.push(stale());
      const a = t.partner.takePending({ ...scope, sessionId: "s1" });
      const b = t.partner.takePending({ ...scope, sessionId: "s1" });
      expect(updates([...a, ...b]).filter((i) => i.text.includes("11:30"))).toHaveLength(1);
      // The agent's last word on the item is the new one.
      const last = [...a, ...b].filter((i) => cites([i], OFFSITE)).at(-1)!;
      expect(last.text).toContain("11:30");
    });
  }
});

test("stopSync: a notice starts no revision poll until startSync (D232)", async () => {
  const t = await setup();
  const first = await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
  expect(cites(first, OFFSITE)).toBe(true);
  const lists = () => t.src().lists;
  t.partner.stopSync();
  move(t.src());
  t.advance(MIN);
  const before = lists();
  t.partner.sourceChanged(scope, "notes");
  await t.partner.revisionsSettled(scope);
  expect(lists()).toBe(before);
  t.partner.startSync(3_600_000);
  t.advance(MIN);
  t.partner.sourceChanged(scope, "notes");
  await t.partner.revisionsSettled(scope);
  t.partner.stopSync();
  expect(lists()).toBeGreaterThan(before);
});

test("a stale update queued before a packet with the current copy: the current copy is the last word, sent once (D232)", async () => {
  const t = await setup();
  const P = t.partner as any;
  const first = await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
  expect(cites(first, OFFSITE)).toBe(true);
  const s = P.sessions.get("t/u#s1");
  t.advance(MIN);
  // v2 announced (a notice's items): its update is queued.
  await t.partner.sourceItems(scope, "notes", [
    { id: OFFSITE, sourceId: "notes", ref: "q1", title: "Quarterly offsite", text: moveText("11:30") },
  ]);
  expect(s.pending.length).toBe(1);
  t.advance(MIN);
  // v3 stored by a live search page (not announced) and rendered by a slow-path packet.
  P.store(
    s,
    [{ id: OFFSITE, sourceId: "notes", ref: "q1", title: "Quarterly offsite", text: moveText("15:00") }],
    0,
    false,
    0,
  );
  const cur = P.deps.cache.get(scope, OFFSITE, t.now());
  const cue = { raw: "offsite", terms: new Uint32Array(0), entities: [], span: 0 };
  s.pending.push(P.build(s, [{ item: cur, score: 1 }], "proactive", "probe", cue, 0));
  const a = t.partner.takePending({ ...scope, sessionId: "s1" });
  const b = t.partner.takePending({ ...scope, sessionId: "s1" });
  expect(a.filter((i) => cites([i], OFFSITE)).at(-1)!.text).toContain("15:00");
  expect([...a, ...b].filter((i) => i.text.includes("15:00"))).toHaveLength(1);
});
