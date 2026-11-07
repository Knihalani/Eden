import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { Ledger } from "./ledger";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// `revisionNotice` (trial, D205): an item a session was handed that changes at its source is sent again, once per
// revision, as an "updated:" packet before the agent's next model call.

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9);

/** A connector that lists and notifies; its items can change between calls. */
class Listed implements Source {
  readonly kind = "test";
  readonly description = "notes";
  readonly notifies = true;
  searches = 0;
  lists = 0;
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
    return this.item(ref);
  }
  async list(_s: Scope, cursor: string | undefined, limit: number) {
    this.lists++;
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
};
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

  test("off (the default): no updated packet", async () => {
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
