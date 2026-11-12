import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// F3 (`syncActivePollMs`, trial; D1131): a quiet source is trusted for up to `syncMaxStaleMs` (6 h) by its learned
// rate, so a silent edit there is handed as the pre-edit copy (D1126). With the floor, an active user's sources are
// polled (one listing call, in the background on the sync's tick) once their last poll is older than the floor: the
// edit is stored before the request that needs it, and no request waits.

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

async function run(syncActivePollMs: number, scope: Scope = { tenantId: "t", userId: "u" }) {
  let clock = T0;
  const src = new Notes("notes");
  for (let k = 0; k < 5; k++) src.docs.set(`n${k}`, { text: `note ${k} unchanged`, at: T0 - (k + 1) * 60 * MIN });
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: { ...CORE_CONFIG, sync: true, syncPageSize: 100, syncActivePollMs },
  });
  partner.sync!.track(scope, clock);
  while (!partner.sync!.warm(scope)) await partner.sync!.tick();
  const lists = src.lists;
  // Edited silently at its source.
  src.docs.set("n2", { text: "note 2 MOVED to Friday", at: clock });
  for (let m = 0; m < 30; m++) {
    clock += MIN;
    await partner.sync!.tick();
  }
  const other = { tenantId: scope.tenantId, userId: `${scope.userId}-other` };
  return {
    held: cache.get(scope, itemId("notes", "n2"), clock)?.text,
    lists: src.lists - lists,
    other: cache.get(other, itemId("notes", "n2"), clock),
  };
}

describe("syncActivePollMs (D1131)", () => {
  test("off: the quiet source is not polled and the pre-edit copy stays", async () => {
    const r = await run(0);
    expect(r.held).toBe("note 2 unchanged");
    expect(r.lists).toBe(0);
  });

  test("on: one listing call an interval stores the edit before any request", async () => {
    const r = await run(10 * MIN);
    expect(r.held).toBe("note 2 MOVED to Friday");
    // 30 minutes at a 10-minute floor: at most three listing calls, one each.
    expect(r.lists).toBeGreaterThanOrEqual(1);
    expect(r.lists).toBeLessThanOrEqual(3);
  });

  test("isolation: what the floor stores lands only in the polled user's cache", async () => {
    const r = await run(10 * MIN);
    expect(r.held).toBe("note 2 MOVED to Friday");
    expect(r.other ?? null).toBeNull();
  });
});
