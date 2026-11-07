import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache, sanitizedId } from "./cache";
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
  /** Per ref: a delay (ms) and errors to throw, one per fetch, before answering. */
  refDelayMs = new Map<string, number>();
  refErrors = new Map<string, string[]>();
  /** Per ref: a gate the fetch waits on after reading the item (what the source said, held on the wire). */
  refGate = new Map<string, Promise<void>>();
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    const delay = this.refDelayMs.get(ref) ?? this.fetchDelayMs;
    if (delay > 0) await Bun.sleep(delay);
    if (this.fetchError) throw new Error(this.fetchError);
    const err = this.refErrors.get(ref)?.shift();
    if (err) throw new Error(err);
    const item = this.items.get(ref) ?? null;
    const gate = this.refGate.get(ref);
    if (gate) await gate;
    return item;
  }
}

async function setup(cache = new ItemCache()) {
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
    cache,
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
  test("a user frozen while the read is on the wire is thawed through ready before the store (D325, A24)", async () => {
    const cache = new ItemCache({ freezeIdleMs: 1, expireEveryMs: 1 });
    cache.close(); // The test runs the expiry ticks.
    const { p, src, user, ask, later, at } = await setup(cache);
    let queued = 0;
    const real = cache.ready.bind(cache);
    cache.ready = (scope) => {
      const r = real(scope);
      if (r) queued++;
      return r;
    };
    src.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 30 November", at());
    src.refDelayMs.set("hold", 20);
    const r = p.sourceRefs(user, "mail", ["hold"]);
    // Both users go idle and freeze while the fetch is on the wire.
    cache.expireIdle(at());
    cache.expireIdle(at());
    expect(cache.frozenCount).toBe(2);
    expect(await r.settled).toBe(1);
    expect(queued).toBe(1);
    expect(cache.freezes.thawed).toBe(1);
    expect(cache.frozenCount).toBe(1); // The other user stays frozen.
    later();
    const fetches = src.fetches;
    const a = await ask();
    expect(a.answer).toContain("30 November");
    expect(src.fetches).toBe(fetches);
  });

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

  test("a read that fails while others are still on the wire: its item is in doubt at once (the plain signal)", async () => {
    const { p, src, user, ask, at } = await setup();
    src.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 30 November", at());
    src.refErrors.set("hold", Array(10).fill("upstream 503"));
    src.refDelayMs.set("n0", 3_000);
    const r = p.sourceRefs(user, "mail", ["hold", "n0"]);
    await Bun.sleep(1_800);
    expect(p.freshness.refsFallback).toBe(1);
    const a = await ask();
    // Not the held copy unread: re-read or polled (the new words), or left out and named; never the old words.
    expect(a.answer).not.toContain("until the dispute ends");
    await r.settled;
  }, 10_000);

  test("a signal while a ref read is on the wire: a delivery reads the item itself, not that read", async () => {
    const { p, src, user, ask, at } = await setup();
    src.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 30 November", at());
    let release!: () => void;
    src.refGate.set("hold", new Promise<void>((r) => (release = r)));
    const r = p.sourceRefs(user, "mail", ["hold"]);
    await Bun.sleep(10);
    src.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 12 December", at() + 1);
    expect(p.sourceChanged(user, "mail")).toBe(true);
    src.refGate.delete("hold");
    const asked = ask();
    await Bun.sleep(20);
    release();
    const a = await asked;
    await r.settled;
    expect(a.answer).toContain("12 December");
    expect(a.answer).not.toContain("30 November");
  });

  test("the ref is stored as the gate left it: a secret-shaped ref is not held raw (D10)", async () => {
    const { p, src, user, at } = await setup();
    const secret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    src.add(secret, "A note", "A note about lunch orders", at());
    await p.sourceRefs(user, "mail", [secret]).settled;
    const cache = (p as unknown as { deps: { cache: ItemCache } }).deps.cache;
    const id = sanitizedId({ id: itemId("mail", secret), sourceId: "mail", ref: secret, title: "", text: "" });
    const held = cache.get(user, id, at());
    expect(held).not.toBeNull();
    expect(`${held!.id} ${held!.ref}`).not.toContain(secret);
  });

  test("a removal while the read is on the wire wins: not revived, not cited", async () => {
    const { p, src, user, ask, later } = await setup();
    let release!: () => void;
    src.refGate.set("hold", new Promise<void>((r) => (release = r)));
    const r = p.sourceRefs(user, "mail", ["hold"]);
    await Bun.sleep(10);
    p.sourceRemoved(user, "mail", ["hold"]);
    release();
    await r.settled;
    later();
    expect(citedIds(await ask())).not.toContain(HOLD);
  });

  test("forget while reads are queued: the reads stop and nothing is stored", async () => {
    const { p, src, user } = await setup();
    src.fetchDelayMs = 30;
    const refs = Array.from({ length: 10 }, (_, i) => `x${i}`);
    for (const ref of refs) src.add(ref, `Item ${ref}`, `Item ${ref} text`, T0);
    const r = p.sourceRefs(user, "mail", refs);
    await Bun.sleep(5);
    p.forget(user);
    await r.settled;
    expect(src.fetches).toBeLessThanOrEqual(2);
  });

  test("one plain error then an answer: read on the retry, no fallback to the signal", async () => {
    const { p, src, user, ask, later, at } = await setup();
    src.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 30 November", at());
    src.refErrors.set("hold", ["upstream 503"]);
    expect(await p.sourceRefs(user, "mail", ["hold"]).settled).toBe(1);
    expect(p.freshness.refsFallback).toBe(0);
    later();
    const before = src.fetches;
    const a = await ask("Who is on the lunch orders note?");
    expect(a.citations.length).toBeGreaterThan(0);
    expect(src.fetches).toBe(before);
  });

  test("a read slower than verifyTimeoutMs: an ask stops waiting and leaves the item out, named (D211)", async () => {
    const { p, src, user, ask, at } = await setup();
    src.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 30 November", at());
    src.refDelayMs.set("hold", 2_200);
    const r = p.sourceRefs(user, "mail", ["hold"]);
    const a = await ask();
    expect(citedIds(a)).not.toContain(HOLD);
    expect(a.answer).toContain("could not be re-checked");
    await r.settled;
  }, 10_000);

  test("a copy a session held from before the read landed goes out as the read found it", async () => {
    const { p, src, user, at } = await setup();
    const inner = p as unknown as {
      verifyItems(s: unknown, scored: unknown[], cue: unknown): Promise<{ item: ContextItem }[]>;
      session(e: unknown): unknown;
      deps: { cache: ItemCache };
    };
    const s = inner.session({ ...user, sessionId: "s9" });
    const old = inner.deps.cache.get(user, HOLD, at())!;
    expect(old.text).toContain("until the dispute ends");
    src.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 30 November", at());
    await p.sourceRefs(user, "mail", ["hold"]).settled;
    const kept = await inner.verifyItems(s, [{ item: old, score: 1, matched: 0, sketch: null }], { id: "c", span: 0 });
    expect(kept.map((x) => x.item.text).join(" ")).toContain("30 November");
  });

  test("a landed read is noted in that user's sessions only: another user's sessions are not walked", async () => {
    const { p, src, user, user2, at } = await setup();
    type S = { checks?: Map<string, unknown>; closed: boolean };
    const inner = p as unknown as { session(e: unknown): S };
    const mine = [inner.session({ ...user, sessionId: "a" }), inner.session({ ...user, sessionId: "b" })];
    const theirs = Array.from({ length: 5 }, (_, i) => inner.session({ ...user2, sessionId: `o${i}` }));
    // Count every read of another user's session's state from here on.
    let reads = 0;
    for (const s of theirs) {
      let closed = s.closed;
      Object.defineProperty(s, "closed", {
        get: () => (reads++, closed),
        set: (v: boolean) => void (closed = v),
      });
    }
    src.add("hold", "Harlow invoice on hold", "Harlow invoice payments are on hold until 30 November", at());
    expect(await p.sourceRefs(user, "mail", ["hold"]).settled).toBe(1);
    for (const s of mine) expect(s.checks?.has(HOLD)).toBe(true);
    for (const s of theirs) expect(s.checks).toBeUndefined();
    expect(reads).toBe(0);
  });
});
