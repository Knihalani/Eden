import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import type { Vocab } from "@eden/primitives";
import { ItemCache } from "./cache";
import { offsetOf as startOffset, userOffset } from "./grounding";
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

  test("with releaseTerms the vocabulary follows the live items without a rebuild", () => {
    const cache = new ItemCache({ maxItemsPerUser: 10, releaseTerms: true, expireEveryMs: 0 });
    cache.put(alice, [item("db", "first", "shared")]);
    const vocab = cache.peekVocab(alice)!;
    for (let i = 0; i < 400; i++) {
      const words = Array.from({ length: 200 }, (_, j) => `w${i}x${j}`).join(" ");
      cache.put(alice, [item("db", String(i), `${words} shared`)]);
    }
    expect(cache.peekVocab(alice)).toBe(vocab); // never rebuilt
    // 10 live items of ~203 terms, plus the dead ones awaiting the next compaction (~10% of postings).
    expect(vocab.size).toBeLessThan(4_000);
    const q = termIds("shared", vocab, false);
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

  test("each class expires and is evicted on its own: old synced items hide no expired lookup, nor the reverse", () => {
    const cache = new ItemCache({ maxItemsPerUser: 2, maxSyncedPerUser: 2, expireEveryMs: 0 });
    const dropped: string[] = [];
    cache.onDropped((_, ids) => dropped.push(...(ids ?? ["*"])));
    cache.put(alice, [item("cal", "s1", "Board offsite"), item("cal", "s2", "Budget review")], t0, false, true);
    cache.put(alice, [item("mail", "l1", "Globex call")], t0 + H);
    cache.put(alice, [item("cal", "s3", "Hiring plan")], t0 + 2 * H, false, true); // over the synced cap: s1 goes
    expect(dropped).toEqual(["cal:s1"]);
    cache.put(alice, [item("mail", "l2", "Initech invoice"), item("mail", "l3", "Hooli quote")], t0 + 3 * H);
    expect(dropped).toEqual(["cal:s1", "mail:l1"]); // over the lookup cap: the oldest lookup, behind synced ones
    // A day on, the lookups behind the (still live) synced items expire on the next write; the synced stay.
    cache.put(alice, [item("mail", "l4", "Acme contract")], t0 + 28 * H);
    expect(dropped).toEqual(["cal:s1", "mail:l1", "mail:l2", "mail:l3"]);
    expect(cache.syncedCount(alice)).toBe(2);
    // Past syncTtlMs the synced items go, behind a fresh lookup.
    cache.put(alice, [item("mail", "l5", "Acme renewal")], t0 + 9 * 24 * H);
    expect(dropped.slice(4).sort()).toEqual(["cal:s2", "cal:s3", "mail:l4"]);
    expect(cache.syncedCount(alice)).toBe(0);
    expect(cache.expireIdle(t0 + 9 * 24 * H + H)).toBe(0); // l5 is fresh
  });
});

describe("releaseTerms: a user's vocabulary holds the terms of live items, without a reindex", () => {
  const vocabTerms = (v: Vocab) => Array.from({ length: v.size }, (_, id) => v.term(id));

  test("forget(scope, source) releases the source's terms, reuses no revoked word, and needs no rebuild", () => {
    const cache = new ItemCache({ releaseTerms: true, expireEveryMs: 0 });
    cache.put(alice, [
      item("crm", "1", "Quentavious renewal notes zarnowski"),
      item("crm", "2", "Quentavious escalation"),
      item("mail", "2", "Globex renewal call"),
    ]);
    const vocab = cache.peekVocab(alice)!;
    const revoked = ["quentavious", "zarnowski", "notes", "escalation"];
    const ids = revoked.map((w) => vocab.lookup(w));
    expect(ids.every((id) => id >= 0)).toBe(true);
    cache.forget(alice, "crm");
    expect(cache.peekVocab(alice)).toBe(vocab); // released in place: no rebuild
    for (const w of revoked) expect(vocab.lookup(w)).toBe(-1);
    for (const id of ids) expect(revoked).not.toContain(vocab.term(id));
    expect(vocabTerms(vocab).filter((t) => revoked.includes(t))).toEqual([]);
    // New terms take the released ids; none of them, nor any search, brings a revoked word back.
    cache.put(alice, [item("mail", "3", "Initech offsite hotel booking lisbon")]);
    expect(ids.some((id) => ["offsite", "hotel", "booking", "lisbon", "initech"].includes(vocab.term(id)))).toBe(true);
    expect(vocabTerms(vocab).filter((t) => revoked.includes(t))).toEqual([]);
    for (const w of revoked) {
      const q = termIds(w, vocab, false);
      expect(q.n === 0 ? [] : cache.search(alice, q.ids, q.n, 5)).toEqual([]);
    }
    const q = termIds("renewal", vocab, false);
    expect(cache.search(alice, q.ids, q.n, 5).map((h) => h.item.id)).toEqual(["mail:2"]);
  });

  test("random puts, evictions, expiry and forgets rank and sketch exactly as with releaseTerms off", () => {
    let seed = 5;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return (seed >>> 8) % n;
    };
    const limits = { maxItemsPerUser: 40, maxSyncedPerUser: 30, ttlMs: 400, expireEveryMs: 0 };
    const off = new ItemCache({ ...limits, releaseTerms: false });
    const on = new ItemCache({ ...limits, releaseTerms: true });
    const word = () => (rnd(3) === 0 ? `common${rnd(15)}` : `rare${rnd(4_000)}`);
    const text = (n: number) => Array.from({ length: n }, word).join(" ");
    let now = 1_000;
    for (let step = 0; step < 1_500; step++) {
      now += rnd(4);
      const r = rnd(40);
      if (r === 0) {
        const src = `src${rnd(3)}`;
        off.forget(alice, src);
        on.forget(alice, src);
        continue;
      }
      const synced = r < 10;
      const batch = Array.from({ length: 1 + rnd(4) }, () => ({
        ...item(`src${rnd(3)}`, String(rnd(150)), `${text(4 + rnd(20))} 3pm`),
        title: text(2),
      }));
      off.put(alice, batch, now, false, synced);
      on.put(alice, batch, now, false, synced);
      if (step % 50 !== 0) continue;
      for (const qw of ["common1 common2", "common3", `rare${rnd(4_000)} common4`, "3pm"]) {
        // `termIds` returns shared scratch: search with each before reading the next.
        const a = termIds(qw, off.peekVocab(alice)!, false);
        const hitsA = off.search(alice, a.ids, a.n, 10, now);
        const b = termIds(qw, on.peekVocab(alice)!, false);
        const hitsB = on.search(alice, b.ids, b.n, 10, now);
        expect(hitsB.map((h) => [h.item.id, h.score.toFixed(6), h.sketch])).toEqual(
          hitsA.map((h) => [h.item.id, h.score.toFixed(6), h.sketch]),
        );
      }
    }
    // Terms seen across the run far outnumber what live items hold; with release on, the vocabulary tracks the latter.
    const vocab = on.peekVocab(alice)!;
    expect(vocab.live).toBeLessThan(off.peekVocab(alice)!.size);
  });
});

describe("offsetOf: a tally kept as items come and go", () => {
  test("after 1,000 random puts and drops it equals userOffset over the items in order", () => {
    let seed = 9;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return (seed >>> 8) % n;
    };
    const cache = new ItemCache({ maxItemsPerUser: 25, maxSyncedPerUser: 15, expireEveryMs: 0 });
    const zones = ["Z", "+01:00", "-05:00", "+0530", "", "+00:00", "-07:00"];
    const users = (cache as unknown as { users: Map<string, { items: Map<string, { item: ContextItem }> }> }).users;
    const recompute = () => {
      const starts: string[] = [];
      for (const e of users.get("t/alice")?.items.values() ?? [])
        if (e.item.meta?.start) starts.push(e.item.meta.start);
      return userOffset(starts);
    };
    let ties = 0;
    for (let step = 0; step < 1_000; step++) {
      const id = String(rnd(60));
      if (rnd(5) === 0) {
        cache.dropSynced(alice, [`cal:${id}`]);
      } else {
        // Few offsets and few items: ties between non-zero offsets come up often.
        const z = zones[rnd(zones.length)]!;
        const meta = rnd(4) === 0 ? undefined : { start: z === "" ? "2026-11-03" : `2026-11-03T09:00:00${z}` };
        const words = rnd(3) === 0 ? "same words" : `event ${step}`; // the same words: a refresh, moved to the end
        cache.put(alice, [{ ...item("cal", id, words), meta }], 1_000 + step, false, rnd(2) === 0);
      }
      const want = recompute();
      expect(cache.offsetOf(alice)).toBe(want);
      const counts = new Map<number, number>();
      for (const e of users.get("t/alice")?.items.values() ?? []) {
        const o = e.item.meta?.start ? startOffset(e.item.meta.start) : null;
        if (o !== null && o !== 0) counts.set(o, (counts.get(o) ?? 0) + 1);
      }
      const top = Math.max(0, ...counts.values());
      if ([...counts.values()].filter((c) => c === top).length > 1) ties++;
    }
    expect(ties).toBeGreaterThan(20); // the tie-break path ran
  });

  test("a refresh that moves an event's zone but keeps its words moves the offset (corr-cache-offset-stale-on-refresh)", () => {
    const cache = new ItemCache({ expireEveryMs: 0 });
    const at = (z: string) => ({ ...item("cal", "1", "standup"), meta: { start: `2026-11-03T09:00:00${z}` } });
    cache.put(alice, [at("+01:00")]);
    expect(cache.offsetOf(alice)).toBe(60); // read once, so a stale memo would show below
    cache.put(alice, [at("-05:00")]); // same title and text: the unchanged-words path
    expect(cache.offsetOf(alice)).toBe(-300);
    cache.put(alice, [{ ...at(""), meta: undefined }]);
    expect(cache.offsetOf(alice)).toBe(0);
  });

  test("per user: one user's events never shape another's offset", () => {
    const cache = new ItemCache({ expireEveryMs: 0 });
    const bob = { tenantId: "t", userId: "bob" };
    cache.put(alice, [{ ...item("cal", "1", "standup"), meta: { start: "2026-11-03T09:00:00+01:00" } }]);
    cache.put(bob, [{ ...item("cal", "1", "standup"), meta: { start: "2026-11-03T09:00:00-05:00" } }]);
    expect([cache.offsetOf(alice), cache.offsetOf(bob)]).toEqual([60, -300]);
    cache.dropSynced(bob, ["cal:1"]); // not synced: kept
    cache.forget(bob);
    expect([cache.offsetOf(alice), cache.offsetOf(bob)]).toEqual([60, 0]);
  });
});

describe("ItemCache index isolation (packed index, shared scratch)", () => {
  test("users interleaved past freezes and purges rank as each would alone", () => {
    const bob = { tenantId: "t", userId: "bob" };
    const other = { tenantId: "u", userId: "alice" }; // same user id, another tenant
    const words = (u: number, i: number) =>
      Array.from({ length: 30 }, (_, j) => `w${(i * 7 + j * 13 + u) % 90}`).join(" ") + ` renewal u${u}`;
    const together = new ItemCache({ maxItemsPerUser: 150, expireEveryMs: 0 });
    const alone = [alice, bob, other].map(() => new ItemCache({ maxItemsPerUser: 150, expireEveryMs: 0 }));
    const now = 1_700_000_000_000;
    // 400 items each through a cap of 150: several freezes (every 128 adds) and purges (evictions), interleaved.
    for (let i = 0; i < 400; i++) {
      [alice, bob, other].forEach((scope, u) => {
        const it = item("mail", `${u}-${i}`, words(u, i));
        together.put(scope, [it], now + i);
        alone[u]!.put(scope, [it], now + i);
      });
      if (i % 37 !== 0) continue;
      [alice, bob, other].forEach((scope, u) => {
        const q = (c: ItemCache) => termIds(`w3 w44 renewal u${u} w81`, c.peekVocab(scope)!, false);
        const a = q(together);
        const b = q(alone[u]!);
        const got = together.search(scope, a.ids, a.n, 20, now + i);
        const want = alone[u]!.search(scope, b.ids, b.n, 20, now + i);
        expect(got.map((h) => [h.item.id, h.score, h.coverage])).toEqual(
          want.map((h) => [h.item.id, h.score, h.coverage]),
        );
        expect(got.every((h) => h.item.id.startsWith(`mail:${u}-`))).toBe(true);
      });
    }
  });
});

describe("ItemCache expiry tick and the index's merges (D120)", () => {
  test("the tick leaves no merge under way, even one its own sweep starts", () => {
    const cache = new ItemCache({ expireEveryMs: 0, maxItemsPerUser: 5_000 });
    const scope = { tenantId: "t", userId: "merge" };
    const t0 = 1_700_000_000_000;
    const ttl = 24 * 3_600_000;
    const words = (i: number) => Array.from({ length: 25 }, (_, j) => `w${(i * 31 + j * 17) % 4_000}`).join(" ");
    // 800 then 600 (a combination found to leave a merge under way after the sweep, with the settle before it only).
    for (let i = 0; i < 800; i++) cache.put(scope, [item("mail", `old-${i}`, words(i))], t0);
    for (let i = 0; i < 600; i += 50) {
      const batch = Array.from({ length: 50 }, (_, k) => item("mail", `new-${i + k}`, words(10_000 + i + k)));
      cache.put(scope, batch, t0 + ttl / 2);
    }
    const index = () =>
      (cache as unknown as { users: Map<string, { index: { merge: unknown } }> }).users.values().next().value!.index;
    cache.expireIdle(t0 + ttl + 1); // sweeps the 800 old items: purges, and the last starts a merge
    expect(index().merge).toBeNull();
  });
});
