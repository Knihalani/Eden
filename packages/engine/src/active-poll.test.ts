import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// F3 (`syncActivePollMs`, trial; D1131): a quiet source is trusted for up to `syncMaxStaleMs` (6 h) by its learned
// rate, so a silent edit there is handed as the pre-edit copy (D1126). With the floor, an active user's sources whose
// last complete poll is older than the floor are polled in the background on the sync's tick: the edit is stored
// before the request that needs it, and no request waits.

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9);

class Notes implements Source {
  readonly kind = "test";
  readonly description = "notes";
  docs = new Map<string, { text: string; at: number }>();
  lists = 0;
  /** A listing at this cursor throws once (a connector's transient failure mid-poll). */
  failOnceAt: string | undefined;
  constructor(readonly id: string) {}
  item(ref: string): ContextItem {
    const d = this.docs.get(ref)!;
    return { id: itemId(this.id, ref), sourceId: this.id, ref, title: ref, text: d.text, updatedAt: d.at };
  }
  async search(_q: SearchQuery): Promise<ContextItem[]> {
    return [];
  }
  async list(_s: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    if (cursor !== undefined && cursor === this.failOnceAt) {
      this.failOnceAt = undefined;
      throw new Error("connector hiccup");
    }
    const all = [...this.docs.keys()].map((r) => this.item(r)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

const A: Scope = { tenantId: "t", userId: "a" };
const B: Scope = { tenantId: "t", userId: "b" };

/** Two users, each with their own notes source of `n` items, both synced warm on a clock the test moves. */
async function setup(
  syncActivePollMs: number,
  n = 5,
  notifies = false,
  extra: { syncActivePollBackoff?: boolean; syncActivePollPriced?: boolean; callPriced?: boolean | "unmarked" } = {},
) {
  const clock = { now: T0 };
  const src = { a: new Notes("notes"), b: new Notes("notes") };
  // First-party unless the test says otherwise; "unmarked" leaves the field absent (unknown, D1133).
  for (const s of [src.a, src.b]) {
    Object.assign(s, { notifies });
    if (extra.callPriced !== "unmarked") Object.assign(s, { callPriced: extra.callPriced === true });
  }
  for (const s of [src.a, src.b])
    for (let k = 0; k < n; k++) s.docs.set(`n${k}`, { text: `note ${k} unchanged`, at: T0 - (k + 1) * 60 * MIN });
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: async (scope) => [scope.userId === "a" ? src.a : src.b],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock.now,
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPush: notifies,
      syncPageSize: 10,
      syncActivePollMs,
      syncActivePollBackoff: extra.syncActivePollBackoff === true,
      syncActivePollPriced: extra.syncActivePollPriced === true,
    },
  });
  const sync = partner.sync!;
  for (const scope of [A, B]) sync.track(scope, clock.now);
  while (!sync.warm(A) || !sync.warm(B)) await sync.tick();
  const tick = async (minutes: number) => {
    for (let m = 0; m < minutes; m++) {
      clock.now += MIN;
      // The users stay active (an event every minute), as a session in use is.
      for (const scope of [A, B]) sync.track(scope, clock.now);
      await sync.tick();
    }
  };
  const held = (scope: Scope, ref: string) => cache.get(scope, itemId("notes", ref), clock.now)?.text;
  return { clock, src, sync, tick, held };
}

describe("syncActivePollMs (D1131)", () => {
  test("off: the quiet source is not polled and the pre-edit copy stays", async () => {
    const t = await setup(0);
    const lists = t.src.a.lists;
    t.src.a.docs.set("n2", { text: "note 2 MOVED to Friday", at: t.clock.now });
    await t.tick(30);
    expect(t.held(A, "n2")).toBe("note 2 unchanged");
    expect(t.src.a.lists - lists).toBe(0);
  });

  test("on: the edit is stored in the background before any request, at about one poll an interval", async () => {
    const t = await setup(10 * MIN);
    const lists = t.src.a.lists;
    t.src.a.docs.set("n2", { text: "note 2 MOVED to Friday", at: t.clock.now });
    await t.tick(30);
    expect(t.held(A, "n2")).toBe("note 2 MOVED to Friday");
    // 30 minutes at a 10-minute floor: three polls of one page each (the boundary is on the first page).
    expect(t.src.a.lists - lists).toBeGreaterThanOrEqual(1);
    expect(t.src.a.lists - lists).toBeLessThanOrEqual(3);
  });

  test("more new items than a page: the floor reads to the boundary, so nothing past its first page is lost", async () => {
    // D1131's review: a one-page floor stored the newest page and left it as a false boundary; the next poll stopped
    // there and marked the source current with the rest never read.
    const t = await setup(10 * MIN, 50);
    for (let k = 0; k < 30; k++) t.src.a.docs.set(`new${k}`, { text: `new note ${k}`, at: t.clock.now + k });
    await t.tick(20);
    for (let k = 0; k < 30; k++) expect(t.held(A, `new${k}`)).toBe(`new note ${k}`);
  });

  test("isolation: one user's floor poll lists and stores only their own source", async () => {
    const t = await setup(10 * MIN);
    t.src.a.docs.set("n2", { text: "note 2 MOVED to Friday", at: t.clock.now });
    await t.tick(30);
    expect(t.held(A, "n2")).toBe("note 2 MOVED to Friday");
    // B's source holds the original, and B's copy is B's own.
    expect(t.held(B, "n2")).toBe("note 2 unchanged");
    t.src.b.docs.set("n3", { text: "note 3 for b only", at: t.clock.now });
    await t.tick(15);
    expect(t.held(B, "n3")).toBe("note 3 for b only");
    expect(t.held(A, "n3")).toBe("note 3 unchanged");
  });

  test("a source that notifies is not polled by the floor: its notices keep it current", async () => {
    const t = await setup(10 * MIN, 5, true);
    const lists = t.src.a.lists;
    await t.tick(30);
    expect(t.src.a.lists - lists).toBe(0);
  });

  test("backoff: a quiet source's floor polls thin out to a quarter, bounded", async () => {
    // 10-minute floor, so up to 40 minutes between polls: in 300 quiet minutes at most 30 polls without the backoff,
    // and with it 10, 20, then every 40 minutes.
    const plain = await setup(10 * MIN);
    const back = await setup(10 * MIN, 5, false, { syncActivePollBackoff: true });
    const [p0, b0, bb0] = [plain.src.a.lists, back.src.a.lists, back.src.b.lists];
    await plain.tick(150);
    // B's source changes throughout while A's stays quiet: B keeps the floor, A's state does not touch B's.
    for (let k = 0; k < 15; k++) {
      back.src.b.docs.set(`b${k}`, { text: `b edit ${k}`, at: back.clock.now });
      await back.tick(10);
    }
    await plain.tick(150);
    await back.tick(150);
    const [p, b] = [plain.src.a.lists - p0, back.src.a.lists - b0];
    expect(back.src.b.lists - bb0).toBeGreaterThanOrEqual(12);
    expect(p).toBeGreaterThanOrEqual(25);
    expect(b).toBeLessThanOrEqual(10);
    expect(b).toBeGreaterThanOrEqual(6);
  });

  test("backoff: a source that changes keeps the floor, and an edit after a quiet spell is back to the floor", async () => {
    const t = await setup(10 * MIN, 5, false, { syncActivePollBackoff: true });
    await t.tick(120); // Quiet: backed off to 40 minutes.
    // A source edited every 10 minutes: each floor poll finds something, so it is polled every 10-40 minutes and
    // never waits the backed-off 40 after the first find.
    const lists = t.src.a.lists;
    for (let k = 0; k < 9; k++) {
      t.src.a.docs.set(`e${k}`, { text: `edit ${k}`, at: t.clock.now });
      await t.tick(10);
    }
    expect(t.src.a.lists - lists).toBeGreaterThanOrEqual(6);
    expect(t.held(A, "e8")).toBe("edit 8");
  });

  test("a source billed per call is not polled by the floor unless the deployment opts in", async () => {
    const off = await setup(10 * MIN, 5, false, { callPriced: true });
    const on = await setup(10 * MIN, 5, false, { callPriced: true, syncActivePollPriced: true });
    const [o0, n0] = [off.src.a.lists, on.src.a.lists];
    off.src.a.docs.set("n2", { text: "note 2 MOVED to Friday", at: off.clock.now });
    on.src.a.docs.set("n2", { text: "note 2 MOVED to Friday", at: on.clock.now });
    await off.tick(30);
    await on.tick(30);
    expect(off.src.a.lists - o0).toBe(0);
    expect(off.held(A, "n2")).toBe("note 2 unchanged");
    expect(on.src.a.lists - n0).toBeGreaterThanOrEqual(1);
    expect(on.held(A, "n2")).toBe("note 2 MOVED to Friday");
  });

  test("a floor poll cut off after its first page leaves no false boundary: the next poll reads on (review)", async () => {
    // 50 old notes, 30 new, pages of 10: the first floor poll stores page 1, then page 2 throws. Without the fix the
    // next poll stopped at page 1's items (held, unchanged), marked the source current, and 20 new notes were never
    // read until the daily sweep.
    const t = await setup(10 * MIN, 50);
    for (let k = 0; k < 30; k++) t.src.a.docs.set(`new${k}`, { text: `new note ${k}`, at: t.clock.now + k });
    t.src.a.failOnceAt = "10";
    await t.tick(240);
    for (let k = 0; k < 30; k++) expect(t.held(A, `new${k}`)).toBe(`new note ${k}`);
  });

  test("fail safe (D1133): a source with no price information is not floor-polled; marked first-party it is", async () => {
    const unmarked = await setup(10 * MIN, 5, false, { callPriced: "unmarked" });
    const marked = await setup(10 * MIN, 5, false, { callPriced: false });
    expect("callPriced" in unmarked.src.a).toBe(false);
    const [u0, m0] = [unmarked.src.a.lists, marked.src.a.lists];
    unmarked.src.a.docs.set("n2", { text: "note 2 MOVED to Friday", at: unmarked.clock.now });
    marked.src.a.docs.set("n2", { text: "note 2 MOVED to Friday", at: marked.clock.now });
    await unmarked.tick(30);
    await marked.tick(30);
    expect(unmarked.src.a.lists - u0).toBe(0);
    expect(unmarked.held(A, "n2")).toBe("note 2 unchanged");
    expect(marked.src.a.lists - m0).toBeGreaterThanOrEqual(1);
    expect(marked.held(A, "n2")).toBe("note 2 MOVED to Friday");
  });
});
