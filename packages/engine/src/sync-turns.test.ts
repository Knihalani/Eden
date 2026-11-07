/**
 * `syncIngestTurns` (D328, on in the default since D370): a background sync page is redacted and stored at its turn,
 * one per turn of the event loop. What the sync keeps is unchanged; only when it is stored moves (its effect on other
 * requests is measured by `bench/storm.bench.ts`); the card drain gathers what waits its turn (D370).
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { ContextItem, Scope } from "@eden/protocol";
import type { ListPage, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CardEnricher, type CardMaker } from "./cards";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

const T0 = Date.UTC(2026, 10, 7, 9);

class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  constructor(
    readonly id: string,
    readonly items: ContextItem[],
  ) {}
  async search(): Promise<ContextItem[]> {
    return [];
  }
  async list(_s: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    await Bun.sleep(1);
    const at = cursor ? Number(cursor) : 0;
    return {
      items: this.items.slice(at, at + limit),
      next: at + limit < this.items.length ? String(at + limit) : null,
    };
  }
}

function sources(user: string, says = "About the budget review"): Source[] {
  return ["mail", "docs"].map(
    (id) =>
      new ListSource(
        id,
        Array.from({ length: 250 }, (_, i) => ({
          id: `${id}:${user}-${i}`,
          sourceId: id,
          ref: `${user}-${i}`,
          title: `${id} note ${i}`,
          text: `${says} ${i} for ${user}`,
          updatedAt: T0 - i * 60_000,
        })),
      ),
  );
}

async function syncUsers(turns: boolean, users: string[]) {
  const cache = new ItemCache();
  cache.close();
  const partner = new ContextPartner({
    sources: async (s) => sources(s.userId),
    sourceMap: new SourceMap(),
    cache,
    budget: new Budget(),
    model: null,
    now: () => T0,
    config: { ...CORE_CONFIG, sync: true, syncBackfillLanes: 8, syncIngestTurns: turns, syncCallsPerMin: 1e6 },
  });
  for (const u of users) partner.sync!.track({ tenantId: "t", userId: u }, T0);
  for (let i = 0; i < 200; i++) {
    await partner.sync!.tick();
    if (users.every((u) => cache.syncedCount({ tenantId: "t", userId: u }) === 500)) break;
  }
  return users.map((u) => {
    const scope = { tenantId: "t", userId: u };
    const ids: string[] = [];
    for (const src of ["mail", "docs"])
      for (let i = 0; i < 250; i++) if (cache.isSynced(scope, `${src}:${u}-${i}`)) ids.push(`${src}:${u}-${i}`);
    return { synced: cache.syncedCount(scope), ids };
  });
}

describe("syncIngestTurns (D328)", () => {
  test("the sync keeps the same items, user by user, with the switch on as off", async () => {
    const users = ["a", "b", "c"];
    const off = await syncUsers(false, users);
    const on = await syncUsers(true, users);
    expect(on).toEqual(off);
    expect(on.every((x) => x.synced === 500)).toBe(true);
  });

  test("cards (D370): with the switch on, the drain gathers what waits its turn; the same items carded", async () => {
    const run = async (turns: boolean, gather: boolean) => {
      const calls: number[] = [];
      const maker: CardMaker = {
        async make(items) {
          calls.push(items.length);
          return {
            cards: items.map(() => ({ kind: "none" as const, actions: [], entities: [], statement: "" })),
            costUsd: 0,
          };
        },
      };
      // The clock moves a second a tick: small pages spend the sync's per-source budget, which refills on it.
      let clock = T0;
      const cards = new CardEnricher({ maker, budget: new Budget(), now: () => clock });
      const cache = new ItemCache();
      cache.close();
      const partner = new ContextPartner({
        sources: async (s) => sources(s.userId, "You must not pay invoice"),
        sourceMap: new SourceMap(),
        cache,
        budget: new Budget(),
        model: null,
        cards,
        now: () => clock,
        config: {
          ...CORE_CONFIG,
          cards: true,
          sync: true,
          syncBackfillLanes: 8,
          syncIngestTurns: turns,
          syncCallsPerMin: 1e6,
          // Pages smaller than a card batch: how the drain batches them shows.
          syncPageSize: 4,
        },
      });
      expect(cards.gather !== null).toBe(turns);
      if (!gather) cards.gather = null;
      const users = ["a", "b"];
      for (const u of users) partner.sync!.track({ tenantId: "t", userId: u }, T0);
      for (let i = 0; i < 2_000; i++) {
        clock += 1_000;
        await partner.sync!.tick();
        if (users.every((u) => cache.syncedCount({ tenantId: "t", userId: u }) === 500)) break;
      }
      await cards.idle();
      return { calls: calls.length, sent: cards.stats.sent, synced: cache.syncedCount({ tenantId: "t", userId: "a" }) };
    };
    const off = await run(false, false);
    const turnsAlone = await run(true, false);
    const on = await run(true, true);
    expect(on.sent).toBe(1_000);
    expect(off.sent).toBe(1_000);
    expect(turnsAlone.sent).toBe(1_000);
    expect(on.calls).toBeLessThanOrEqual(off.calls);
    expect(on.calls).toBeLessThan(turnsAlone.calls);
  });
});
