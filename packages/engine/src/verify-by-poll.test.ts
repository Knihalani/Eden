import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// D345 (`verifyByPoll`, A18): an item a change signal put in doubt is not re-read when a complete poll of its source
// began after the signal (every changed item was listed again) and the source's fetch cannot tell a deletion anyway
// (an MCP tool: no `fetchReportsGone`). A source whose fetch can tell a deletion is re-read as before (D126, D211).

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 9);
const HOLD = itemId("mail", "hold");

class Mail implements Source {
  readonly id = "mail";
  readonly kind = "test";
  readonly description = "mail";
  readonly notifies = true;
  fetches = 0;
  lists = 0;
  /** Thrown by the next listings, when set (a poll that fails leaves the copy behind). */
  listError: string | null = null;
  /** How long a listing takes (ms): a poll still in flight when a delivery checks. */
  listDelayMs = 0;
  items = new Map<string, ContextItem>();
  constructor(readonly fetchReportsGone: boolean) {}
  add(ref: string, title: string, text: string, at: number): void {
    this.items.set(ref, { id: itemId(this.id, ref), sourceId: this.id, ref, title, text, updatedAt: at });
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    // An index that lags the mailbox: it never shows HOLD, so only the synced copy or a fetch answers for it.
    return [...this.items.values()].filter(
      (i) => i.ref !== "hold" && words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)),
    );
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    if (this.listDelayMs > 0) await Bun.sleep(this.listDelayMs);
    if (this.listError) throw new Error(this.listError);
    const sorted = [...this.items.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    return this.items.get(ref) ?? null;
  }
}

async function setup(opts: { fetchReportsGone: boolean; verifyByPoll: boolean }) {
  const src = new Mail(opts.fetchReportsGone);
  let clock = T0;
  // The oldest item: a poll's newest page does not list it again unless it changes.
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
      verifyByPoll: opts.verifyByPoll,
    },
  });
  const user = { tenantId: "t1", userId: "u1" };
  p.sync!.track(user, clock);
  while (!p.sync!.warm(user)) {
    clock += 1_000;
    await p.sync!.tick();
  }
  clock += 10 * 60_000;
  const ask = () => p.ask({ ...user, sessionId: "s1", question: "Is the Harlow invoice on hold?" });
  const signal = () => {
    expect(p.sourceChanged(user, "mail")).toBe(true);
    clock += 60_000;
  };
  const at = () => clock;
  return { p, src, user, ask, signal, at };
}

const citedIds = (r: { citations: { itemId: string }[] }) => r.citations.map((c) => c.itemId);

describe("verifyByPoll (D345): a covering poll answers for a signalled source whose re-read proves no deletion", () => {
  test("control (off): a signal with nothing changed still re-reads the cited item", async () => {
    const { src, ask, signal } = await setup({ fetchReportsGone: false, verifyByPoll: false });
    signal();
    const r = await ask();
    expect(citedIds(r)).toContain(HOLD);
    expect(src.fetches).toBe(1);
  });

  test("on: the ask's own poll covered the signal, so nothing is re-read and the held copy is cited", async () => {
    const { src, ask, signal } = await setup({ fetchReportsGone: false, verifyByPoll: true });
    signal();
    const lists = src.lists;
    const r = await ask();
    expect(src.lists).toBeGreaterThan(lists);
    expect(citedIds(r)).toContain(HOLD);
    expect(src.fetches).toBe(0);
  });

  test("on: an item the source changed after the signal is cited as the poll listed it, with no re-read", async () => {
    const { src, ask, signal, at } = await setup({ fetchReportsGone: false, verifyByPoll: true });
    src.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 30 November", at());
    signal();
    const r = await ask();
    expect(citedIds(r)).toContain(HOLD);
    expect(r.answer).toContain("30 November");
    expect(src.fetches).toBe(0);
  });

  test("on: a source whose fetch tells a deletion is still re-read, and a deleted item is not cited (D211)", async () => {
    const { src, ask, signal } = await setup({ fetchReportsGone: true, verifyByPoll: true });
    src.items.delete("hold");
    signal();
    const r = await ask();
    expect(src.fetches).toBe(1);
    expect(citedIds(r)).not.toContain(HOLD);
  });

  test("on: a poll that failed covers nothing, and the item is re-read", async () => {
    const { src, ask, signal } = await setup({ fetchReportsGone: false, verifyByPoll: true });
    src.listError = "upstream 503";
    signal();
    const r = await ask();
    expect(src.fetches).toBe(1);
    expect(citedIds(r)).toContain(HOLD);
  });

  test("on: a delivery that finds a covering poll in flight waits for it instead of re-reading", async () => {
    const { p, src, user, signal, at } = await setup({ fetchReportsGone: false, verifyByPoll: true });
    signal();
    src.listDelayMs = 40;
    // The poll starts (a lookup's, behind it) and is in flight while the delivery checks its items.
    const polling = p.sync!.freshen(user, [src], new AbortController().signal);
    const verify = p as unknown as {
      verifyItems(s: unknown, scored: unknown[], cue: unknown): Promise<{ item: ContextItem }[]>;
      session(e: unknown): unknown;
    };
    const s = verify.session({ ...user, sessionId: "s2" });
    const cache = (p as unknown as { deps: { cache: ItemCache } }).deps.cache;
    const held = cache.get(user, HOLD, at())!;
    expect(held).toBeTruthy();
    const kept = await verify.verifyItems(s, [{ item: held, score: 1, matched: 0, sketch: null }], {
      id: "c",
      span: 0,
    });
    await polling;
    expect(kept.map((x) => x.item.id)).toEqual([HOLD]);
    expect(src.fetches).toBe(0);
  });
});
