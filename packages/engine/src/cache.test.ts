import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { ItemCache } from "./cache";
import { termIds } from "./text";

const alice = { tenantId: "t", userId: "alice" };
const item = (sourceId: string, ref: string, text: string): ContextItem => ({
  id: `${sourceId}:${ref}`,
  sourceId,
  ref,
  title: `Item ${ref}`,
  text,
});

describe("ItemCache bounds (branch review)", () => {
  test("forgetting a source leaves none of its terms in the user's vocabulary", () => {
    const cache = new ItemCache();
    cache.put(alice, [item("crm", "1", "Quentavious renewal notes"), item("mail", "2", "Globex renewal call")]);
    expect(cache.peekVocab(alice)!.lookup("quentavious")).toBeGreaterThanOrEqual(0);
    cache.forget(alice, "crm");
    expect(cache.peekVocab(alice)!.lookup("quentavious")).toBe(-1);
    // What is left still ranks.
    const q = termIds("globex renewal", cache.peekVocab(alice)!, false);
    expect(cache.search(alice, q.ids, q.n, 5).map((h) => h.item.id)).toEqual(["mail:2"]);
  });

  test("the vocabulary is rebuilt once it outgrows the live items", () => {
    const cache = new ItemCache({ maxItemsPerUser: 10 });
    for (let i = 0; i < 400; i++) {
      const words = Array.from({ length: 200 }, (_, j) => `w${i}x${j}`).join(" ");
      cache.put(alice, [item("db", String(i), `${words} shared`)]);
    }
    // 80,000 distinct terms went through; 10 items of ~201 terms each are live.
    expect(cache.peekVocab(alice)!.size).toBeLessThan(50_001 + 201);
    const q = termIds("shared", cache.peekVocab(alice)!, false);
    expect(cache.search(alice, q.ids, q.n, 20)).toHaveLength(10);
  });

  test("reading a user with no cache allocates nothing", () => {
    const cache = new ItemCache();
    expect(cache.peekVocab(alice)).toBeUndefined();
    expect(cache.search(alice, [1], 1, 5)).toEqual([]);
    expect(cache.userCount).toBe(0);
  });

  test("re-putting an unchanged item only refreshes it; a changed one is re-indexed and reported", () => {
    const cache = new ItemCache({ ttlMs: 1_000 });
    const a = item("crm", "1", "Globex renewal notes");
    expect(cache.put(alice, [a], 0).map((i) => i.id)).toEqual(["crm:1"]);
    expect(cache.put(alice, [{ ...a, url: "https://crm.example/1?v=2" }], 900)).toEqual([]); // Same words: refreshed.
    expect(cache.get(alice, "crm:1", 900)?.url).toBe("https://crm.example/1?v=2"); // With the new url (review).
    expect(cache.get(alice, "crm:1", 1_800)).not.toBeNull(); // The refresh moved its TTL.
    const changed = { ...a, text: "Globex renewal moved to December" };
    expect(cache.put(alice, [changed], 1_800).map((i) => i.text)).toEqual([changed.text]);
    const q = termIds("december", cache.peekVocab(alice)!, false);
    expect(cache.search(alice, q.ids, q.n, 5, 1_800).map((h) => h.item.id)).toEqual(["crm:1"]);
  });
});

describe("selfOf: the user's own name, read from their items", () => {
  const mail = (i: number, from: string, to: string) => ({
    id: `g:${i}`,
    sourceId: "gmail",
    ref: String(i),
    title: `Mail ${i}`,
    text: `From: ${from} <a${i}@x.example>\nTo: ${to} <b${i}@x.example>\n\nBody ${i}`,
  });
  test("the person on most of a user's items, once there are enough of them; per user", () => {
    const cache = new ItemCache();
    const u1 = { tenantId: "t", userId: "u1" };
    const u2 = { tenantId: "t", userId: "u2" };
    cache.put(u1, [mail(1, "Jamie Fox", "Robin Carter"), mail(2, "Robin Carter", "Dana Lee")], 0);
    expect(cache.selfOf(u1)).toBeNull(); // Two items: too few to say.
    cache.put(
      u1,
      [3, 4, 5, 6, 7].map((i) => mail(i, `Person ${String.fromCharCode(64 + i)}`, "Robin Carter")),
      0,
    );
    expect(cache.selfOf(u1)).toBe("Robin Carter");
    expect(cache.selfOf(u2)).toBeNull();
    cache.put(
      u2,
      [1, 2, 3, 4, 5].map((i) => mail(10 + i, "Alex Moreno", `Person ${String.fromCharCode(64 + i)}`)),
      0,
    );
    expect(cache.selfOf(u2)).toBe("Alex Moreno");
    expect(cache.selfOf(u1)).toBe("Robin Carter");
  });
});

describe("revision: changes with the user's items, not with a refresh", () => {
  const scope = { tenantId: "t", userId: "u1" };
  const it = (id: string, text: string, meta?: Record<string, string>): ContextItem => ({
    id,
    sourceId: "mail",
    ref: id,
    title: id,
    text,
    ...(meta ? { meta } : {}),
  });

  test("an added, changed or dropped item changes it; a refresh of the same copy does not", () => {
    const c = new ItemCache();
    expect(c.revision(scope)).toBe(0);
    c.put(scope, [it("a", "alpha")], 1_000);
    const r1 = c.revision(scope);
    expect(r1).toBeGreaterThan(0);
    c.put(scope, [it("a", "alpha")], 2_000);
    expect(c.revision(scope)).toBe(r1);
    c.put(scope, [it("a", "alpha", { start: "2026-11-02" })], 3_000);
    const r2 = c.revision(scope);
    expect(r2).not.toBe(r1);
    c.put(scope, [it("a", "alpha changed", { start: "2026-11-02" })], 4_000);
    const r3 = c.revision(scope);
    expect(r3).not.toBe(r2);
    c.forget(scope, "mail");
    expect(c.revision(scope)).not.toBe(r3);
  });

  test("per user: another user's items do not change it", () => {
    const c = new ItemCache();
    c.put(scope, [it("a", "alpha")], 1_000);
    const r = c.revision(scope);
    c.put({ tenantId: "t", userId: "u2" }, [it("b", "beta")], 1_000);
    expect(c.revision(scope)).toBe(r);
  });
});

describe("expireIdle: idle users and expired items are freed, not held until the user writes again", () => {
  const H = 3_600_000;
  const t0 = Date.UTC(2026, 9, 14, 9);
  const bob = { tenantId: "t", userId: "bob" };
  const other = { tenantId: "u", userId: "carol" };

  test("a user whose items are all past ttlMs is dropped, and the drop hook hears (scope, null)", () => {
    const cache = new ItemCache({ expireEveryMs: 60_000 });
    const heard: [string, string[] | null][] = [];
    cache.onDropped((s, ids) => heard.push([`${s.tenantId}/${s.userId}`, ids]));
    cache.put(alice, [item("mail", "1", "Globex renewal call"), item("mail", "2", "Initech invoice")], t0);
    expect(cache.userCount).toBe(1);
    expect(cache.expireIdle(t0 + 23 * H)).toBe(0); // Still within the 24 h time to live.
    expect(cache.userCount).toBe(1);
    expect(cache.expireIdle(t0 + 25 * H)).toBe(1);
    expect(cache.userCount).toBe(0);
    expect(cache.peekVocab(alice)).toBeUndefined();
    expect(cache.revision(alice)).toBe(0);
    expect(heard.at(-1)).toEqual(["t/alice", null]);
  });

  test("a user with a synced item within syncTtlMs is kept, their expired lookups swept; other tenants untouched", () => {
    const cache = new ItemCache({ expireEveryMs: 60_000 });
    cache.put(alice, [item("cal", "s", "Board offsite agenda")], t0, false, true); // Synced (D57).
    cache.put(alice, [item("mail", "l", "Globex renewal call")], t0);
    cache.put(bob, [item("mail", "b", "Hooli quote")], t0);
    cache.put(other, [item("mail", "c", "Acme contract")], t0 + 24 * H); // Another tenant, fresh.
    expect(cache.expireIdle(t0 + 30 * H)).toBe(1); // Bob only.
    expect(cache.userCount).toBe(2);
    expect(cache.fetchedAt(alice, "mail:l")).toBeUndefined(); // The expired lookup is swept...
    expect(cache.get(alice, "cal:s", t0 + 30 * H)?.text).toBe("Board offsite agenda"); // ...the synced item kept.
    expect(cache.revision(bob)).toBe(0);
    expect(cache.get(other, "mail:c", t0 + 30 * H)?.text).toBe("Acme contract");
    // Past syncTtlMs (7 days) the synced item goes, and its user with it; the other tenant's fresh user stays.
    cache.put(other, [item("mail", "c2", "Acme renewal")], t0 + 8 * 24 * H);
    expect(cache.expireIdle(t0 + 8 * 24 * H)).toBe(1);
    expect(cache.revision(alice)).toBe(0);
    expect(cache.revision(other)).toBeGreaterThan(0);
  });

  test("a fresh user ahead of an idle one in write order does not keep the idle one", () => {
    const cache = new ItemCache({ expireEveryMs: 60_000 });
    cache.put(bob, [item("mail", "b", "Hooli quote")], t0 + 20 * H);
    cache.put(alice, [item("mail", "a", "Globex call")], t0); // Written later, on an older clock: still idle.
    expect(cache.expireIdle(t0 + 25 * H)).toBe(1);
    expect(cache.revision(alice)).toBe(0);
    expect(cache.revision(bob)).toBeGreaterThan(0);
  });

  test("a user with only a recent probe memo is kept; once the probe is old too, dropped", () => {
    const cache = new ItemCache({ expireEveryMs: 60_000 });
    cache.put(alice, [], t0);
    cache.rememberProbe(alice, "q", [], 8, t0 + 10 * H);
    expect(cache.expireIdle(t0 + 12 * H)).toBe(0);
    expect(cache.probeHits(alice, "q", 24 * H, t0 + 12 * H)).toEqual([]);
    expect(cache.expireIdle(t0 + 35 * H)).toBe(1);
    expect(cache.userCount).toBe(0);
  });

  test("the timer runs it on the cache's own clock, and close() stops it", async () => {
    const cache = new ItemCache({ expireEveryMs: 20, ttlMs: 50 });
    // An injected clock far from the wall clock: expiry follows it, moved on by the wall time since the last put.
    cache.put(alice, [item("mail", "1", "Globex renewal call")], 1_000);
    expect(cache.userCount).toBe(1);
    await Bun.sleep(150);
    expect(cache.userCount).toBe(0);
    cache.close();
    cache.put(alice, [item("mail", "1", "Globex renewal call")], 1_000);
    await Bun.sleep(150);
    expect(cache.userCount).toBe(1); // Closed: nothing expires on time.
  });

  test("a running timer does not keep a dropped cache alive (nothing closes the caches labs build per task)", async () => {
    // Built in a function so no stack slot here holds the cache; only the WeakRef does.
    const make = (): WeakRef<ItemCache> => {
      const cache = new ItemCache({ expireEveryMs: 60_000 });
      for (let i = 0; i < 50; i++) cache.put(alice, [item("mail", String(i), `Globex renewal call ${i}`)]);
      return new WeakRef(cache);
    };
    const refs = Array.from({ length: 20 }, make);
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(1);
      Bun.gc(true);
    }
    // JSC scans the stack conservatively, so a stale slot can pin the odd one; a tick closing over its cache pins
    // all 20.
    expect(refs.filter((r) => r.deref() !== undefined).length).toBeLessThanOrEqual(2);
  });
});
