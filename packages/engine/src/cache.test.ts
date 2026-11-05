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

describe("ItemCache gone-holds (removeItems with a hold) never allocate or evict a user", () => {
  const MIN = 60_000;
  const T = Date.UTC(2026, 10, 5, 9);

  test("holds for users the cache has never seen leave real users' caches in place", () => {
    const cache = new ItemCache({ maxUsersPerTenant: 3 });
    const real = { tenantId: "t", userId: "real" };
    cache.put(real, [item("notes", "1", "The offsite is in Lisbon")], T);
    for (let i = 0; i < 3; i++) {
      expect(cache.removeItems({ tenantId: "t", userId: `ghost${i}` }, ["notes:1"], T, 10 * MIN)).toBe(0);
    }
    expect(cache.userCount).toBe(1);
    expect(cache.get(real, "notes:1", T)).toBeTruthy();
    expect(cache.isHeldGone({ tenantId: "t", userId: "ghost2" }, "notes:1", T)).toBe(true);
    expect(cache.isHeldGone(real, "notes:1", T)).toBe(false);
  });

  test("10,000 removals for unseen users keep the user count flat and cost a small hold each", () => {
    const cache = new ItemCache({ expireEveryMs: 0 });
    cache.put(alice, [item("notes", "1", "Alice's own note")], T);
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 10_000; i++) {
      cache.removeItems({ tenantId: "t", userId: `ghost${i}` }, [`mail:m${i}`], T, 10 * MIN);
    }
    Bun.gc(true);
    const perRemoval = (process.memoryUsage().heapUsed - before) / 10_000;
    console.log(`gone-holds: ${perRemoval.toFixed(0)} B heap per removal for an unseen user (was ~27.8 KB per user)`);
    expect(cache.userCount).toBe(1);
    expect(cache.holdCount("t")).toBe(10_000);
    expect(perRemoval).toBeLessThan(1_000);
    expect(cache.get(alice, "notes:1", T)).toBeTruthy();
  });

  test("a removal for a user with a lookup in flight still blocks the deleted item when the lookup stores it", () => {
    const cache = new ItemCache();
    const bob = { tenantId: "t", userId: "bob" };
    const q1 = item("notes", "q1", "The offsite is in Lisbon");
    // The lookup read q1 before the deletion; the deletion lands before the lookup stores anything for bob.
    cache.removeItems(bob, [q1.id], T, 10 * MIN);
    expect(cache.userCount).toBe(0);
    expect(cache.put(bob, [q1], T + 1_000)).toHaveLength(0);
    expect(cache.get(bob, q1.id, T + 1_000)).toBeNull();
    // Per user and per tenant: the same id for another user, or the same user name in another tenant, is stored.
    cache.put({ tenantId: "t", userId: "carol" }, [q1], T + 1_000);
    cache.put({ tenantId: "u", userId: "bob" }, [q1], T + 1_000);
    expect(cache.get({ tenantId: "t", userId: "carol" }, q1.id, T + 1_000)).toBeTruthy();
    expect(cache.get({ tenantId: "u", userId: "bob" }, q1.id, T + 1_000)).toBeTruthy();
    // A user id that ends where another's item id begins is a different key (the user is length-prefixed).
    cache.removeItems({ tenantId: "t", userId: "b" }, ["obnotes:q1"], T, 10 * MIN);
    expect(cache.isHeldGone({ tenantId: "t", userId: "bo" }, "bnotes:q1", T)).toBe(false);
    expect(cache.isHeldGone({ tenantId: "t", userId: "b" }, "obnotes:q1", T)).toBe(true);
    // Revived, or once the hold ends, a copy is stored again.
    cache.revive(bob, [q1.id]);
    expect(cache.put(bob, [q1], T + 2_000)).toHaveLength(1);
    cache.removeItems(bob, [q1.id], T + 3_000, 10 * MIN);
    expect(cache.get(bob, q1.id, T + 3_000)).toBeNull();
    expect(cache.put(bob, [q1], T + 3_000 + 10 * MIN)).toHaveLength(1);
  });

  test("one user's bulk deletion keeps 1,000 of their holds and leaves another user's hold in force", () => {
    const cache = new ItemCache({ expireEveryMs: 0 });
    const bob = { tenantId: "t", userId: "bob" };
    cache.removeItems(bob, ["mail:x"], T, 10 * MIN); // Bob's hold comes first, so it is the tenant's oldest.
    const ids = Array.from({ length: 25_000 }, (_, i) => `mail:m${i}`);
    cache.removeItems(alice, ids, T, 10 * MIN);
    expect(cache.holdCount("t")).toBe(1_001);
    expect(cache.isHeldGone(bob, "mail:x", T)).toBe(true);
    expect(cache.put(bob, [item("mail", "x", "A deleted message")], T + MIN)).toHaveLength(0);
    expect(cache.isHeldGone(alice, "mail:m0", T)).toBe(false); // Alice's oldest went first.
    expect(cache.isHeldGone(alice, "mail:m23999", T)).toBe(false);
    expect(cache.isHeldGone(alice, "mail:m24000", T)).toBe(true);
    expect(cache.isHeldGone(alice, "mail:m24999", T)).toBe(true);
    cache.forget(alice);
    expect(cache.holdCount("t")).toBe(1);
    expect(cache.isHeldGone(bob, "mail:x", T)).toBe(true);
    cache.expireIdle(T + 10 * MIN);
    expect(cache.holdCount("t")).toBe(0);
  });

  test("holds are bounded per tenant: past 100,000, the least recently held user's oldest go, each counted", () => {
    const cache = new ItemCache({ expireEveryMs: 0 });
    for (let u = 0; u < 105; u++) {
      const ids = Array.from({ length: 1_000 }, (_, i) => `mail:u${u}m${i}`);
      cache.removeItems({ tenantId: "t", userId: `user${u}` }, ids, T + u, 10 * MIN);
    }
    expect(cache.holdCount("t")).toBe(100_000);
    expect(cache.holdsEvicted("t")).toBe(5_000); // All live: nothing had expired to go first.
    expect(cache.holdsEvicted()).toBe(5_000);
    expect(cache.isHeldGone({ tenantId: "t", userId: "user0" }, "mail:u0m999", T)).toBe(false);
    expect(cache.isHeldGone({ tenantId: "t", userId: "user4" }, "mail:u4m999", T)).toBe(false);
    expect(cache.isHeldGone({ tenantId: "t", userId: "user5" }, "mail:u5m0", T)).toBe(true);
    expect(cache.isHeldGone({ tenantId: "t", userId: "user104" }, "mail:u104m999", T)).toBe(true);
    // Another tenant's holds are its own.
    cache.removeItems({ tenantId: "u", userId: "user0" }, ["mail:u0m0"], T, 10 * MIN);
    expect(cache.holdCount("u")).toBe(1);
    expect(cache.holdCount("t")).toBe(100_000);
    // A hold re-set by a user moves to the back: its user is now the most recently held.
    cache.removeItems({ tenantId: "t", userId: "user5" }, ["mail:u5m0"], T + 200, 10 * MIN);
    cache.removeItems({ tenantId: "t", userId: "late" }, ["mail:late"], T + 200, 10 * MIN);
    expect(cache.isHeldGone({ tenantId: "t", userId: "user5" }, "mail:u5m0", T)).toBe(true);
    expect(cache.isHeldGone({ tenantId: "t", userId: "user6" }, "mail:u6m0", T)).toBe(false);
    expect(cache.holdsEvicted("t")).toBe(5_001);
    // The count outlives the holds: a tenant whose holds all expired still reports what it lost.
    cache.expireIdle(T + 11 * MIN);
    expect(cache.holdCount("t")).toBe(0);
    expect(cache.holdsEvicted("t")).toBe(5_001);
    expect(cache.holdCount("u")).toBe(0);
    expect(cache.holdsEvicted("u")).toBe(0);
  });

  test("10,000 users x 5 removals spread over 10 minutes are all held at the end, none evicted, ≤600 B a hold", () => {
    const cache = new ItemCache({ expireEveryMs: 0 });
    const users = 10_000;
    const each = 5;
    const total = users * each; // ~83 deletions a second for one tenant: 2.5x the old 20,000 cap's break-even.
    const ids = Array.from({ length: total }, (_, k) => `mail:u${k % users}m${Math.floor(k / users)}`);
    const scopes = Array.from({ length: users }, (_, i) => ({ tenantId: "t", userId: `user${i}` }));
    const at = (k: number) => T + Math.floor((k * (10 * MIN - 1)) / total);
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    for (let k = 0; k < total; k++) cache.removeItems(scopes[k % users]!, [ids[k]!], at(k), 10 * MIN);
    Bun.gc(true);
    const perHold = (process.memoryUsage().heapUsed - before) / total;
    console.log(`gone-holds: ${perHold.toFixed(0)} B heap per hold, ${total} holds across ${users} users`);
    const end = T + 10 * MIN - 1; // Every removal's hold (the first's included) ends after this.
    expect(cache.holdCount("t")).toBe(total);
    expect(cache.holdsEvicted("t")).toBe(0);
    let held = 0;
    for (let k = 0; k < total; k++) if (cache.isHeldGone(scopes[k % users]!, ids[k]!, end)) held++;
    expect(held).toBe(total);
    expect(perHold).toBeLessThanOrEqual(600);
  });

  test("over the tenant cap, expired holds go tenant-wide before any live one", () => {
    const cache = new ItemCache({ expireEveryMs: 0 });
    // 100 users fill the cap with short holds that end at T + 1 minute.
    for (let u = 0; u < 100; u++) {
      const ids = Array.from({ length: 1_000 }, (_, i) => `mail:u${u}m${i}`);
      cache.removeItems({ tenantId: "t", userId: `old${u}` }, ids, T, MIN);
    }
    expect(cache.holdCount("t")).toBe(100_000);
    // Later, other users' removals push the tenant over: the expired go, no live hold is lost.
    const fresh = Array.from({ length: 5_000 }, (_, i) => `mail:f${i}`);
    for (let i = 0; i < 5; i++) {
      cache.removeItems(
        { tenantId: "t", userId: `new${i}` },
        fresh.slice(i * 1_000, (i + 1) * 1_000),
        T + 2 * MIN,
        MIN,
      );
    }
    expect(cache.holdsEvicted("t")).toBe(0);
    expect(cache.holdsEvicted()).toBe(0);
    expect(cache.holdCount("t")).toBe(5_000);
    for (let i = 0; i < 5; i++) {
      expect(cache.isHeldGone({ tenantId: "t", userId: `new${i}` }, `mail:f${i * 1_000}`, T + 2 * MIN)).toBe(true);
    }
  });

  test("one tenant's evictions touch neither another tenant's holds nor its count", () => {
    const cache = new ItemCache({ expireEveryMs: 0 });
    const other = { tenantId: "b", userId: "user0" };
    cache.removeItems(other, ["mail:u0m0", "mail:u0m1"], T, 10 * MIN);
    for (let u = 0; u < 102; u++) {
      const ids = Array.from({ length: 1_000 }, (_, i) => `mail:u${u}m${i}`);
      cache.removeItems({ tenantId: "a", userId: `user${u}` }, ids, T + 1, 10 * MIN);
    }
    // Per user too: one user's bulk deletion past 1,000 is counted, in its own tenant only.
    const bulk = Array.from({ length: 1_500 }, (_, i) => `mail:bulk${i}`);
    cache.removeItems({ tenantId: "a", userId: "bulk" }, bulk, T + 2, 10 * MIN);
    expect(cache.holdCount("a")).toBe(100_000);
    expect(cache.holdsEvicted("a")).toBe(2_000 + 500 + 1_000);
    expect(cache.holdCount("b")).toBe(2);
    expect(cache.holdsEvicted("b")).toBe(0);
    expect(cache.isHeldGone(other, "mail:u0m0", T + 3)).toBe(true);
    expect(cache.isHeldGone(other, "mail:u0m1", T + 3)).toBe(true);
    expect(cache.holdsEvicted()).toBe(3_500);
    // Forgetting a user of one tenant leaves the other's holds and both counts.
    cache.forget({ tenantId: "a", userId: "bulk" });
    expect(cache.holdsEvicted("a")).toBe(3_500);
    expect(cache.holdCount("b")).toBe(2);
  });
});

describe("ItemCache sketches are computed when an item is first returned, not when it is stored", () => {
  test("search, searchIn, timed and hits give the same sketch, made once and kept; unreturned items have none", () => {
    const cache = new ItemCache();
    const items = Array.from({ length: 50 }, (_, i) => ({
      ...item(i % 2 ? "mail" : "notes", String(i), `Budget review number ${i} with the finance team`),
      meta: { start: "2026-11-06T10:00:00Z" },
    }));
    const now = Date.UTC(2026, 10, 5, 9);
    cache.put(alice, items, now);
    type Users = Map<string, { items: Map<string, { sketch: unknown }> }>;
    const entries = () => (cache as unknown as { users: Users }).users.get("t/alice")!.items;
    expect([...entries().values()].every((e) => e.sketch === undefined)).toBe(true);
    const q = termIds("budget review finance", cache.peekVocab(alice)!, false);
    const inMail = cache.searchIn(alice, q.ids, q.n, 2, new Set(["mail"]), false, now);
    expect(inMail).toHaveLength(2);
    // Only the two returned were sketched, though every mail item matched.
    expect([...entries().values()].filter((e) => e.sketch !== undefined)).toHaveLength(2);
    const byId = new Map(cache.search(alice, q.ids, q.n, 50, now).map((h) => [h.item.id, h.sketch]));
    for (const h of inMail) {
      expect(h.sketch).not.toBeNull();
      expect(byId.get(h.item.id)).toBe(h.sketch!); // Memoised: the same object.
    }
    const day = cache.timed(alice, new Set(["2026-11-06"]), now, 3);
    expect(day).toHaveLength(3);
    for (const h of day) expect(cache.hits(alice, [h.item.id], now)[0]!.sketch).toBe(h.sketch);
    // Each equals the sketch a fresh cache makes on its first read, in another order.
    const fresh = new ItemCache();
    fresh.put(alice, [...items].reverse(), now);
    for (const h of fresh.hits(
      alice,
      items.map((i) => i.id),
      now,
    )) {
      expect(h.sketch).toEqual(cache.hits(alice, [h.item.id], now)[0]!.sketch);
    }
  });
});
