import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// D347 (A18): a change notice that names the refs it changed (no content). Those refs are re-read in the background
// and stored; nothing else of the source is put in doubt, so later deliveries re-read nothing and lookups poll nothing
// for it. A ref that cannot be read turns the notice into a plain signal (D126 as before).

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
  lists = 0;
  /** Each fetch takes this long (ms). */
  fetchDelayMs = 0;
  /** The next fetches throw this, while set. */
  fetchError: string | null = null;
  items = new Map<string, ContextItem>();
  add(ref: string, title: string, text: string, at: number): void {
    this.items.set(ref, { id: itemId(this.id, ref), sourceId: this.id, ref, title, text, updatedAt: at });
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    // An index that lags the mailbox: only the synced copy or a fetch answers for HOLD.
    return [...this.items.values()].filter(
      (i) => i.ref !== "hold" && words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)),
    );
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const sorted = [...this.items.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    if (this.fetchDelayMs > 0) await Bun.sleep(this.fetchDelayMs);
    if (this.fetchError) throw new Error(this.fetchError);
    return this.items.get(ref) ?? null;
  }
}

async function setup() {
  const src = new Mail();
  const other = new Mail();
  let clock = T0;
  for (const m of [src, other]) {
    m.add(
      "hold",
      "Harlow invoice on hold",
      "Harlow invoice payments are on hold until the dispute ends",
      T0 - 9 * HOUR,
    );
    for (let i = 0; i < 3; i++) m.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (1 + i) * HOUR);
  }
  const user = { tenantId: "t1", userId: "u1" };
  const user2 = { tenantId: "t1", userId: "u2" };
  const p = new ContextPartner({
    sources: async (scope) => [scope.userId === "u1" ? src : other],
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
    },
  });
  for (const u of [user, user2]) {
    p.sync!.track(u, clock);
    while (!p.sync!.warm(u)) {
      clock += 1_000;
      await p.sync!.tick();
    }
  }
  clock += 10 * 60_000;
  const ask = (question = "Is the Harlow invoice on hold?", who = user) => p.ask({ ...who, sessionId: "s1", question });
  const later = () => (clock += 60_000);
  return { p, src, other, user, user2, ask, later, at: () => clock };
}

const citedIds = (r: { citations: { itemId: string }[] }) => r.citations.map((c) => c.itemId);

describe("sourceRefs (D347): a notice naming its changed refs", () => {
  test("the named item is re-read and stored; an ask then cites it with no further call", async () => {
    const { p, src, user, ask, later, at } = await setup();
    src.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 30 November", at());
    const r = p.sourceRefs(user, "mail", ["hold"]);
    expect(r.synced).toBe(true);
    expect(await r.settled).toBe(1);
    later();
    const fetches = src.fetches;
    const lists = src.lists;
    const a = await ask();
    expect(citedIds(a)).toContain(HOLD);
    expect(a.answer).toContain("30 November");
    expect(src.fetches).toBe(fetches);
    expect(src.lists).toBe(lists);
  });

  test("the source's other items are not put in doubt: no re-read, where a plain signal re-reads", async () => {
    const plain = await setup();
    plain.p.sourceChanged(plain.user, "mail");
    plain.later();
    await plain.ask("Who is on the lunch orders note?");
    const signalled = plain.src.fetches;
    expect(signalled).toBeGreaterThan(0);

    const { p, src, user, ask, later } = await setup();
    await p.sourceRefs(user, "mail", ["hold"]).settled;
    later();
    const before = src.fetches;
    const a = await ask("Who is on the lunch orders note?");
    expect(citedIds(a).some((id) => id.startsWith("mail:n"))).toBe(true);
    expect(src.fetches).toBe(before);
  });

  test("an ask while the re-read is on the wire waits on it: the new copy, and one call in all", async () => {
    const { p, src, user, ask, at } = await setup();
    src.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 30 November", at());
    src.fetchDelayMs = 60;
    const r = p.sourceRefs(user, "mail", ["hold"]);
    const a = await ask();
    await r.settled;
    expect(citedIds(a)).toContain(HOLD);
    expect(a.answer).toContain("30 November");
    expect(src.fetches).toBe(1);
  });

  test("a ref the source no longer has is dropped and not cited", async () => {
    const { p, src, user, ask, later } = await setup();
    src.items.delete("hold");
    await p.sourceRefs(user, "mail", ["hold"]).settled;
    later();
    expect(citedIds(await ask())).not.toContain(HOLD);
  });

  test("a ref that could not be read falls back to the plain signal: the source is in doubt again", async () => {
    const { p, src, user, ask, later } = await setup();
    src.fetchError = "upstream 503";
    await p.sourceRefs(user, "mail", ["hold"]).settled;
    src.fetchError = null;
    later();
    const before = src.fetches;
    const a = await ask("Who is on the lunch orders note?");
    expect(citedIds(a).some((id) => id.startsWith("mail:n"))).toBe(true);
    expect(src.fetches).toBeGreaterThan(before);
  });

  test("a source not synced takes the plain signal's answer; push off says so", async () => {
    const { p, user } = await setup();
    const r = p.sourceRefs(user, "drive", ["x"]);
    expect(r.synced).toBe(false);
    expect(r.reason).toBe("not-synced");
    expect(await r.settled).toBe(0);
  });

  test("isolation: another user's item with the same ref is neither re-read nor in doubt", async () => {
    const { p, other, user, user2, ask, at } = await setup();
    other.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 30 November", at());
    other.fetchDelayMs = 0;
    const r = p.sourceRefs(user, "mail", ["hold"]);
    const a = await ask(undefined, user2);
    await r.settled;
    expect(other.fetches).toBe(0);
    expect(a.answer).toContain("until the dispute ends");
  });
});
