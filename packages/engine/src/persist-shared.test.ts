/**
 * Frozen users in a shared store (D992): what one machine writes another fetches and serves with the same answers,
 * the sync state and the user's source-map rows; a thaw keeps the store's copy (failover) and a forget deletes it; a
 * hand-off waits for the user's own write; processes sharing a directory each see only the buckets they own; the
 * store's sweep deletes old copies it owns; an unreachable store fails open.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { bucketOf, itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { type BlobStore, ShardedBlobStore, SharedFrozenDisk } from "./persist-shared";
import { termIds } from "./text";

const HOUR = 3_600_000;
const T0 = Date.now() - HOUR;
const KEY = new Uint8Array(32).map((_, i) => i + 7);
const alice: Scope = { tenantId: "t", userId: "alice" };
const bob: Scope = { tenantId: "t", userId: "bob" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "eden-shared-"));
  dirs.push(d);
  return d;
}
const files = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".blob"));

/** An in-memory S3 stand-in; `down` makes every call reject, `delayMs` slows puts. */
class MemoryStore implements BlobStore {
  readonly objects = new Map<string, { bytes: Uint8Array; modified: number }>();
  down = false;
  delayMs = 0;
  getDelayMs = 0;
  gets = 0;
  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (this.delayMs) await Bun.sleep(this.delayMs);
    if (this.down) throw new Error("down");
    this.objects.set(key, { bytes: new Uint8Array(bytes), modified: Date.now() });
  }
  async get(key: string): Promise<Uint8Array | null> {
    this.gets++;
    if (this.getDelayMs) await Bun.sleep(this.getDelayMs);
    if (this.down) throw new Error("down");
    return this.objects.get(key)?.bytes ?? null;
  }
  async delete(key: string): Promise<void> {
    if (this.down) throw new Error("down");
    this.objects.delete(key);
  }
  async *list(prefix: string): AsyncIterable<{ key: string; modified: number }> {
    if (this.down) throw new Error("down");
    for (const [key, o] of this.objects) if (key.startsWith(prefix)) yield { key, modified: o.modified };
  }
}

function shared(store: BlobStore, dir = tempDir(), owns?: (b: number) => boolean) {
  return new SharedFrozenDisk({
    dir,
    key: KEY,
    maxBytes: 64 << 20,
    maxAgeMs: 7 * 24 * HOUR,
    store,
    prefix: "f/",
    owns,
  });
}

function freezing(): ItemCache {
  const c = new ItemCache({ freezeIdleMs: 1, expireEveryMs: 1 });
  c.close();
  return c;
}
const freezeAll = (c: ItemCache, now: number) => {
  for (let i = 0; i < 3; i++) c.expireIdle(now);
};

function items(user: string, n: number): ContextItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: itemId("mail", `${user}-${i}`),
    sourceId: "mail",
    ref: `${user}-${i}`,
    title: `Budget review ${i} for ${user}`,
    text: `From: Dana Lee\nThe quarterly budget review ${i} moved to Friday; word ${user}${i}`,
    updatedAt: T0 - i * 60_000,
  }));
}

function find(c: ItemCache, s: Scope, q: string, now: number): string[] {
  const vocab = c.peekVocab(s);
  if (!vocab) return [];
  const { ids, n } = termIds(q, vocab, false);
  return c.search(s, Array.from(ids.subarray(0, n)), n, 50, now).map((h) => h.item.id);
}

describe("a store shared between machines (D992)", () => {
  test("machine B fetches what machine A froze and answers the same; a thaw keeps the store's copy", async () => {
    const store = new MemoryStore();
    const a = freezing();
    const da = shared(store);
    a.persist(da);
    a.put(alice, items("alice", 30), T0);
    const before = find(a, alice, "quarterly budget review Friday", T0);
    freezeAll(a, T0);
    expect(await da.settle(1_000)).toBe(0);
    expect([...store.objects.keys()]).toEqual([`f/${da.local.nameOf(alice)}`]);
    expect(da.local.nameOf(alice).slice(0, 4)).toBe(bucketOf("t", "alice").toString(16).padStart(4, "0"));

    const b = freezing();
    const dirB = tempDir();
    const db = shared(store, dirB);
    b.persist(db);
    expect(b.ready(alice)).not.toBeNull(); // a fetch to wait for
    await b.ready(alice);
    expect(find(b, alice, "quarterly budget review Friday", T0)).toEqual(before);
    expect(b.freezes.loaded).toBe(1);
    // Thawed: the local file went, the store keeps the failover copy.
    expect(files(dirB)).toEqual([]);
    expect(store.objects.size).toBe(1);
    // A user the store does not hold is asked for once, then remembered as absent until membership changes.
    const gets = store.gets;
    await b.ready(bob);
    expect(b.ready(bob)).toBeNull();
    expect(store.gets).toBe(gets + 1);
    db.forgetAbsent();
    expect(b.ready(bob)).not.toBeNull();
  });

  test("forget deletes the store's copy too; a hand-off waits for the user's own write, then drops the local file", async () => {
    const store = new MemoryStore();
    const c = freezing();
    const d = shared(store);
    c.persist(d);
    c.put(alice, items("alice", 5), T0);
    c.put(bob, items("bob", 5), T0);
    freezeAll(c, T0);
    await d.settle(1_000);
    expect(store.objects.size).toBe(2);
    c.forget(bob);
    await d.settle(1_000);
    expect([...store.objects.keys()]).toEqual([`f/${d.local.nameOf(alice)}`]);

    store.delayMs = 50;
    store.objects.clear();
    c.put(alice, items("alice", 6), T0); // live again
    expect(c.release(alice)).toBe(true);
    expect(store.objects.size).toBe(0); // the write is still on its way
    await d.handOff(alice);
    expect(store.objects.size).toBe(1);
    expect(d.local.has(alice)).toBe(false);
    expect(c.frozenCount + c.userCount).toBe(0); // alice released, bob forgotten
  });

  test("a forget that lands while the store's copy is being read does not bring the user back (review of D992)", async () => {
    const store = new MemoryStore();
    const a = freezing();
    const da = shared(store);
    a.persist(da);
    a.put(alice, items("alice", 10), T0);
    freezeAll(a, T0);
    await da.settle(1_000);
    const b = freezing();
    const db = shared(store);
    b.persist(db);
    store.getDelayMs = 50;
    const reading = b.ready(alice);
    expect(reading).not.toBeNull();
    b.forget(alice); // the whole-user forget does not wait for the read
    await reading;
    await db.settle(1_000);
    expect(b.userCount + b.frozenCount).toBe(0);
    expect(db.local.has(alice)).toBe(false);
    expect(store.objects.size).toBe(0);
    expect(db.remote.cancelled).toBe(1);
  });

  test("a fenced process's forget drops its own queued and retrying writes of the user (R1)", async () => {
    // The old owner after a release that passed its deadline: fenced, its write of bob still queued behind alice's.
    // The new owner's delete lands; a late put from here would bring the forgotten user back in the store.
    const store = new MemoryStore();
    const c = freezing();
    const d = new SharedFrozenDisk({
      dir: tempDir(),
      key: KEY,
      maxBytes: 64 << 20,
      maxAgeMs: 7 * 24 * HOUR,
      store,
      prefix: "f/",
      concurrency: 1,
    });
    c.persist(d);
    store.delayMs = 40;
    c.put(alice, items("alice", 3), T0);
    c.put(bob, items("bob", 3), T0);
    freezeAll(c, T0); // alice's put runs, bob's waits
    expect(d.backlog).toBe(2);
    d.setWritable(() => false);
    c.forget(bob);
    await d.settle(1_000);
    expect([...store.objects.keys()]).toEqual([`f/${d.local.nameOf(alice)}`]);

    // Without a forget, a put still queued when the fence moves is not written either: the new owner decides.
    const store3 = new MemoryStore();
    const c3 = freezing();
    const d3 = new SharedFrozenDisk({
      dir: tempDir(),
      key: KEY,
      maxBytes: 64 << 20,
      maxAgeMs: 7 * 24 * HOUR,
      store: store3,
      prefix: "f/",
      concurrency: 1,
    });
    c3.persist(d3);
    store3.delayMs = 40;
    c3.put(alice, items("alice", 3), T0);
    c3.put(bob, items("bob", 3), T0);
    freezeAll(c3, T0);
    d3.setWritable(() => false);
    await d3.settle(1_000);
    expect([...store3.objects.keys()]).toEqual([`f/${d3.local.nameOf(alice)}`]);

    // A put that failed once and is waiting to retry is not retried once its bucket is fenced.
    const store2 = new MemoryStore();
    const c2 = freezing();
    const d2 = shared(store2);
    c2.persist(d2);
    store2.down = true;
    c2.put(alice, items("alice", 3), T0);
    freezeAll(c2, T0);
    await Bun.sleep(20);
    store2.down = false;
    d2.setWritable(() => false);
    await d2.settle(2_000);
    expect(store2.objects.size).toBe(0);
    expect(d2.remote.skipped).toBeGreaterThan(0);
  });

  test("the store's key check: a marker of the key, sampling before there is one, rotation, a down or hung store (R1b)", async () => {
    const store = new MemoryStore();
    const OLD = KEY;
    const NEW = new Uint8Array(32).map((_, i) => 250 - i);
    const disk = (key: Uint8Array, s: BlobStore = store) =>
      new SharedFrozenDisk({
        dir: tempDir(),
        key,
        maxBytes: 64 << 20,
        maxAgeMs: 7 * 24 * HOUR,
        store: s,
        prefix: "f/",
      });
    // Blobs written under the old key by a server from before the marker: none names the key yet.
    const c = freezing();
    const old = disk(OLD);
    c.persist(old);
    for (const u of ["a", "b", "c"]) c.put({ tenantId: "t", userId: u }, items(u, 3), T0);
    freezeAll(c, T0);
    await old.settle(1_000);
    expect(store.objects.size).toBe(3);
    // No marker: the blobs are sampled; all foreign is refused and nothing is written.
    expect(await disk(NEW).verifyStoreKey(false)).toMatchObject({ verdict: "foreign", sampled: 3, foreign: 3 });
    expect(store.objects.has("f/key-id")).toBe(false);
    // The old key's own start writes the marker.
    expect(await disk(OLD).verifyStoreKey(false)).toMatchObject({ verdict: "ok" });
    expect(store.objects.has("f/key-id")).toBe(true);
    // A rotation: discarding moves the marker to the new key; the old blobs stay (the age sweep takes them), and the
    // next start with the new key is not refused by them, however many there are (the review of R1b).
    expect(await disk(NEW).verifyStoreKey(true)).toMatchObject({ verdict: "discarded" });
    expect(await disk(NEW).verifyStoreKey(false)).toMatchObject({ verdict: "ok" });
    expect(store.objects.size).toBe(4); // three old blobs and the marker
    // The old key is now the foreign one.
    expect(await disk(OLD).verifyStoreKey(false)).toMatchObject({ verdict: "foreign" });
    // An empty store: ok, and the marker is written.
    const empty = new MemoryStore();
    expect(await disk(NEW, empty).verifyStoreKey(false)).toMatchObject({ verdict: "ok" });
    expect(empty.objects.has("f/key-id")).toBe(true);
    // Down or hung: unknown, the start goes ahead (fail open).
    store.down = true;
    expect(await disk(NEW).verifyStoreKey(false)).toMatchObject({ verdict: "unknown" });
    store.down = false;
    store.getDelayMs = 1_000;
    expect(await disk(NEW).verifyStoreKey(false, 50)).toMatchObject({ verdict: "unknown" });
  });

  test("users remembered as absent from the store are bounded (R1)", async () => {
    const store = new MemoryStore();
    const d = new SharedFrozenDisk({
      dir: tempDir(),
      key: KEY,
      maxBytes: 64 << 20,
      maxAgeMs: 7 * 24 * HOUR,
      store,
      prefix: "f/",
      maxAbsent: 10,
    });
    for (let i = 0; i < 25; i++) await d.fetch({ tenantId: "t", userId: `u${i}` });
    for (let i = 0; i < 25; i++) d.delete({ tenantId: "t", userId: `v${i}` });
    expect(d.absentCount).toBeLessThanOrEqual(10);
    await d.settle(1_000);
  });

  test("forgetting one source, or items deleted at their source, deletes the store's older copy (review of D992)", async () => {
    for (const how of ["source", "removed"] as const) {
      const store = new MemoryStore();
      const c = freezing();
      const d = shared(store);
      c.persist(d);
      c.put(alice, [...items("alice", 4), { ...items("alice", 1)[0]!, id: "docs:x", sourceId: "docs", ref: "x" }], T0);
      freezeAll(c, T0);
      await d.settle(1_000);
      await c.ready(alice); // thawed: the store keeps the failover copy
      expect(store.objects.size).toBe(1);
      if (how === "source") c.forget(alice, "docs");
      else c.removeItems(alice, ["docs:x"], T0);
      await d.settle(1_000);
      expect(store.objects.size).toBe(0);
      expect(find(c, alice, "quarterly budget review", T0).length).toBe(4); // the rest stay live
    }
  });

  test("processes sharing a directory each index only their own buckets", () => {
    const dir = tempDir();
    const store = new MemoryStore();
    const even = (b: number) => b % 2 === 0;
    const odd = (b: number) => b % 2 === 1;
    const users = Array.from({ length: 20 }, (_, i) => ({ tenantId: "t", userId: `u${i}` }));
    const w = freezing();
    w.persist(shared(store, dir));
    for (const u of users) w.put(u, items(u.userId, 2), T0);
    freezeAll(w, T0);
    expect(files(dir).length).toBe(20);
    const de = shared(store, dir, even);
    const dodd = shared(store, dir, odd);
    expect(de.local.count + dodd.local.count).toBe(20);
    for (const u of users) {
      const mine = bucketOf(u.tenantId, u.userId) % 2 === 0 ? de : dodd;
      const other = mine === de ? dodd : de;
      expect(mine.has(u)).toBe(true);
      expect(other.has(u)).toBe(false);
    }
  });

  test("the store's sweep deletes copies past the age bound, only in owned buckets; a down store fails open", async () => {
    const store = new MemoryStore();
    const d = shared(store);
    const old = Date.now() - 8 * 24 * HOUR;
    const name = (b: number) => `f/${b.toString(16).padStart(4, "0")}-${"a".repeat(40)}.blob`;
    store.objects.set(name(2), { bytes: new Uint8Array(1), modified: old });
    store.objects.set(name(3), { bytes: new Uint8Array(1), modified: Date.now() });
    store.objects.set("f/not-ours.txt", { bytes: new Uint8Array(1), modified: old });
    const odd = shared(store, tempDir(), (b) => b % 2 === 1);
    expect(await odd.sweepStore(Date.now())).toBe(0);
    expect(await d.sweepStore(Date.now())).toBe(1);
    await d.settle(1_000);
    expect([...store.objects.keys()].sort()).toEqual([name(3), "f/not-ours.txt"]);

    store.down = true;
    const c = freezing();
    const dd = shared(store);
    c.persist(dd);
    await c.ready(alice); // the fetch fails: the user simply starts here
    c.put(alice, items("alice", 3), T0);
    freezeAll(c, T0);
    expect(await dd.settle(2_000)).toBe(0); // tried, failed, counted
    expect(dd.remote.failed).toBeGreaterThanOrEqual(2);
    expect(dd.local.has(alice)).toBe(true); // the local file stands
  });
});

/** A connector with a recent-first list call. */
class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  lists = 0;
  items: ContextItem[];
  constructor(
    readonly id: string,
    n: number,
  ) {
    this.items = Array.from({ length: n }, (_, i) => ({
      id: itemId(id, `m${i}`),
      sourceId: id,
      ref: `m${i}`,
      title: i === 0 ? "Dana Lee: budget" : `Mail ${i}`,
      text: i === 0 ? "Dana Lee says the budget review moved to Friday" : `Note ${i} about the quarterly plan`,
      updatedAt: T0 - i * HOUR,
    }));
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const at = cursor ? Number(cursor) : 0;
    return {
      items: this.items.slice(at, at + limit),
      next: at + limit < this.items.length ? String(at + limit) : null,
    };
  }
}

function partnerOver(src: Source, cache: ItemCache, sourceMap: SourceMap, clock: () => number): ContextPartner {
  return new ContextPartner({
    sources: async () => [src],
    sourceMap,
    cache,
    budget: new Budget(),
    model: null,
    now: clock,
    config: { sync: true, syncPageSize: 2, syncCallsPerMin: 6_000 },
  });
}

test("a released user lands on another machine with its sync state and source-map rows; the old one keeps none", async () => {
  const store = new MemoryStore();
  let clock = T0;
  const now = () => clock;
  const src = new ListSource("mail", 20);
  const ca = freezing();
  const da = shared(store);
  ca.persist(da);
  const mapA = new SourceMap(":memory:", { seed: 1 });
  const pa = partnerOver(src, ca, mapA, now);
  pa.sync!.track(alice);
  for (let i = 0; i < 100 && !pa.sync!.warm(alice); i++, clock += 1_000) await pa.sync!.tick();
  await pa.observe(
    { ...alice, sessionId: "s1", at: clock, kind: "user_message", text: "Dana Lee budget review?" } as AgentEvent,
    { waitMs: 1_000 },
  );
  mapA.recordOutcome(alice, "general", "mail", true);
  const rows = mapA.exportUser(alice);
  expect(rows.mention.length + rows.utility.length).toBeGreaterThan(0);

  const { released, written } = pa.releaseMoved((s) => s.userId === "alice", 5_000);
  expect({ released, written }).toEqual({ released: [alice], written: 1 });
  await da.handOff(alice);
  expect(mapA.exportUser(alice)).toEqual({ mention: [], utility: [], arms: [] });
  expect(ca.userCount + ca.frozenCount).toBe(0);
  expect(store.objects.size).toBe(1);

  src.lists = 0;
  const cb = freezing();
  cb.persist(shared(store));
  const mapB = new SourceMap(":memory:", { seed: 1 });
  const pb = partnerOver(src, cb, mapB, now);
  clock += 60_000;
  const r = await pb.observe(
    { ...alice, sessionId: "s2", at: clock, kind: "user_message", text: "Dana Lee budget review: when?" } as AgentEvent,
    { waitMs: 2_000 },
  );
  await pb.sync!.tick();
  expect(cb.freezes.loaded).toBe(1);
  expect(pb.sync!.warm(alice)).toBe(true); // polled, not backfilled
  expect(src.lists).toBeLessThanOrEqual(2);
  expect(mapB.exportUser(alice)).toEqual(rows);
  const got = [r.injection, ...pb.takePending({ ...alice, sessionId: "s2" })].flatMap(
    (x) => x?.citations.map((c) => c.itemId) ?? [],
  );
  expect(got).toContain(itemId("mail", "m0"));
});

test("a store sharded over buckets (S1-P4): a user's blob lands in their bucket's shard; the marker and lists span them", async () => {
  // Two users whose buckets split over two shards; a name's shard is its first four hex digits mod the count.
  const names = ["alice", "bob", "carol", "dana", "erin", "fred"];
  const byShard: Scope[][] = [[], []];
  for (const u of names) byShard[bucketOf("t", u) % 2]!.push({ tenantId: "t", userId: u });
  const m0 = new MemoryStore();
  const m1 = new MemoryStore();
  const sharded = new ShardedBlobStore([m0, m1], "f/");
  const a = freezing();
  const da = shared(sharded);
  a.persist(da);
  const frozen: Scope[] = [];
  for (const u of [...byShard[0]!, ...byShard[1]!].slice(0, 4)) {
    a.put(u, items(u.userId, 10), T0);
    frozen.push(u);
  }
  freezeAll(a, T0);
  expect(await da.settle(1_000)).toBe(0);
  for (const u of frozen) {
    const key = `f/${da.local.nameOf(u)}`;
    const inShard = bucketOf(u.tenantId, u.userId) % 2 === 0 ? m0 : m1;
    const other = inShard === m0 ? m1 : m0;
    expect(inShard.objects.has(key)).toBe(true);
    expect(other.objects.has(key)).toBe(false);
  }
  expect(m0.objects.size + m1.objects.size).toBe(frozen.length);

  // The key marker names no blob: it sits on the first store.
  await da.verifyStoreKey(false);
  expect(m0.objects.has("f/key-id")).toBe(true);
  expect(m1.objects.has("f/key-id")).toBe(false);

  // A list merges every shard (the sweep and the key check's sample read across them).
  const listed: string[] = [];
  for await (const o of sharded.list("f/")) listed.push(o.key);
  expect(listed.length).toBe(m0.objects.size + m1.objects.size);

  // A second machine fetches a user from their shard, and a delete reaches the same one.
  const b = freezing();
  const db = shared(sharded, tempDir());
  b.persist(db);
  const u = frozen[0]!;
  await db.fetch(u);
  const inShard = bucketOf(u.tenantId, u.userId) % 2 === 0 ? m0 : m1;
  expect(db.local.has(u)).toBe(true);
  db.delete(u);
  await da.settle(1_000);
  await db.settle(1_000);
  expect(inShard.objects.has(`f/${da.local.nameOf(u)}`)).toBe(false);
});

test("a shard-count change: the sweep deletes the orphan in the shard that listed it, not the copy the name routes to now", async () => {
  // A user whose bucket % 4 lands on a different store than % 2: its blob moved shards when the count changed.
  const u = Array.from({ length: 200 }, (_, i) => ({ tenantId: "t", userId: `u${i}` })).find(
    (s) => bucketOf("t", s.userId) % 4 >= 2,
  )!;
  const m = [new MemoryStore(), new MemoryStore(), new MemoryStore(), new MemoryStore()];
  const oldShard = bucketOf("t", u.userId) % 2;
  const newShard = bucketOf("t", u.userId) % 4;
  expect(newShard).not.toBe(oldShard); // % 4 in {2,3} never equals % 2 in {0,1}
  // Written under the two-shard store.
  const two = new ShardedBlobStore([m[0]!, m[1]!], "f/");
  const a = freezing();
  const da = shared(two);
  a.persist(da);
  a.put(u, items(u.userId, 10), T0);
  freezeAll(a, T0);
  expect(await da.settle(1_000)).toBe(0);
  const key = `f/${da.local.nameOf(u)}`;
  expect(m[oldShard]!.objects.has(key)).toBe(true);
  // The count changes to four; the user's fresh blob goes to the shard their bucket now names.
  const four = new ShardedBlobStore(m, "f/");
  const b = freezing();
  const db = shared(four, tempDir());
  b.persist(db);
  b.put(u, items(`${u.userId}x`, 10), T0);
  freezeAll(b, T0);
  expect(await db.settle(1_000)).toBe(0);
  expect(m[newShard]!.objects.has(key)).toBe(true);
  // The old copy expires: the sweep must delete it where it lies and keep the fresh copy.
  m[oldShard]!.objects.get(key)!.modified = 0;
  await db.sweepStore(Date.now(), () => true);
  await db.settle(1_000);
  expect(m[oldShard]!.objects.has(key)).toBe(false);
  expect(m[newShard]!.objects.has(key)).toBe(true);
});
