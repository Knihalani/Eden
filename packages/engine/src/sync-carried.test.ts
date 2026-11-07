import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";

// A8 (trial `syncCarriedSweepMs`): a notifying source whose notices carry their items and deletions is swept on the
// trial's longer cadence; one that only signals, or that has signalled bare since, keeps the daily sweep.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 20, 9);
const scope: Scope = { tenantId: "t1", userId: "u1" };

class Mail implements Source {
  readonly id = "mail";
  readonly kind = "mail";
  readonly description = "mail";
  readonly listsByTime = true;
  readonly notifies = true;
  lists = 0;
  items: ContextItem[] = Array.from({ length: 5 }, (_, i) => ({
    id: itemId("mail", `m${i}`),
    sourceId: "mail",
    ref: `m${i}`,
    title: `Mail ${i}`,
    text: `Message number ${i} about the quarterly plan`,
    updatedAt: T0 - i * HOUR,
  }));
  async search(): Promise<ContextItem[]> {
    return [];
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const from = cursor ? Number(cursor) : 0;
    const page = this.items.slice(from, from + limit);
    return { items: page, next: from + limit < this.items.length ? String(from + limit) : null };
  }
}

async function warm(config: Record<string, unknown>) {
  let clock = T0;
  const src = new Mail();
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:"),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: { ...CORE_CONFIG, sync: true, syncPush: true, syncPageSize: 100, syncSweepMs: DAY, ...config },
  });
  partner.sync!.track(scope);
  while (!partner.sync!.warm(scope)) await partner.sync!.tick();
  /** Moves the clock, keeps the user active (sweeps run for active users only) and runs a few ticks. */
  const after = async (ms: number) => {
    clock += ms;
    partner.sync!.track(scope);
    const before = src.lists;
    for (let i = 0; i < 3; i++) await partner.sync!.tick();
    return src.lists - before;
  };
  const pushed = (ref: string): ContextItem => ({
    id: itemId("mail", ref),
    sourceId: "mail",
    ref,
    title: `Pushed ${ref}`,
    text: `A pushed message ${ref}`,
    updatedAt: clock,
  });
  return { src, cache, partner, after, pushed, now: () => clock };
}

describe("syncCarriedSweepMs: sources whose notices carry their changes are swept less often (A8 trial)", () => {
  test("off (the default): a source that carried items is swept daily, as before", async () => {
    const { partner, after, pushed } = await warm({});
    expect(await partner.sourceItems(scope, "mail", [pushed("p1")])).toBe(1);
    expect(await after(DAY + HOUR)).toBeGreaterThan(0);
  });

  test("on: after carried items the daily sweep waits for the trial's cadence; deletions still arrive as removals", async () => {
    const { partner, after, pushed, cache, now } = await warm({ syncCarriedSweepMs: 7 * DAY });
    expect(await partner.sourceItems(scope, "mail", [pushed("p1")])).toBe(1);
    expect(await after(DAY + HOUR)).toBe(0);
    expect(await after(DAY)).toBe(0);
    // A removal notice drops the item at once, with no call.
    expect(partner.sourceRemoved(scope, "mail", ["m2"])).toBe(1);
    expect(cache.get(scope, itemId("mail", "m2"), now())).toBeNull();
    expect(await after(5 * DAY)).toBeGreaterThan(0); // Seven days since the last sweep: swept again.
  });

  test("on: a removal notice alone also marks the source as carrying its changes", async () => {
    const { partner, after } = await warm({ syncCarriedSweepMs: 7 * DAY });
    partner.sourceRemoved(scope, "mail", ["m1"]);
    expect(await after(DAY + HOUR)).toBe(0);
  });

  test("on: a source that only signals keeps the daily sweep (it is how a signal's deletion is found)", async () => {
    const { partner, after } = await warm({ syncCarriedSweepMs: 7 * DAY });
    expect(partner.sourceChanged(scope, "mail")).toBe(true);
    expect(await after(DAY + HOUR)).toBeGreaterThan(0);
  });

  test("on: a bare signal after carried items (a client falling back) brings the daily sweep back", async () => {
    const { partner, after, pushed } = await warm({ syncCarriedSweepMs: 7 * DAY });
    await partner.sourceItems(scope, "mail", [pushed("p1")]);
    expect(await after(DAY + HOUR)).toBe(0);
    expect(partner.sourceChanged(scope, "mail")).toBe(true);
    expect(await after(HOUR)).toBeGreaterThan(0); // Already past a day since the last sweep.
    // Items carried again: back on the trial's cadence after this sweep.
    await partner.sourceItems(scope, "mail", [pushed("p2")]);
    expect(await after(DAY + HOUR)).toBe(0);
  });

  test("on: a sweep still drops what two sweeps in a row miss (the backstop for a lost removal)", async () => {
    const { src, partner, after, pushed, cache, now } = await warm({ syncCarriedSweepMs: 2 * DAY });
    await partner.sourceItems(scope, "mail", [pushed("p1")]);
    src.items = src.items.filter((i) => i.ref !== "m3"); // Deleted, and its notice lost.
    await after(2 * DAY + HOUR);
    expect(cache.get(scope, itemId("mail", "m3"), now())).not.toBeNull(); // One miss: kept (D57).
    await after(2 * DAY + HOUR);
    expect(cache.get(scope, itemId("mail", "m3"), now())).toBeNull();
  });
});
