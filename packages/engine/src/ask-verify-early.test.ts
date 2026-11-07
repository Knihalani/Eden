import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// D346 (`askVerifyEarly`, A18): an explicit ask re-reads the doubted items it is likely to cite while its on-demand
// poll runs, not after it, so its wait is about the longer of the two rather than their sum. What it cites, and the
// strict rule for what no re-read confirmed (D211), do not change.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 9);
const HOLD = itemId("mail", "hold");

class Mail implements Source {
  readonly id = "mail";
  readonly kind = "test";
  readonly description = "mail";
  readonly notifies = true;
  readonly fetchReportsGone = true;
  fetches = 0;
  /** Each listing and fetch takes this long (ms), once the backfill is done. */
  delayMs = 0;
  items = new Map<string, ContextItem>();
  add(ref: string, title: string, text: string, at: number): void {
    this.items.set(ref, { id: itemId(this.id, ref), sourceId: this.id, ref, title, text, updatedAt: at });
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return [...this.items.values()].filter(
      (i) => i.ref !== "hold" && words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)),
    );
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    if (this.delayMs > 0) await Bun.sleep(this.delayMs);
    const sorted = [...this.items.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    if (this.delayMs > 0) await Bun.sleep(this.delayMs);
    return this.items.get(ref) ?? null;
  }
}

async function setup(askVerifyEarly: boolean) {
  const src = new Mail();
  let clock = T0;
  src.add(
    "hold",
    "Harlow invoice on hold",
    "Harlow invoice payments are on hold until the dispute ends",
    T0 - 9 * HOUR,
  );
  for (let i = 0; i < 3; i++) src.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (1 + i) * HOUR);
  const p = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPush: true,
      syncOnDemand: true,
      syncPageSize: 1,
      syncPollPageSize: 1,
      syncCallsPerMin: 600,
      verifyDelivery: true,
      askVerifyEarly,
    },
  });
  const user = { tenantId: "t1", userId: "u1" };
  p.sync!.track(user, clock);
  while (!p.sync!.warm(user)) {
    clock += 1_000;
    await p.sync!.tick();
  }
  clock += 10 * 60_000;
  expect(p.sourceChanged(user, "mail")).toBe(true);
  clock += 60_000;
  const ask = () => p.ask({ ...user, sessionId: "s1", question: "Is the Harlow invoice on hold?" });
  return { src, ask };
}

const citedIds = (r: { citations: { itemId: string }[] }) => r.citations.map((c) => c.itemId);

describe("askVerifyEarly (D346): the ask's re-reads run beside its poll", () => {
  test("off: the poll, then the re-read (their sum)", async () => {
    const { src, ask } = await setup(false);
    src.delayMs = 120;
    const t0 = performance.now();
    const r = await ask();
    const ms = performance.now() - t0;
    expect(citedIds(r)).toContain(HOLD);
    expect(src.fetches).toBe(1);
    expect(ms).toBeGreaterThanOrEqual(230);
  });

  test("on: the same answer and the same one re-read, in about the longer of the two", async () => {
    const { src, ask } = await setup(true);
    src.delayMs = 120;
    const t0 = performance.now();
    const r = await ask();
    const ms = performance.now() - t0;
    expect(citedIds(r)).toContain(HOLD);
    expect(src.fetches).toBe(1);
    expect(ms).toBeLessThan(220);
  });

  test("on: a deleted item read early is still left out (D211)", async () => {
    const { src, ask } = await setup(true);
    src.items.delete("hold");
    src.delayMs = 50;
    const r = await ask();
    expect(citedIds(r)).not.toContain(HOLD);
    expect(src.fetches).toBe(1);
  });
});
