/**
 * Frozen users on disk, encrypted (D425, opt-in): a user frozen by one process thaws in the next exactly as frozen,
 * with its sync state, so a restart polls instead of backfilling; blobs are per user (D9), named by a keyed hash,
 * deleted by forget, a source's removal and any thaw; a wrong key, another version, an expired or a tampered blob
 * fails open (the user re-syncs) and is reported by reason only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { termIds } from "./text";
import { EncryptedFrozenDisk, PERSIST_FORMAT, type PersistEvent } from "./persist";

const HOUR = 3_600_000;
const T0 = Date.now() - HOUR; // Wall-clock based: the store dates its blobs on the cache's clock.
const KEY = new Uint8Array(32).map((_, i) => i + 1);
const OTHER_KEY = new Uint8Array(32).map((_, i) => 200 - i);
const alice: Scope = { tenantId: "t", userId: "alice" };
const bob: Scope = { tenantId: "t", userId: "bob" };
const carol: Scope = { tenantId: "u", userId: "alice" }; // Same user id, another tenant.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "eden-persist-"));
  dirs.push(d);
  return d;
}

function disk(dir: string, o: { key?: Uint8Array; maxBytes?: number; maxAgeMs?: number } = {}) {
  const events: PersistEvent[] = [];
  const d = new EncryptedFrozenDisk({
    dir,
    key: o.key ?? KEY,
    maxBytes: o.maxBytes ?? 64 * 1_048_576,
    maxAgeMs: o.maxAgeMs ?? 7 * 24 * HOUR,
    report: (e) => events.push(e),
  });
  return { d, events };
}

/** A cache that freezes on the ticks the test runs itself. */
function freezing(): ItemCache {
  const c = new ItemCache({ freezeIdleMs: 1, expireEveryMs: 1 });
  c.close();
  return c;
}

function freezeAll(c: ItemCache, now: number): void {
  for (let i = 0; i < 3; i++) c.expireIdle(now);
}

function items(user: string, n: number, src = "mail"): ContextItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: itemId(src, `${user}-${i}`),
    sourceId: src,
    ref: `${user}-${i}`,
    title: `Budget review ${i} for ${user}`,
    text: `From: Dana Lee\nThe quarterly budget review ${i} moved to Friday; secret word ${user}${i}`,
    updatedAt: T0 - i * 60_000,
  }));
}

/** The items a query finds in the user's cache (reading the user back from disk if need be). */
function find(c: ItemCache, s: Scope, q: string, now: number): ContextItem[] {
  const vocab = c.peekVocab(s);
  if (!vocab) return [];
  const { ids, n } = termIds(q, vocab, false);
  return c.search(s, Array.from(ids.subarray(0, n)), n, 50, now).map((h) => h.item);
}

const files = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".blob"));

describe("frozen users on disk (D425)", () => {
  test("off by default: a freeze writes nothing anywhere", () => {
    const c = freezing();
    expect(c.persisting).toBe(false);
    c.put(alice, items("alice", 5), T0);
    freezeAll(c, T0);
    expect(c.frozenCount).toBe(1);
    expect(c.flush()).toBe(0);
  });

  test("a frozen user is written encrypted under a keyed name, and a new process thaws it to the same answers", () => {
    const dir = tempDir();
    const a = freezing();
    a.persist(disk(dir).d);
    a.put(alice, items("alice", 30), T0);
    a.put(carol, items("carol", 4), T0);
    const before = find(a, alice, "quarterly budget review Friday", T0).map((i) => i.id);
    freezeAll(a, T0);
    expect(a.frozenCount).toBe(2);
    const names = files(dir);
    expect(names.length).toBe(2);
    for (const n of names) {
      expect(n).toMatch(/^[0-9a-f]{40}\.blob$/);
      const bytes = readFileSync(join(dir, n));
      const text = bytes.toString("latin1");
      // Neither the ids nor any word of the content is in the clear.
      for (const word of ["alice", "carol", "Dana", "budget", "quarterly", "mail"]) expect(text).not.toContain(word);
      expect(bytes.readUInt16LE(4)).toBe(PERSIST_FORMAT);
    }
    // A new process: a new cache and store over the same directory.
    const b = freezing();
    const { d } = disk(dir);
    b.persist(d);
    expect(d.count).toBe(2);
    expect(b.userCount).toBe(0); // Nothing is read until the user is used.
    const after = find(b, alice, "quarterly budget review Friday", T0).map((i) => i.id);
    expect(after).toEqual(before);
    expect(b.freezes.loaded).toBe(1);
    // Thawed: on disk is only ever a frozen user's state.
    expect(d.count).toBe(1);
    // Each user reads back only their own (D9): carol has her four, alice none of hers.
    expect(find(b, carol, "budget", T0).every((i) => i.ref.startsWith("carol"))).toBe(true);
    expect(find(b, bob, "budget", T0)).toEqual([]);
  });

  test("a blob copied under another user's name does not open: discarded as corrupt, nothing restored", () => {
    const dir = tempDir();
    const a = freezing();
    const { d } = disk(dir);
    a.persist(d);
    a.put(alice, items("alice", 5), T0);
    freezeAll(a, T0);
    copyFileSync(join(dir, d.nameOf(alice)), join(dir, d.nameOf(bob)));
    const b = freezing();
    const { d: d2, events } = disk(dir);
    b.persist(d2);
    expect(find(b, bob, "budget", T0)).toEqual([]);
    expect(events).toEqual([{ kind: "discarded", reason: "corrupt" }]);
    expect(files(dir)).toEqual([d.nameOf(alice)]);
  });

  test("a wrong key, another version, a tampered byte and an expired blob each fail open, by reason only", () => {
    const dir = tempDir();
    const a = freezing();
    const { d } = disk(dir);
    a.persist(d);
    for (const s of [alice, bob, carol]) a.put(s, items(s.userId, 3), T0);
    freezeAll(a, T0);
    // Another version (the header's) and a flipped ciphertext byte.
    const vPath = join(dir, d.nameOf(bob));
    const v = readFileSync(vPath);
    v.writeUInt16LE(PERSIST_FORMAT + 1, 4);
    writeFileSync(vPath, v);
    const cPath = join(dir, d.nameOf(carol));
    const c = readFileSync(cPath);
    c[60] = c[60]! ^ 0xff;
    writeFileSync(cPath, c);
    const b = freezing();
    const { d: d2, events } = disk(dir);
    b.persist(d2);
    expect(events).toEqual([{ kind: "discarded", reason: "version" }]);
    expect(find(b, carol, "budget", T0)).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: "discarded", reason: "corrupt" });
    // Alice's is fine, but read with another key it is discarded at open (the name would not match anyway).
    const { events: wrong } = disk(dir, { key: OTHER_KEY });
    expect(wrong).toEqual([{ kind: "discarded", reason: "key" }]);
    expect(files(dir)).toEqual([]);
    // Expired: written more than the cache's longest time to live ago.
    const e = freezing();
    e.persist(disk(dir).d);
    e.put(alice, items("alice", 2), T0);
    freezeAll(e, T0);
    expect(disk(dir, { maxAgeMs: 1 }).events).toEqual([{ kind: "discarded", reason: "expired" }]);
    expect(files(dir)).toEqual([]);
  });

  test("forget deletes the user's blob, read back or not; a source's forget and a removal too", () => {
    const dir = tempDir();
    const a = freezing();
    const { d } = disk(dir);
    a.persist(d);
    for (const s of [alice, bob, carol]) a.put(s, [...items(s.userId, 3), ...items(s.userId, 2, "docs")], T0);
    freezeAll(a, T0);
    expect(files(dir).length).toBe(3);
    // A new process that never read alice back: her forget still deletes her blob.
    const b = freezing();
    const { d: d2 } = disk(dir);
    b.persist(d2);
    b.forget(alice);
    expect(files(dir)).not.toContain(d2.nameOf(alice));
    // A source's forget reads the user back, drops the source's items and deletes the blob (a later freeze writes
    // the rest, without the source).
    b.forget(bob, "docs");
    expect(files(dir)).not.toContain(d2.nameOf(bob));
    freezeAll(b, T0);
    expect(files(dir)).toContain(d2.nameOf(bob));
    const c = freezing();
    c.persist(disk(dir).d);
    expect(find(c, bob, "budget", T0).every((i) => i.sourceId === "mail")).toBe(true);
    // A source's removal of one item (`removeItems`) thaws the user: the blob goes.
    const ids = items("carol", 1).map((i) => i.id);
    c.removeItems(carol, ids, T0);
    expect(files(dir)).not.toContain(d2.nameOf(carol));
  });

  test("the directory is bounded: a freeze past maxBytes is not written (reported), and no older blob survives", () => {
    const dir = tempDir();
    const a = freezing();
    const { d, events } = disk(dir, { maxBytes: 2_000 });
    a.persist(d);
    a.put(alice, items("alice", 2), T0);
    a.put(bob, items("bob", 200), T0);
    freezeAll(a, T0);
    expect(files(dir)).toEqual([d.nameOf(alice)]);
    expect(events).toEqual([{ kind: "write-failed", reason: "full" }]);
    expect(d.size).toBeLessThanOrEqual(2_000);
  });

  test("flush writes live users at shutdown; the expiry tick sweeps blobs nobody came back for", () => {
    const dir = tempDir();
    const a = freezing();
    a.persist(disk(dir).d);
    a.put(alice, items("alice", 3), T0);
    expect(a.flush()).toBe(1);
    expect(files(dir).length).toBe(1);
    const b = freezing();
    const { d, events } = disk(dir, { maxAgeMs: 2 * HOUR });
    b.persist(d);
    b.expireIdle(T0 + 3 * HOUR);
    expect(files(dir)).toEqual([]);
    expect(events).toEqual([{ kind: "discarded", reason: "expired" }]);
  });

  test("a warm freeze writes nothing; the compact one writes; a shutdown writes warm users, read back the same (D862)", () => {
    const dir = tempDir();
    // Warm after two idle ticks, compact after five.
    const a = new ItemCache({ warmIdleMs: 1, freezeIdleMs: 5, expireEveryMs: 1 });
    a.close();
    a.persist(disk(dir).d);
    a.put(alice, items("alice", 30), T0, false, false, 5);
    a.put(bob, items("bob", 30), T0, false, false, 5);
    const before = find(a, alice, "quarterly budget review Friday", T0).map((i) => i.id);
    for (let i = 0; i < 3; i++) a.expireIdle(T0);
    expect(a.warmCount).toBe(2);
    expect(files(dir)).toEqual([]);
    // Bob is used again; alice stays idle until she is held compact, and written.
    find(a, bob, "budget", T0);
    for (let i = 0; i < 3; i++) a.expireIdle(T0);
    expect(a.warmCount).toBe(1);
    expect(files(dir).length).toBe(1);
    // A shutdown writes the warm one (bob) too.
    expect(a.flush()).toBe(1);
    expect(files(dir).length).toBe(2);
    const b = freezing();
    b.persist(disk(dir).d);
    expect(find(b, alice, "quarterly budget review Friday", T0).map((i) => i.id)).toEqual(before);
    expect(find(b, bob, "budget", T0).every((i) => i.ref.startsWith("bob"))).toBe(true);
    // Read back from a file: another process's read marks mean nothing here, warm or compact (D425).
    for (const s of [alice, bob]) for (const it of items(s.userId, 30)) expect(b.readMark(s, it.id)).toBe(0);
    expect(b.freezes.loaded).toBe(2);
    expect(files(dir)).toEqual([]);
  });

  // D428: a file lives until its newest item (or probe) expires, not the 7-day cap, even if nothing reads it back.
  test("a file whose items have all expired is deleted by the sweep and at open, and nothing is restored", () => {
    const dir = tempDir();
    const a = freezing();
    const { d } = disk(dir);
    a.persist(d);
    a.put(alice, items("alice", 3), T0); // Lookup items: a 24 h time to live.
    freezeAll(a, T0);
    expect(files(dir).length).toBe(1);
    const b = freezing();
    const { d: d2, events } = disk(dir); // The 7-day cap would keep it.
    b.persist(d2);
    expect(d2.count).toBe(1);
    b.expireIdle(T0 + 23 * HOUR);
    expect(files(dir).length).toBe(1);
    b.expireIdle(T0 + 25 * HOUR);
    expect(files(dir)).toEqual([]);
    expect(events).toEqual([{ kind: "discarded", reason: "expired" }]);
    expect(find(b, alice, "budget", T0 + 25 * HOUR)).toEqual([]);
    expect(b.freezes.loaded).toBe(0);
    // Written with items fetched 26 h ago (expired two hours since): the next process deletes it on opening.
    const OLD = Date.now() - 26 * HOUR;
    const c = freezing();
    c.persist(disk(dir).d);
    c.put(bob, items("bob", 3), OLD);
    freezeAll(c, OLD);
    expect(files(dir).length).toBe(1);
    const e = freezing();
    const { d: d3, events: opened } = disk(dir);
    e.persist(d3);
    expect(opened).toEqual([{ kind: "discarded", reason: "expired" }]);
    expect(files(dir)).toEqual([]);
    expect(find(e, bob, "budget", Date.now())).toEqual([]);
    expect(e.freezes.loaded).toBe(0);
  });

  test("a file with one fresh item survives its older items' expiry, and a synced item keeps it for 7 days", () => {
    const dir = tempDir();
    const a = freezing();
    a.persist(disk(dir).d);
    a.put(alice, items("alice", 3), T0 - 20 * HOUR);
    a.put(alice, items("alice", 1, "docs"), T0); // One fresh lookup item: the file lives to T0 + 24 h.
    a.put(bob, items("bob", 2, "cal"), T0, false, true); // Synced: 7 days.
    freezeAll(a, T0);
    expect(files(dir).length).toBe(2);
    const b = freezing();
    const { d, events } = disk(dir);
    b.persist(d);
    b.expireIdle(T0 + 23 * HOUR); // Alice's older items expired at T0 + 4 h; the fresh one has not.
    expect(files(dir).length).toBe(2);
    expect(events).toEqual([]);
    const back = find(b, alice, "budget", T0 + 23 * HOUR);
    expect(back.map((i) => i.sourceId)).toEqual(["docs"]);
    expect(b.freezes.loaded).toBe(1);
    b.expireIdle(T0 + 6 * 24 * HOUR); // Bob's synced items are within 7 days.
    expect(files(dir)).toEqual([d.nameOf(bob)]);
    b.expireIdle(T0 + 7 * 24 * HOUR + HOUR);
    expect(files(dir)).toEqual([]);
  });

  test("the header's expiry is authenticated: moving it later fails to decrypt, and never passes the age cap", () => {
    const dir = tempDir();
    const a = freezing();
    const { d } = disk(dir);
    a.persist(d);
    a.put(alice, items("alice", 3), T0);
    a.put(bob, items("bob", 3), T0);
    freezeAll(a, T0);
    const header = readFileSync(join(dir, d.nameOf(alice)));
    expect(header.readDoubleLE(24)).toBe(T0 + 24 * HOUR);
    // Alice's expiry moved a day later: the header is in the additional data, so the file does not open.
    header.writeDoubleLE(T0 + 48 * HOUR, 24);
    writeFileSync(join(dir, d.nameOf(alice)), header);
    // Bob's moved a year later: still deleted at the 7-day cap without being decrypted.
    const bPath = join(dir, d.nameOf(bob));
    const bobs = readFileSync(bPath);
    bobs.writeDoubleLE(T0 + 365 * 24 * HOUR, 24);
    writeFileSync(bPath, bobs);
    const b = freezing();
    const { d: d2, events } = disk(dir);
    b.persist(d2);
    expect(events).toEqual([]);
    expect(find(b, alice, "budget", T0)).toEqual([]);
    expect(events).toEqual([{ kind: "discarded", reason: "corrupt" }]);
    b.expireIdle(T0 + 7 * 24 * HOUR + HOUR);
    expect(files(dir)).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: "discarded", reason: "expired" });
  });

  test("a file of the previous format (no expiry in its header) is discarded as another version", () => {
    const dir = tempDir();
    const a = freezing();
    const { d } = disk(dir);
    a.persist(d);
    a.put(alice, items("alice", 2), T0);
    freezeAll(a, T0);
    const path = join(dir, d.nameOf(alice));
    const v = readFileSync(path);
    v.writeUInt16LE(1, 4);
    writeFileSync(path, v);
    expect(disk(dir).events).toEqual([{ kind: "discarded", reason: "version" }]);
    expect(files(dir)).toEqual([]);
  });
});

/** A connector with a recent-first list call; every call counted. */
class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  lists = 0;
  searches = 0;
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
    this.searches++;
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

function partnerOver(src: Source, cache: ItemCache, clock: () => number): ContextPartner {
  return new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: clock,
    config: { sync: true, syncPageSize: 2, syncCallsPerMin: 6_000 },
  });
}

const say = (p: ContextPartner, text: string, at: number) =>
  p.observe({ ...alice, sessionId: "s1", at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });

describe("a restart with persisted users (D425)", () => {
  test("the sync's state comes back: the restarted user polls, not backfills, and the fact is still delivered", async () => {
    const dir = tempDir();
    let clock = T0;
    const now = () => clock;
    const src = new ListSource("mail", 20);
    const a = freezing();
    a.persist(disk(dir).d);
    const p1 = partnerOver(src, a, now);
    p1.sync!.track(alice);
    // The clock moves a second a tick: the fan-out's rate limit refills on it.
    for (let i = 0; i < 100 && !p1.sync!.warm(alice); i++, clock += 1_000) await p1.sync!.tick();
    const backfill = src.lists;
    expect(backfill).toBe(10);
    freezeAll(a, clock);
    expect(files(dir).length).toBe(1);

    // The restart, without persistence: a backfill again.
    const cold = new ListSource("mail", 20);
    const p0 = partnerOver(cold, freezing(), now);
    await say(p0, "Dana Lee budget review: when is it?", clock);
    for (let i = 0; i < 100 && !p0.sync!.warm(alice); i++, clock += 1_000) await p0.sync!.tick();
    expect(cold.lists).toBeGreaterThanOrEqual(10);

    // With it: the user thaws from disk on the first event, the sync is warm, one poll.
    clock += 5 * 60_000;
    src.lists = 0;
    const b = freezing();
    const { d } = disk(dir);
    b.persist(d);
    const p2 = partnerOver(src, b, now);
    const r = await say(p2, "Dana Lee budget review: when is it?", clock);
    await p2.sync!.tick();
    expect(b.freezes.loaded).toBe(1);
    expect(p2.sync!.warm(alice)).toBe(true);
    expect(src.lists).toBeLessThanOrEqual(2);
    const got = [r.injection, ...p2.takePending({ ...alice, sessionId: "s1" })].flatMap(
      (x) => x?.citations.map((c) => c.itemId) ?? [],
    );
    expect(got).toContain(itemId("mail", "m0"));
    // And the partner's forget reaches the disk: frozen again, then forgotten.
    freezeAll(b, clock);
    expect(files(dir).length).toBe(1);
    p2.forget(alice);
    expect(files(dir)).toEqual([]);
  });

  test("a source the user no longer has: the sync drops its items, which thaws the user and deletes the blob", async () => {
    const dir = tempDir();
    const clock = T0;
    const mail = new ListSource("mail", 6);
    const docs = new ListSource("docs", 6);
    let sources: Source[] = [mail, docs];
    const a = freezing();
    const { d } = disk(dir);
    a.persist(d);
    const p = new ContextPartner({
      sources: async () => sources,
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: a,
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { sync: true, syncPageSize: 2, syncCallsPerMin: 6_000 },
    });
    p.sync!.track(alice);
    while (!p.sync!.warm(alice)) await p.sync!.tick();
    freezeAll(a, clock);
    expect(files(dir)).toEqual([d.nameOf(alice)]);
    sources = [mail];
    await p.sync!.tick();
    expect(files(dir)).toEqual([]);
    expect(find(a, alice, "quarterly plan", clock).some((i) => i.sourceId === "docs")).toBe(false);
  });

  test("a restored notifying source's copies are in doubt from the first event, before any poll (review of C3)", async () => {
    const dir = tempDir();
    let clock = T0;
    const src = Object.assign(new ListSource("mail", 6), { notifies: true });
    const a = freezing();
    a.persist(disk(dir).d);
    const p1 = partnerOver(src, a, () => clock);
    p1.sync!.track(alice);
    for (let i = 0; i < 50 && !p1.sync!.warm(alice); i++, clock += 1_000) await p1.sync!.tick();
    const id = itemId("mail", "m0");
    expect(p1.sync!.signalledSince(alice, "mail", a.readMark(alice, id)!)).toBe(false);
    freezeAll(a, clock);
    const b = freezing();
    b.persist(disk(dir).d);
    const p2 = partnerOver(src, b, () => clock);
    await p2.ready(alice);
    expect(b.readMark(alice, id)).toBe(0);
    expect(p2.sync!.signalledSince(alice, "mail", 0)).toBe(true);
  });

  test("a source removed while the user was on disk: its items are gone before the first event is served", async () => {
    const dir = tempDir();
    let clock = T0;
    const mail = new ListSource("mail", 4);
    const docs = new ListSource("docs", 4);
    const a = freezing();
    a.persist(disk(dir).d);
    const p1 = new ContextPartner({
      sources: async () => [mail, docs],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: a,
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { sync: true, syncPageSize: 2, syncCallsPerMin: 6_000 },
    });
    p1.sync!.track(alice);
    for (let i = 0; i < 50 && !p1.sync!.warm(alice); i++, clock += 1_000) await p1.sync!.tick();
    expect(a.isSynced(alice, itemId("docs", "m0"))).toBe(true);
    freezeAll(a, clock);
    // The restart: the user's docs connector was removed meanwhile.
    const b = freezing();
    b.persist(disk(dir).d);
    const p2 = partnerOver(mail, b, () => clock);
    await p2.ready(alice);
    expect(b.isSynced(alice, itemId("docs", "m0"))).toBe(false);
    expect(b.isSynced(alice, itemId("mail", "m0"))).toBe(true);
    expect(find(b, alice, "quarterly plan", clock).some((i) => i.sourceId === "docs")).toBe(false);
  });

  test("a user read back outside `ready` (a removal): a later `ready` still waits for the removed source's drop", async () => {
    const dir = tempDir();
    let clock = T0;
    const mail = new ListSource("mail", 4);
    const docs = new ListSource("docs", 4);
    const a = freezing();
    a.persist(disk(dir).d);
    const p1 = new ContextPartner({
      sources: async () => [mail, docs],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: a,
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { sync: true, syncPageSize: 2, syncCallsPerMin: 6_000 },
    });
    p1.sync!.track(alice);
    for (let i = 0; i < 50 && !p1.sync!.warm(alice); i++, clock += 1_000) await p1.sync!.tick();
    freezeAll(a, clock);
    const b = freezing();
    b.persist(disk(dir).d);
    // A resolver that answers late: the docs connector is gone.
    const p2 = new ContextPartner({
      sources: async () => {
        await Bun.sleep(50);
        return [mail];
      },
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: b,
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { sync: true, syncPageSize: 2, syncCallsPerMin: 6_000 },
    });
    b.removeItems(alice, [itemId("mail", "m3")], clock); // Reads the user back synchronously.
    const waiting = p2.ready(alice);
    expect(waiting).not.toBeNull();
    await waiting;
    expect(b.isSynced(alice, itemId("docs", "m0"))).toBe(false);
  });

  test("a connector's page token the secret gate would change is not saved (D10)", async () => {
    let clock = T0;
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    class Tokened extends ListSource {
      override async list(scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
        const page = await super.list(scope, cursor?.split("|")[1], limit);
        return { items: page.items, next: page.next === null ? null : `${token}|${page.next}` };
      }
    }
    const p = partnerOver(new Tokened("mail", 40), freezing(), () => clock);
    p.sync!.track(alice);
    await p.sync!.tick();
    const snap = p.sync!.snapshot(alice)!;
    expect(snap.sources[0]!.phase).toBe("backfill");
    expect(JSON.stringify(snap)).not.toContain("ghp_");
    expect(snap.sources[0]!.cursor).toBeNull();
    clock += 1;
  });
});
