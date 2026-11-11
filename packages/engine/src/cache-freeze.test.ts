/**
 * Idle users frozen (D325): a frozen user thaws into the state they were frozen in, so every read answers exactly as
 * it would have with no freeze; and the frozen blob is per user (D9).
 */
import { describe, expect, test } from "bun:test";
import type { ContextItem, Scope } from "@eden/protocol";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { buildWorkload } from "../bench/workload";
import type { ListPage, Source } from "@eden/sources";
import { ItemCache, type CacheHit } from "./cache";
import { isPacked } from "./packed-text";
import { ContextPartner } from "./partner";
import { termIds } from "./text";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 9);
const alice: Scope = { tenantId: "t", userId: "alice" };
const bob: Scope = { tenantId: "t", userId: "bob" };
const carol: Scope = { tenantId: "u", userId: "alice" }; // Same user id, another tenant.

/** A cache whose ticks the test runs itself (`expireIdle`): its own timer never starts. */
function manual(limits: ConstructorParameters<typeof ItemCache>[0]): ItemCache {
  const cache = new ItemCache(limits);
  cache.close();
  return cache;
}

/** A small deterministic generator, so the churn is the same for both caches and every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

const WORDS = [
  "renewal",
  "budget",
  "dinner",
  "flight",
  "contract",
  "allergy",
  "peanut",
  "offsite",
  "invoice",
  "deadline",
  "café",
  "Zürich",
  "→",
  "Globex",
  "board",
  "review",
];
const PEOPLE = ["Ana Lima", "Bo Chen", "Zoë Müller", "Dev Patel", "Eli Stone"];

function makeItem(r: () => number, n: number, user: string): ContextItem {
  const pick = () => WORDS[Math.floor(r() * WORDS.length)]!;
  const who = PEOPLE[Math.floor(r() * PEOPLE.length)]!;
  // Long items are held deflated (packText), short ones plain; some with characters past Latin-1.
  const len = r() < 0.5 ? 6 : 120;
  // A fifth share one body word for word, so a query on it scores them equal: the order ties reach the top-k in
  // is then what decides which are returned.
  const body = r() < 0.2 ? "dinner peanut allergy" : Array.from({ length: len }, pick).join(" ");
  const src = ["mail", "calendar", "docs"][n % 3]!;
  const it: ContextItem = {
    id: `${src}:${user}-${n}`,
    sourceId: src,
    ref: `${user}-${n}`,
    title: `${pick()} ${pick()} ${n}`,
    text: body === "dinner peanut allergy" ? body : `From: ${who}\nTo: ${PEOPLE[0]}\n${body} (${user})`,
    updatedAt: T0 - n * MIN,
  };
  if (src === "calendar") {
    it.meta = { start: `2026-11-0${1 + (n % 7)}T1${n % 10}:00:00${n % 2 ? "+01:00" : "-05:00"}`, people: who };
  }
  if (n % 5 === 0) it.url = `https://example.com/${n}`;
  return it;
}

/** Everything a caller can read of one user, with query ids taken from the cache's vocabulary each time. */
function snapshot(cache: ItemCache, scope: Scope, now: number) {
  const hit = (h: CacheHit) => ({
    id: h.item.id,
    item: { ...h.item },
    sketch: h.sketch,
    score: h.score,
    coverage: h.coverage,
    matched: h.matched,
  });
  const queries = ["renewal budget", "dinner peanut allergy", "Globex board review", "café Zürich", "flight", "zz"];
  const out: unknown[] = [cache.revision(scope), cache.syncedCount(scope)];
  for (const q of queries) {
    const vocab = cache.peekVocab(scope);
    if (!vocab) {
      out.push(null);
      continue;
    }
    const { ids, n } = termIds(q, vocab, false);
    const copy = Array.from(ids.subarray(0, n));
    out.push(cache.search(scope, copy, n, 12, now).map(hit));
    out.push(cache.searchIn(scope, copy, n, 3, new Set(["mail", "docs"]), false, now).map(hit));
    out.push(cache.searchIn(scope, copy, n, 3, new Set(["calendar"]), true, now).map(hit));
    out.push(cache.isRare(scope, q.split(" ")[0]!, 0.1));
  }
  out.push(cache.timed(scope, new Set(["2026-11-03", "2026-11-05"]), now).map(hit));
  out.push(cache.selfOf(scope), cache.offsetOf(scope));
  for (const p of PEOPLE) out.push(cache.partyCount(scope, p), cache.isPerson(scope, p.split(" ")[0]!));
  out.push(cache.probeHits(scope, "probe", 30 * MIN, now)?.map(hit) ?? null);
  return out;
}

describe("idle users frozen (D325)", () => {
  for (const warm of [false, true]) {
    test(`a frozen user thaws to exactly the same answers, through churn, expiry and eviction${warm ? " (frozen warm, D862)" : ""}`, () => {
      churn(warm);
    });
  }

  test("a warm user is frozen again compact once idle `freezeIdleMs`, and answers the same throughout (D862)", () => {
    const limits = { maxItemsPerUser: 60, maxSyncedPerUser: 90, ttlMs: 50 * MIN, syncTtlMs: 400 * MIN };
    const a = new ItemCache({ ...limits, freezeIdleMs: 0, expireEveryMs: 0 });
    // Warm after two idle ticks, compact after five.
    const b = manual({ ...limits, freezeIdleMs: 5, warmIdleMs: 1, expireEveryMs: 1 });
    const r = rng(11);
    const batch = Array.from({ length: 40 }, (_, n) => makeItem(r, n, "alice"));
    for (const c of [a, b]) c.put(alice, batch, T0, false, true, 1);
    b.expireIdle(T0);
    expect(b.frozenCount).toBe(0);
    b.expireIdle(T0);
    expect(b.frozenCount).toBe(1);
    const warmBytes = b.frozenBytes;
    b.expireIdle(T0);
    b.expireIdle(T0);
    expect(b.frozenBytes).toBe(warmBytes); // still warm
    b.expireIdle(T0);
    expect(b.frozenCount).toBe(1);
    expect(b.frozenBytes).toBeLessThan(warmBytes); // compact now
    expect(b.freezes.frozen).toBe(2);
    expect(snapshot(b, alice, T0)).toEqual(snapshot(a, alice, T0));
    // A read thaws her; idle again, she is frozen warm first, compact later.
    for (let t = 0; t < 2; t++) b.expireIdle(T0);
    expect(b.frozenBytes).toBeGreaterThan(warmBytes * 0.9);
    // And writes after a warm thaw answer as the twin's.
    const more = Array.from({ length: 30 }, (_, n) => makeItem(r, 100 + n, "alice"));
    for (const c of [a, b]) c.put(alice, more, T0 + MIN, false, true, 2);
    for (const c of [a, b]) c.removeItems(alice, [batch[3]!.id, batch[9]!.id], T0 + MIN, 5 * MIN);
    expect(snapshot(b, alice, T0 + MIN)).toEqual(snapshot(a, alice, T0 + MIN));
  });

  test("no warm freeze for users that never freeze, nor without `releaseTerms` (D862)", () => {
    for (const limits of [
      { freezeIdleMs: 0, warmIdleMs: 1, expireEveryMs: 1 },
      { freezeIdleMs: 1_000, warmIdleMs: 1, expireEveryMs: 1, releaseTerms: false },
    ]) {
      const b = manual(limits);
      b.put(
        alice,
        Array.from({ length: 10 }, (_, n) => makeItem(rng(n), n, "alice")),
        T0,
      );
      for (let t = 0; t < 4; t++) b.expireIdle(T0);
      expect(b.frozenCount).toBe(0);
    }
  });

  test("a warm thaw keeps probes, read marks and the rebuild baseline (D862)", () => {
    const limits = { maxItemsPerUser: 60, maxSyncedPerUser: 90 };
    const a = manual({ ...limits, freezeIdleMs: 0, expireEveryMs: 1 });
    const b = manual({ ...limits, freezeIdleMs: 1_000, warmIdleMs: 1, expireEveryMs: 1 });
    const r = rng(23);
    const batch = Array.from({ length: 40 }, (_, n) => makeItem(r, n, "alice"));
    for (const c of [a, b]) {
      c.put(alice, batch.slice(0, 20), T0, false, true, 3);
      c.put(alice, batch.slice(20), T0, false, true, 7);
      c.rememberProbe(alice, "probe", [batch[1]!.id, batch[30]!.id], 8, T0);
    }
    const inner = (c: ItemCache) =>
      (c as unknown as { users: Map<string, { baseline: number }> }).users.get("t/alice")!;
    // Set by a rebuild (rare with `releaseTerms`); set here so carrying it is seen.
    const baseline = (inner(b).baseline = 1_234);
    for (let t = 0; t < 3; t++) b.expireIdle(T0);
    expect(b.warmCount).toBe(1);
    expect(b.probeHits(alice, "probe", 30 * MIN, T0)?.map((h) => h.item.id)).toEqual(
      a.probeHits(alice, "probe", 30 * MIN, T0)?.map((h) => h.item.id),
    );
    for (const it of batch) expect(b.readMark(alice, it.id)).toBe(a.readMark(alice, it.id));
    expect(b.readMark(alice, batch[0]!.id)).toBe(3);
    expect(b.readMark(alice, batch[30]!.id)).toBe(7);
    expect(inner(b).baseline).toBe(baseline);
  });

  test("sliced: a warm user goes compact through the timer's sliced jobs (D862)", async () => {
    const b = manual({ freezeIdleMs: 4, warmIdleMs: 1, expireEveryMs: 1 });
    const r = rng(3);
    b.put(
      alice,
      Array.from({ length: 40 }, (_, n) => makeItem(r, n, "alice")),
      T0,
      false,
      true,
      1,
    );
    for (let t = 0; t < 2; t++) b.expireIdle(T0, true);
    while (b.slicedPending > 0) await Bun.sleep(1);
    expect(b.frozenCount).toBe(1);
    const warmBytes = b.frozenBytes;
    for (let t = 0; t < 2; t++) b.expireIdle(T0, true);
    while (b.slicedPending > 0) await Bun.sleep(1);
    expect(b.frozenCount).toBe(1);
    expect(b.frozenBytes).toBeLessThan(warmBytes);
  });

  test("an idle user's index is compacted at the tick, and answers as before (D861)", () => {
    const limits = { maxItemsPerUser: 400, maxSyncedPerUser: 400, freezeIdleMs: 0, expireEveryMs: 1 };
    const a = manual({ ...limits, idleCompact: false });
    const b = manual({ ...limits, idleCompact: true });
    const r = rng(17);
    // Enough items for a heavy index (a chained delta), some removed: a purge, a merge and the delta's spare room.
    const items = Array.from({ length: 300 }, (_, n) => makeItem(r, n, "alice"));
    for (let p = 0; p < 300; p += 20) for (const c of [a, b]) c.put(alice, items.slice(p, p + 20), T0, false, true, 1);
    const gone = items.filter((_, n) => n % 7 === 0).map((x) => x.id);
    for (const c of [a, b]) c.removeItems(alice, gone, T0, 5 * MIN);
    // A removal's purge may merge the delta away: these land behind it.
    const late = Array.from({ length: 30 }, (_, n) => makeItem(r, 300 + n, "alice"));
    for (const c of [a, b]) c.put(alice, late, T0, false, true, 1);
    const delta = (c: ItemCache) =>
      (c as unknown as { users: Map<string, { index: { deltaN: number } }> }).users.get("t/alice")!.index.deltaN;
    expect(delta(b)).toBeGreaterThan(0);
    // Used before the first tick: not idle through a whole interval yet; at the second, compacted.
    b.expireIdle(T0);
    expect(delta(b)).toBeGreaterThan(0);
    b.expireIdle(T0);
    expect(delta(b)).toBe(0);
    // Written again: its new docs wait in the delta while the user is used in every tick.
    const again = Array.from({ length: 40 }, (_, n) => makeItem(r, 400 + n, "alice"));
    for (const c of [a, b]) c.put(alice, again.slice(0, 20), T0, false, true, 1);
    b.expireIdle(T0);
    for (const c of [a, b]) c.put(alice, again.slice(20), T0, false, true, 1);
    expect(delta(b)).toBe(40);
    b.expireIdle(T0); // used since the last tick: left as it is
    expect(delta(b)).toBe(40);
    b.expireIdle(T0); // idle through a whole interval: compacted
    expect(delta(b)).toBe(0);
    // A small delta is left: below the floor the merge costs more than it frees.
    const one = makeItem(r, 600, "alice");
    for (const c of [a, b]) c.put(alice, [one], T0, false, true, 1);
    for (let t = 0; t < 3; t++) b.expireIdle(T0);
    expect(delta(b)).toBe(1);
    expect(snapshot(b, alice, T0)).toEqual(snapshot(a, alice, T0));
    // Writes after it answer as the twin's.
    const more = Array.from({ length: 40 }, (_, n) => makeItem(r, 500 + n, "alice"));
    for (const c of [a, b]) c.put(alice, more, T0 + MIN, false, true, 2);
    expect(snapshot(b, alice, T0 + MIN)).toEqual(snapshot(a, alice, T0 + MIN));
  });

  test("on the timer, idle compaction runs through the sliced jobs, for idle users only (D861)", async () => {
    const b = manual({ maxItemsPerUser: 400, maxSyncedPerUser: 400, freezeIdleMs: 0, expireEveryMs: 1 });
    const r = rng(19);
    for (const s of [alice, bob])
      b.put(
        s,
        Array.from({ length: 100 }, (_, n) => makeItem(r, n, s.userId)),
        T0,
      );
    const delta = (s: Scope) =>
      (b as unknown as { users: Map<string, { index: { deltaN: number } }> }).users.get(`t/${s.userId}`)!.index.deltaN;
    expect(delta(alice)).toBeGreaterThan(32);
    b.expireIdle(T0, true);
    while (b.slicedPending > 0) await Bun.sleep(1);
    expect(delta(alice)).toBeGreaterThan(32); // not idle through an interval yet
    b.peekVocab(bob); // bob is used in this interval
    b.expireIdle(T0, true);
    while (b.slicedPending > 0) await Bun.sleep(1);
    expect(delta(alice)).toBe(0);
    expect(delta(bob)).toBeGreaterThan(32);
  });

  test("a warm blob keeps item text as its deflated bytes, and the thawed items are packed (D860)", () => {
    const b = manual({ freezeIdleMs: 1_000, warmIdleMs: 1, expireEveryMs: 1 });
    const r = rng(5);
    const batch = Array.from({ length: 40 }, (_, n) => makeItem(r, n, "alice"));
    b.put(alice, batch, T0, false, true, 1);
    for (let t = 0; t < 3; t++) b.expireIdle(T0);
    expect(b.frozenCount).toBe(1);
    const vocab = b.peekVocab(alice)!;
    const { ids, n } = termIds("renewal budget", vocab, false);
    const hits = b.search(alice, Array.from(ids.subarray(0, n)), n, 40, T0);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      const want = batch.find((x) => x.id === h.item.id)!;
      expect(h.item.text).toBe(want.text);
      expect(isPacked(h.item)).toBe(want.text.length >= 256);
    }
  });
});

function churn(warm: boolean): void {
  {
    // `a` never freezes; `b` freezes every user idle for two ticks. Both get the same writes at the same times.
    const limits = { maxItemsPerUser: 60, maxSyncedPerUser: 90, ttlMs: 50 * MIN, syncTtlMs: 400 * MIN };
    const a = new ItemCache({ ...limits, freezeIdleMs: 0, expireEveryMs: 0 });
    // Warm: every freeze is warm (compact only after 1,000 idle ticks, never reached here).
    const b = manual({
      ...limits,
      expireEveryMs: 1,
      ...(warm ? { freezeIdleMs: 1_000, warmIdleMs: 1 } : { freezeIdleMs: 1 }),
    });
    const r = rng(7);
    let now = T0;
    let n = 0;
    let frozenSeen = 0;
    const made: ContextItem[] = [];
    for (let step = 0; step < 60; step++) {
      now += 7 * MIN;
      const r2 = r();
      // New items, changed copies of recent ones, and unchanged copies of older ones (a refresh: it moves in the
      // eviction order but keeps its place in the index, so the two orders part).
      const batch = Array.from({ length: 1 + Math.floor(r() * 6) }, (): ContextItem => {
        const x = r();
        if (x < 0.15 && n > 4) return makeItem(rng(n - 3), n - 3, "alice");
        if (x < 0.45 && made.length > 0) return { ...made[Math.floor(r() * made.length)]!, updatedAt: now };
        const it = makeItem(r, n++, "alice");
        made.push(it);
        return it;
      });
      if (r2 < 0.55) {
        const synced = r() < 0.6;
        for (const c of [a, b]) c.put(alice, batch, now, false, synced, step);
      } else if (r2 < 0.65) {
        const ids = [`mail:alice-${Math.floor(r() * n)}`, `docs:alice-${Math.floor(r() * n)}`];
        for (const c of [a, b]) c.removeItems(alice, ids, now, 5 * MIN);
      } else if (r2 < 0.72) {
        const ids = [`calendar:alice-${Math.floor(r() * n)}`];
        for (const c of [a, b]) c.dropSynced(alice, ids);
      } else if (r2 < 0.78) {
        const ids = [`mail:alice-${Math.floor(r() * n)}`, `docs:alice-${Math.floor(r() * n)}`];
        for (const c of [a, b]) c.rememberProbe(alice, "probe", ids, 8, now);
      }
      // Ticks: `b` freezes alice after two idle ones; a read in between thaws her.
      for (let t = 0; t < 3; t++) {
        a.expireIdle(now);
        b.expireIdle(now);
      }
      frozenSeen += b.frozenCount;
      expect(b.revision(alice)).toBe(a.revision(alice));
      expect(b.syncedCount(alice)).toBe(a.syncedCount(alice));
      if (step % 3 === 0) expect(snapshot(b, alice, now)).toEqual(snapshot(a, alice, now));
    }
    expect(frozenSeen).toBeGreaterThan(20);
    expect(b.freezes.thawed).toBeGreaterThan(10);
    // Expiry of a frozen user's items still happens on time: long past every time to live, both drop her.
    now += 1_000 * MIN;
    expect(b.expireIdle(now)).toBe(a.expireIdle(now));
    expect(b.userCount).toBe(0);
    expect(a.userCount).toBe(0);
  }
}

describe("idle users frozen (D325), continued", () => {
  test("people tied for the most keep their order through a freeze (selfOf's first-listed pick)", () => {
    const a = manual({ freezeIdleMs: 0, expireEveryMs: 0 });
    const b = manual({ freezeIdleMs: 1, expireEveryMs: 1 });
    const mk = (n: number, who: string): ContextItem => ({
      id: `mail:${n}`,
      sourceId: "mail",
      ref: String(n),
      title: `Note ${n}`,
      text: `note ${n}`,
      meta: { people: who },
    });
    // Zoë Müller is counted first, then dropped to zero and counted again after Bo Chen: the tally's order is now
    // Bo, Zoë, while the items' order alone would give Zoë first.
    for (const c of [a, b]) {
      c.put(alice, [mk(0, "Zoë Müller")], T0);
      c.removeItems(alice, ["mail:0"], T0);
      for (let i = 1; i <= 6; i++) c.put(alice, [mk(i, "Bo Chen")], T0);
      for (let i = 7; i <= 12; i++) c.put(alice, [mk(i, "Zoë Müller")], T0);
    }
    for (const c of [a, b]) for (let i = 1; i <= 6; i++) c.put(alice, [mk(i, "Bo Chen")], T0);
    for (const c of [a, b]) c.removeItems(alice, ["mail:0"], T0);
    for (let t = 0; t < 2; t++) b.expireIdle(T0);
    expect(b.frozenCount).toBe(1);
    expect(b.selfOf(alice)).toBe(a.selfOf(alice));
    expect(a.selfOf(alice)).toBe("Bo Chen");
  });

  test("metadata reads leave a frozen user frozen; any other read or write thaws", () => {
    const cache = manual({ freezeIdleMs: 1, expireEveryMs: 1 });
    const r = rng(3);
    cache.put(
      alice,
      Array.from({ length: 30 }, (_, i) => makeItem(r, i, "alice")),
      T0,
      false,
      true,
    );
    const revision = cache.revision(alice);
    for (let t = 0; t < 2; t++) cache.expireIdle(T0);
    expect(cache.frozenCount).toBe(1);
    expect(cache.revision(alice)).toBe(revision);
    expect(cache.syncedCount(alice)).toBe(30);
    expect(cache.frozenCount).toBe(1);
    expect(cache.get(alice, "mail:alice-0", T0)?.text).toContain("(alice)");
    expect(cache.frozenCount).toBe(0);
    expect(cache.revision(alice)).toBe(revision); // A thaw changes nothing derived from the items.
  });

  test("a user read at every tick never freezes; one read within the window is not frozen at the next tick", () => {
    const cache = manual({ freezeIdleMs: 3, expireEveryMs: 1 });
    cache.put(alice, [makeItem(rng(1), 1, "alice")], T0);
    for (let t = 0; t < 10; t++) {
      cache.expireIdle(T0);
      cache.syncedCount(alice); // Metadata: does not count as use.
      cache.peekVocab(alice);
    }
    expect(cache.frozenCount).toBe(0);
    for (let t = 0; t < 3; t++) cache.expireIdle(T0);
    expect(cache.frozenCount).toBe(1);
  });

  test("isolation (D9): one user's freeze and thaw never shows or moves another user's items", () => {
    const cache = manual({ freezeIdleMs: 1, expireEveryMs: 1 });
    const r = rng(11);
    cache.put(
      alice,
      Array.from({ length: 20 }, (_, i) => makeItem(r, i, "alice")),
      T0,
    );
    cache.put(
      bob,
      Array.from({ length: 20 }, (_, i) => makeItem(r, i, "bob")),
      T0,
    );
    cache.put(
      carol,
      Array.from({ length: 20 }, (_, i) => makeItem(r, i, "carol")),
      T0,
    );
    const before = { bob: snapshot(cache, bob, T0), carol: snapshot(cache, carol, T0) };
    for (let t = 0; t < 2; t++) {
      cache.expireIdle(T0);
      cache.peekVocab(bob); // Bob stays in use; alice and carol (alice's id in another tenant) freeze.
    }
    expect(cache.frozenCount).toBe(2);
    expect(snapshot(cache, bob, T0)).toEqual(before.bob);
    expect(cache.frozenCount).toBe(2);
    // Thawing carol brings back carol's items only, never alice's (same user id, other tenant).
    expect(snapshot(cache, carol, T0)).toEqual(before.carol);
    const vocab = cache.peekVocab(carol)!;
    const q = termIds("alice", vocab, false);
    expect(cache.search(carol, q.ids, q.n, 50, T0)).toEqual([]);
    for (const h of cache.hits(carol, ["mail:alice-0", "mail:carol-0"], T0)) expect(h.item.text).toContain("(carol)");
    expect(cache.frozenCount).toBe(1);
    // Forgetting a frozen user drops their blob; the others stay as they were.
    cache.forget(alice);
    expect(cache.userCount).toBe(2);
    expect(cache.get(alice, "mail:alice-0", T0)).toBeNull();
    expect(snapshot(cache, bob, T0)).toEqual(before.bob);
  });

  test("the drop hook hears a frozen user's whole drop on expiry, as an unfrozen one's", () => {
    const cache = manual({ freezeIdleMs: 1, expireEveryMs: 1, ttlMs: 10 * MIN });
    const dropped: (string[] | null)[] = [];
    cache.onDropped((_s, ids) => dropped.push(ids));
    cache.put(alice, [makeItem(rng(1), 1, "alice")], T0);
    for (let t = 0; t < 2; t++) cache.expireIdle(T0);
    expect(cache.frozenCount).toBe(1);
    expect(cache.expireIdle(T0 + 11 * MIN)).toBe(1);
    expect(dropped).toEqual([null]);
    expect(cache.userCount).toBe(0);
  });

  test("sliced: a burst of returning users queues; a read during a thaw finishes it at once with the same answer", async () => {
    const cache = manual({ freezeIdleMs: 1, expireEveryMs: 1 });
    const twin = manual({ freezeIdleMs: 0, expireEveryMs: 0 });
    const scopes = Array.from({ length: 6 }, (_, k) => ({ tenantId: "t", userId: `u${k}` }));
    for (const c of [cache, twin]) {
      for (const sc of scopes) {
        const r = rng(sc.userId.length * 31 + Number(sc.userId.slice(1)));
        c.put(
          sc,
          Array.from({ length: 300 }, (_, i) => makeItem(r, i, sc.userId)),
          T0,
          false,
          true,
        );
      }
    }
    // The timer's path: freezes are queued and done in slices.
    cache.expireIdle(T0, true);
    cache.expireIdle(T0, true);
    while (cache.slicedPending > 0) await new Promise((r) => setTimeout(r, 1));
    expect(cache.frozenCount).toBe(6);
    // The first slice runs at once, inside the first `ready`; the rest queue behind it.
    const waits = scopes.map((sc) => cache.ready(sc));
    expect(waits.every((w) => w instanceof Promise)).toBe(true);
    const again = scopes.map((sc) => cache.ready(sc)); // One thaw per user, however many requests wait on it.
    // A read of the last user before its turn thaws it at once; its queued job then finds nothing to do.
    expect(snapshot(cache, scopes[5]!, T0)).toEqual(snapshot(twin, scopes[5]!, T0));
    await Promise.all([...waits, ...again]);
    expect(cache.frozenCount).toBe(0);
    expect(cache.freezes.thawed).toBe(6);
    for (const sc of scopes) expect(snapshot(cache, sc, T0)).toEqual(snapshot(twin, sc, T0));
    expect(cache.ready(scopes[0]!)).toBeNull();
  });

  test("sliced: a freeze under way is dropped when the user is read or written before it ends", async () => {
    const cache = manual({ freezeIdleMs: 1, expireEveryMs: 1 });
    const r = rng(5);
    cache.put(
      alice,
      Array.from({ length: 2_000 }, (_, i) => makeItem(r, i, "alice")),
      T0,
      false,
      true,
    );
    cache.expireIdle(T0, true);
    cache.expireIdle(T0, true); // Queued; the first slice runs once this test yields.
    expect(cache.slicedPending).toBe(1);
    await new Promise((res) => setImmediate(res));
    cache.put(alice, [makeItem(r, 5_000, "alice")], T0, false, true); // A write mid-freeze.
    while (cache.slicedPending > 0) await new Promise((res) => setTimeout(res, 1));
    expect(cache.frozenCount).toBe(0);
    expect(cache.syncedCount(alice)).toBe(2_001);
  });

  /** Counts the thaws a caller queued through `ready` (a promise: the user was frozen when it asked). */
  function spyReady(cache: ItemCache): { queued: number } {
    const seen = { queued: 0 };
    const real = cache.ready.bind(cache);
    cache.ready = (scope) => {
      const p = real(scope);
      if (p) seen.queued++;
      return p;
    };
    return seen;
  }

  test("the partner's entry points thaw a frozen user through `ready`, never all at once inside a read", async () => {
    // Exactness is the cache's (the twin tests above): two runs of the partner itself differ with wall-clock timing
    // (background slow paths settle at different points), so here the partner's own path is checked, not equality.
    const w = buildWorkload({ itemsPerSource: 120, events: 12, seed: 3 });
    let clock = w.events[0]!.at;
    const cache = manual({ freezeIdleMs: 1, expireEveryMs: 1 });
    const spy = spyReady(cache);
    const partner = new ContextPartner({
      sources: async () => w.sources,
      sourceMap: new SourceMap(),
      cache,
      budget: new Budget(),
      model: null,
      now: () => clock,
    });
    const freeze = () => {
      cache.expireIdle(clock);
      cache.expireIdle(clock);
      expect(cache.frozenCount).toBe(1);
    };
    const question = `what did ${w.people[0]} say about the account?`;
    await partner.ask({ ...w.scope, sessionId: "s1", question });
    expect(cache.revision(w.scope)).toBeGreaterThan(0); // The lookup stored what it found.
    // Each entry point: the frozen user's thaw is the queued one (`ready` handed out a promise), so the count of thaws
    // equals the count of queued ones: none ran inside a read.
    freeze();
    await partner.ask({ ...w.scope, sessionId: "s1", question });
    freeze();
    await partner.observe(w.events[0]!, { waitMs: 0 });
    freeze();
    await partner.checkAction({ ...w.events[0]!, kind: "tool_call", tool: "send_email", input: { to: "x" } });
    freeze();
    const item = { id: "mail:new-1", sourceId: "mail", ref: "new-1", title: "A new note", text: "about the account" };
    await partner.sourceItems(w.scope, "mail", [item]);
    expect(cache.frozenCount).toBe(0);
    expect(spy.queued).toBe(4);
    expect(cache.freezes.thawed).toBe(4);
    // A bare change notice reads no item: with no session holding a copy of the source, the user stays frozen.
    for (const sessionId of new Set(["s1", ...w.events.map((e) => e.sessionId)])) {
      await partner.observe({ ...w.scope, sessionId, kind: "session_end", at: clock });
    }
    expect(spy.queued).toBe(4); // Ending a session reads no item.
    freeze();
    partner.sourceNotice(w.scope, "mail");
    await Bun.sleep(5);
    expect(cache.frozenCount).toBe(1);
    expect(spy.queued).toBe(4);
    for (const event of w.events) {
      clock = event.at;
      await partner.observe(event, { waitMs: 0 });
    }
    expect(cache.freezes.thawed).toBe(spy.queued);
  });

  test("a due sweep or a backfill thaws a frozen user through `ready` before it reads them", async () => {
    let clock = T0;
    const items = Array.from({ length: 40 }, (_, i) => makeItem(rng(i), i, "alice")).map((it) => ({
      ...it,
      sourceId: "mail",
      id: `mail:alice-${it.ref}`,
    }));
    const mail: Source = {
      id: "mail",
      kind: "test",
      description: "mail",
      search: async () => [],
      list: async (_s: Scope, cursor: string | undefined, limit: number): Promise<ListPage> => {
        const at = cursor ? Number(cursor) : 0;
        return { items: items.slice(at, at + limit), next: at + limit < items.length ? String(at + limit) : null };
      },
    };
    const cache = manual({ freezeIdleMs: 1, expireEveryMs: 1 });
    const spy = spyReady(cache);
    const partner = new ContextPartner({
      sources: async () => [mail],
      sourceMap: new SourceMap(),
      cache,
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { syncCallsPerMin: 1e6 },
    });
    const sync = partner.sync!;
    sync.track(alice, clock);
    for (let i = 0; i < 20 && cache.syncedCount(alice) < 40; i++) await sync.tick();
    expect(cache.syncedCount(alice)).toBe(40);
    // A day on, the user active again (a sweep is due) but not yet read: frozen meanwhile.
    clock += 25 * 3_600_000;
    cache.expireIdle(clock);
    cache.expireIdle(clock);
    expect(cache.frozenCount).toBe(1);
    sync.track(alice, clock);
    await sync.tick();
    expect(spy.queued).toBe(1);
    expect(cache.freezes.thawed).toBe(1);
  });

  /** Alice synced from two 20-item sources (the user's cap at `maxItems`), with the source set the test can change. */
  async function syncedAlice(maxItems: number) {
    let clock = T0;
    const listed = (id: string): Source => {
      const items = Array.from({ length: 20 }, (_, i) => makeItem(rng(i), i, "alice")).map((it) => ({
        ...it,
        sourceId: id,
        id: `${id}:alice-${it.ref}`,
      }));
      return {
        id,
        kind: "test",
        description: id,
        search: async () => [],
        list: async (_s: Scope, cursor: string | undefined, limit: number): Promise<ListPage> => {
          const at = cursor ? Number(cursor) : 0;
          return { items: items.slice(at, at + limit), next: at + limit < items.length ? String(at + limit) : null };
        },
      };
    };
    const state = { sources: [listed("mail"), listed("docs")] };
    const cache = manual({ freezeIdleMs: 1, expireEveryMs: 1 });
    const partner = new ContextPartner({
      sources: async () => state.sources,
      sourceMap: new SourceMap(),
      cache,
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { syncCallsPerMin: 1e6, syncMaxItems: maxItems, syncPageSize: 5, syncKeepCut: true },
    });
    const sync = partner.sync!;
    sync.track(alice, clock);
    for (let i = 0; i < 20 && !sync.warm(alice); i++) await sync.tick();
    expect(sync.warm(alice)).toBe(true);
    const freeze = () => {
      clock += MIN;
      cache.expireIdle(clock);
      cache.expireIdle(clock);
      expect(cache.frozenCount).toBe(1);
    };
    return { cache, sync, state, freeze, at: () => clock };
  }

  test("a source no longer listed: its synced items are dropped after a thaw through `ready`, not inside the drop", async () => {
    const { cache, sync, state, freeze } = await syncedAlice(3_000);
    expect(cache.syncedCount(alice)).toBe(40);
    freeze();
    const spy = spyReady(cache);
    state.sources = state.sources.filter((x) => x.id !== "docs");
    await sync.tick();
    expect(spy.queued).toBe(1);
    expect(cache.freezes.thawed).toBe(1);
    expect(cache.syncedCount(alice)).toBe(20);
  });

  test("the keep-cut trim thaws a frozen user through `ready` before it reads their items", async () => {
    const { cache, sync, freeze, at } = await syncedAlice(10);
    // Notices' items past half the cap again (a push does not trim), then the user goes idle before the next step.
    for (const id of ["mail", "docs"]) {
      const pushed = Array.from({ length: 8 }, (_, i) => makeItem(rng(100 + i), 100 + i, "alice")).map((it, i) => ({
        ...it,
        sourceId: id,
        id: `${id}:alice-new-${it.ref}`,
        updatedAt: at() + i,
      }));
      expect(sync.ingest(alice, id, pushed)).toBe(8);
    }
    const before = cache.syncedCount(alice);
    expect(before).toBeGreaterThan(15);
    freeze();
    const spy = spyReady(cache);
    await sync.tick();
    expect(spy.queued).toBe(1);
    expect(cache.freezes.thawed).toBe(1);
    expect(cache.syncedCount(alice)).toBeLessThan(before);
  });

  test("a session's events keep their order when a read or a forget ends a thaw an earlier event waits on", async () => {
    // Review of A14: an event that found its user frozen waits for the queued thaw; a synchronous read (a background
    // store, a pending take) or a forget then ended the frozen state, and a later event of the same session, finding
    // nothing frozen, ran first. Later callers wait on a thaw still queued.
    for (const end of ["read", "forget"] as const) {
      const w = buildWorkload({ itemsPerSource: 120, events: 12, seed: 3 });
      const clock = w.events[0]!.at;
      const cache = manual({ freezeIdleMs: 1, expireEveryMs: 1 });
      const partner = new ContextPartner({
        sources: async () => w.sources,
        sourceMap: new SourceMap(),
        cache,
        budget: new Budget(),
        model: null,
        now: () => clock,
      });
      // Enough items that the thaw takes several slices.
      const r = rng(11);
      cache.put(
        w.scope,
        Array.from({ length: 4_000 }, (_, i) => makeItem(r, i, w.scope.userId)),
        clock,
      );
      cache.expireIdle(clock);
      cache.expireIdle(clock);
      expect(cache.frozenCount).toBe(1);
      const order: string[] = [];
      const inner = partner as unknown as { observeEvent: (e: { text?: string }, o: unknown) => Promise<unknown> };
      const real = inner.observeEvent.bind(partner);
      inner.observeEvent = (e, o) => {
        order.push(e.text!);
        return real(e, o);
      };
      const first = partner.observe({ ...w.scope, sessionId: "s", kind: "user_message", text: "first", at: clock });
      await new Promise((res) => setImmediate(res)); // The next event arrives in a later turn, the thaw in slices.
      expect(cache.frozenCount).toBe(1);
      if (end === "read") cache.peekVocab(w.scope);
      else partner.forget(w.scope);
      const at = clock + 1;
      const second = partner.observe({ ...w.scope, sessionId: "s", kind: "user_message", text: "second", at });
      await Promise.all([first, second]);
      expect(order).toEqual(["first", "second"]);
    }
  });

  test("a session's end or a draft waits on a thaw an earlier event of its session waits on, and starts none", async () => {
    // Review of A24: they read no item, so they no longer start a thaw (a lone one leaves the user frozen), but one
    // that skipped the queue altogether ran before the earlier message and closed the session under it.
    for (const kind of ["session_end", "draft"] as const) {
      const w = buildWorkload({ itemsPerSource: 120, events: 12, seed: 3 });
      const clock = w.events[0]!.at;
      const cache = manual({ freezeIdleMs: 1, expireEveryMs: 1 });
      const partner = new ContextPartner({
        sources: async () => w.sources,
        sourceMap: new SourceMap(),
        cache,
        budget: new Budget(),
        model: null,
        now: () => clock,
      });
      const r = rng(11);
      cache.put(
        w.scope,
        Array.from({ length: 4_000 }, (_, i) => makeItem(r, i, w.scope.userId)),
        clock,
      );
      cache.expireIdle(clock);
      cache.expireIdle(clock);
      expect(cache.frozenCount).toBe(1);
      const later = (at: number) =>
        kind === "session_end"
          ? { ...w.scope, sessionId: "s", kind: "session_end" as const, text: "later", at }
          : { ...w.scope, sessionId: "s", kind: "user_message" as const, text: "later", draft: true, at };
      // Alone, it reads nothing and leaves the user frozen.
      await partner.observe(later(clock));
      expect(cache.frozenCount).toBe(1);
      const order: string[] = [];
      const inner = partner as unknown as { observeEvent: (e: { text?: string }, o: unknown) => Promise<unknown> };
      const real = inner.observeEvent.bind(partner);
      inner.observeEvent = (e, o) => {
        order.push(e.text!);
        return real(e, o);
      };
      const first = partner.observe({ ...w.scope, sessionId: "s", kind: "user_message", text: "first", at: clock });
      await new Promise((res) => setImmediate(res)); // The later event arrives in a later turn, the thaw in slices.
      expect(cache.frozenCount).toBe(1);
      const second = partner.observe(later(clock + 1));
      await Promise.all([first, second]);
      expect(order).toEqual(["first", "later"]);
      if (kind === "session_end") expect(partner.sessionCount).toBe(0);
    }
  });
});
