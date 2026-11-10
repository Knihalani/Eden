/**
 * Frozen users on disk only (`persistDiskOnly`, D652, a trial; needs D425's disk): a frozen user written to disk
 * keeps no copy of the blob in memory and is read back at the thaw, to the same answers; a write that failed keeps
 * the memory's copy; a file that does not open leaves the user empty, tells the owner, and the sync starts over;
 * users never see each other's files (D9).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { EncryptedFrozenDisk, type PersistEvent } from "./persist";
import { termIds } from "./text";

const HOUR = 3_600_000;
const T0 = Date.now() - HOUR; // Wall-clock based: the store dates its blobs on the cache's clock.
const KEY = new Uint8Array(32).map((_, i) => i + 1);
const alice: Scope = { tenantId: "t", userId: "alice" };
const bob: Scope = { tenantId: "t", userId: "bob" };
const carol: Scope = { tenantId: "u", userId: "alice" }; // Same user id, another tenant.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "eden-disk-only-"));
  dirs.push(d);
  return d;
}

function disk(dir: string, maxBytes = 64 * 1_048_576) {
  const events: PersistEvent[] = [];
  const d = new EncryptedFrozenDisk({
    dir,
    key: KEY,
    maxBytes,
    maxAgeMs: 7 * 24 * HOUR,
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

function find(c: ItemCache, s: Scope, q: string, now: number): ContextItem[] {
  const vocab = c.peekVocab(s);
  if (!vocab) return [];
  const { ids, n } = termIds(q, vocab, false);
  return c.search(s, Array.from(ids.subarray(0, n)), n, 50, now).map((h) => h.item);
}
const files = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".blob"));
const Q = "quarterly budget review Friday";

describe("frozen users on disk only (D652)", () => {
  test("off unless asked: with persistence alone the memory's copy stays, and a deleted file loses nothing", () => {
    const dir = tempDir();
    const c = freezing();
    c.persist(disk(dir).d);
    c.put(alice, items("alice", 12), T0);
    const before = find(c, alice, Q, T0).map((i) => i.id);
    freezeAll(c, T0);
    expect(c.freezes.released).toBe(0);
    for (const f of files(dir)) rmSync(join(dir, f));
    expect(find(c, alice, Q, T0).map((i) => i.id)).toEqual(before);
    expect(c.freezes.lost).toBe(0);
  });

  test("a disk-only user thaws from the file to the same answers, text and order; the file goes; a freeze writes again", () => {
    const dir = tempDir();
    const c = freezing();
    c.persist(disk(dir).d, { diskOnly: true });
    c.put(alice, items("alice", 40), T0);
    const revision = c.revision(alice);
    const before = find(c, alice, Q, T0).map((i) => [i.id, i.title, i.text]);
    freezeAll(c, T0);
    expect(c.frozenCount).toBe(1);
    expect(c.freezes.released).toBe(1);
    expect(c.frozenBytes).toBeGreaterThan(0); // The size is still reported; the bytes are on disk.
    expect(files(dir).length).toBe(1);
    // A frozen user's counts are read without a thaw, on disk only or not.
    expect(c.revision(alice)).toBe(revision);
    expect(c.frozenCount).toBe(1);

    expect(find(c, alice, Q, T0).map((i) => [i.id, i.title, i.text])).toEqual(before);
    expect(c.revision(alice)).toBe(revision);
    expect(c.freezes.lost).toBe(0);
    expect(files(dir)).toEqual([]);

    c.put(alice, items("alice", 2, "notes"), T0 + 1);
    freezeAll(c, T0 + 2);
    expect(c.freezes.released).toBe(2);
    expect(files(dir).length).toBe(1);
    expect(find(c, alice, Q, T0 + 3).length).toBe(before.length + 2);
  });

  test("a write that fails keeps the blob in memory: the user thaws as before", () => {
    const dir = tempDir();
    const { d, events } = disk(dir, 64); // 64 bytes: no blob fits.
    const c = freezing();
    c.persist(d, { diskOnly: true });
    c.put(alice, items("alice", 10), T0);
    const before = find(c, alice, Q, T0).map((i) => i.id);
    freezeAll(c, T0);
    expect(events.some((e) => e.kind === "write-failed")).toBe(true);
    expect(c.freezes.released).toBe(0);
    expect(files(dir)).toEqual([]);
    expect(find(c, alice, Q, T0).map((i) => i.id)).toEqual(before);
  });

  test("a file that is gone or does not open: the user is empty, the owner is told once, and puts work again", () => {
    for (const damage of ["deleted", "tampered"] as const) {
      const dir = tempDir();
      const { d, events } = disk(dir);
      const c = freezing();
      c.persist(d, { diskOnly: true });
      const dropped: Array<string[] | null> = [];
      const lost: Scope[] = [];
      c.onDropped((_s, ids) => dropped.push(ids));
      c.persistHooks = { save: () => null, restored: () => {}, lost: (s) => lost.push(s) };
      c.put(alice, items("alice", 10), T0);
      c.put(bob, items("bob", 3), T0);
      freezeAll(c, T0);
      dropped.length = 0;
      expect(files(dir).length).toBe(2);
      // Both users' files are there; damage every one, then read alice only.
      for (const f of files(dir)) {
        if (damage === "deleted") rmSync(join(dir, f));
        else writeFileSync(join(dir, f), Buffer.concat([readFileSync(join(dir, f)), Buffer.from([1])]));
      }
      expect(find(c, alice, Q, T0)).toEqual([]);
      expect(c.freezes.lost).toBe(1);
      expect(lost).toEqual([alice]);
      expect(dropped).toEqual([null]);
      if (damage === "tampered") expect(events.some((e) => e.kind === "discarded")).toBe(true);
      // Held, empty, usable.
      c.put(alice, items("alice", 2), T0 + 1);
      expect(find(c, alice, Q, T0 + 1).length).toBe(2);
      expect(c.freezes.lost).toBe(1);
    }
  });

  test("a user whose items all expired is dropped as any expired user: no read, not counted lost", () => {
    const dir = tempDir();
    const c = freezing();
    c.persist(disk(dir).d, { diskOnly: true });
    const lost: Scope[] = [];
    c.persistHooks = { save: () => null, restored: () => {}, lost: (s) => lost.push(s) };
    c.put(alice, items("alice", 5), T0);
    freezeAll(c, T0);
    expect(c.freezes.released).toBe(1);
    c.expireIdle(T0 + 8 * 24 * HOUR);
    expect(c.freezes.lost).toBe(0);
    expect(lost).toEqual([]);
    expect(c.frozenCount).toBe(0);
    expect(files(dir)).toEqual([]);
    expect(find(c, alice, Q, T0 + 8 * 24 * HOUR)).toEqual([]);
  });

  test("forgetting a disk-only user deletes the file and counts nothing lost", () => {
    const dir = tempDir();
    const c = freezing();
    c.persist(disk(dir).d, { diskOnly: true });
    c.put(alice, items("alice", 5), T0);
    c.put(bob, items("bob", 5), T0);
    freezeAll(c, T0);
    expect(files(dir).length).toBe(2);
    c.forget(alice);
    expect(files(dir).length).toBe(1);
    expect(c.freezes.lost).toBe(0);
    expect(find(c, alice, Q, T0)).toEqual([]);
    expect(find(c, bob, Q, T0).length).toBe(5);
  });

  test("isolation: each disk-only user thaws their own items; another user's file under their name does not open", () => {
    const dir = tempDir();
    const c = freezing();
    c.persist(disk(dir).d, { diskOnly: true });
    c.put(alice, items("alice", 6), T0);
    freezeAll(c, T0);
    const [aliceFile] = files(dir);
    c.put(carol, items("carol", 6), T0);
    freezeAll(c, T0);
    const carolFile = files(dir).find((f) => f !== aliceFile)!;
    expect(carolFile).toBeDefined();
    // Carol's file copied over alice's name: bound to its tenant and user, it does not open as alice's.
    copyFileSync(join(dir, carolFile), join(dir, aliceFile!));
    expect(find(c, alice, Q, T0)).toEqual([]);
    expect(c.freezes.lost).toBe(1);
    const got = find(c, carol, Q, T0);
    expect(got.length).toBe(6);
    for (const it of got) expect(it.text).toContain("carol");
  });
});

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
const cited = (p: ContextPartner, r: Awaited<ReturnType<typeof say>>) =>
  [r.injection, ...p.takePending({ ...alice, sessionId: "s1" })].flatMap(
    (x) => x?.citations.map((c) => c.itemId) ?? [],
  );

describe("the partner over a disk-only user (D652)", () => {
  test("a returning disk-only user is served from the file with the sync still warm: no backfill", async () => {
    const dir = tempDir();
    let clock = T0;
    const src = new ListSource("mail", 20);
    const c = freezing();
    c.persist(disk(dir).d, { diskOnly: true });
    const p = partnerOver(src, c, () => clock);
    p.sync!.track(alice);
    for (let i = 0; i < 100 && !p.sync!.warm(alice); i++, clock += 1_000) await p.sync!.tick();
    const backfill = src.lists;
    freezeAll(c, clock);
    expect(c.freezes.released).toBe(1);

    clock += 5 * 60_000;
    src.lists = 0;
    const r = await say(p, "Dana Lee budget review: when is it?", clock);
    await p.sync!.tick();
    expect(c.freezes.lost).toBe(0);
    expect(p.sync!.warm(alice)).toBe(true);
    expect(src.lists).toBeLessThan(backfill);
    expect(cited(p, r)).toContain(itemId("mail", "m0"));
  });

  test("a disk-only user whose file is gone is synced again from the start, and the fact is delivered again", async () => {
    const dir = tempDir();
    let clock = T0;
    const src = new ListSource("mail", 20);
    const c = freezing();
    c.persist(disk(dir).d, { diskOnly: true });
    const p = partnerOver(src, c, () => clock);
    p.sync!.track(alice);
    for (let i = 0; i < 100 && !p.sync!.warm(alice); i++, clock += 1_000) await p.sync!.tick();
    const backfill = src.lists;
    freezeAll(c, clock);
    for (const f of files(dir)) rmSync(join(dir, f));

    clock += 5 * 60_000;
    src.lists = 0;
    await say(p, "anything new today?", clock);
    expect(c.freezes.lost).toBe(1);
    for (let i = 0; i < 100 && !p.sync!.warm(alice); i++, clock += 1_000) await p.sync!.tick();
    expect(p.sync!.warm(alice)).toBe(true);
    expect(src.lists).toBeGreaterThanOrEqual(backfill);
    expect(c.syncedCount(alice)).toBe(20);
    const r = await p.observe(
      {
        ...alice,
        sessionId: "s2",
        at: clock,
        kind: "user_message",
        text: "Dana Lee budget review: when is it?",
      } as AgentEvent,
      { waitMs: 2_000 },
    );
    const got = [r.injection, ...p.takePending({ ...alice, sessionId: "s2" })].flatMap(
      (x) => x?.citations.map((c2) => c2.itemId) ?? [],
    );
    expect(got).toContain(itemId("mail", "m0"));
  });
});
