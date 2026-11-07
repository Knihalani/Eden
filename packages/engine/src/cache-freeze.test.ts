/**
 * Idle users frozen (D325): a frozen user thaws into the state they were frozen in, so every read answers exactly as
 * it would have with no freeze; and the frozen blob is per user (D9).
 */
import { describe, expect, test } from "bun:test";
import type { ContextItem, Scope } from "@eden/protocol";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { buildWorkload } from "../bench/workload";
import { ItemCache, type CacheHit } from "./cache";
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
  test("a frozen user thaws to exactly the same answers, through churn, expiry and eviction", () => {
    // `a` never freezes; `b` freezes every user idle for two ticks. Both get the same writes at the same times.
    const limits = { maxItemsPerUser: 60, maxSyncedPerUser: 90, ttlMs: 50 * MIN, syncTtlMs: 400 * MIN };
    const a = new ItemCache({ ...limits, freezeIdleMs: 0, expireEveryMs: 0 });
    const b = manual({ ...limits, freezeIdleMs: 1, expireEveryMs: 1 });
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
  });

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

  test("the shipped default thaws a frozen user through `ready` before it serves them", async () => {
    // Exactness is the cache's (the twin tests above): two runs of the partner itself differ with wall-clock timing
    // (background slow paths settle at different points), so here the partner's own path is checked, not equality.
    const w = buildWorkload({ itemsPerSource: 120, events: 12, seed: 3 });
    let clock = w.events[0]!.at;
    const cache = manual({ freezeIdleMs: 1, expireEveryMs: 1 });
    const partner = new ContextPartner({
      sources: async () => w.sources,
      sourceMap: new SourceMap(),
      cache,
      budget: new Budget(),
      model: null,
      now: () => clock,
    });
    const question = `what did ${w.people[0]} say about the account?`;
    await partner.ask({ ...w.scope, sessionId: "s1", question });
    expect(cache.revision(w.scope)).toBeGreaterThan(0); // The lookup stored what it found.
    cache.expireIdle(clock);
    cache.expireIdle(clock);
    expect(cache.frozenCount).toBe(1);
    const revision = cache.revision(w.scope);
    await partner.ask({ ...w.scope, sessionId: "s1", question });
    expect(cache.frozenCount).toBe(0);
    expect(cache.freezes.thawed).toBe(1);
    cache.expireIdle(clock);
    cache.expireIdle(clock);
    expect(cache.frozenCount).toBe(1);
    for (const event of w.events) {
      clock = event.at;
      await partner.observe(event, { waitMs: 0 });
    }
    expect(cache.frozenCount).toBe(0);
    expect(cache.revision(w.scope)).toBeGreaterThanOrEqual(revision);
  });
});
