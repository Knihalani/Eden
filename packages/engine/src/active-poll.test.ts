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
    const all = [...this.docs.keys()].map((r) => this.item(r)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

const A: Scope = { tenantId: "t", userId: "a" };
const B: Scope = { tenantId: "t", userId: "b" };

/** Two users, each with their own notes source of `n` items, both synced warm on a clock the test moves. */
async function setup(syncActivePollMs: number, n = 5) {
  const clock = { now: T0 };
  const src = { a: new Notes("notes"), b: new Notes("notes") };
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
    config: { ...CORE_CONFIG, sync: true, syncPageSize: 10, syncActivePollMs },
  });
  const sync = partner.sync!;
  for (const scope of [A, B]) sync.track(scope, clock.now);
  while (!sync.warm(A) || !sync.warm(B)) await sync.tick();
  const tick = async (minutes: number) => {
    for (let m = 0; m < minutes; m++) {
      clock.now += MIN;
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
});
