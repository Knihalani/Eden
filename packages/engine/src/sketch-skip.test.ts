/**
 * D1927: the sync's store skips adding the words of an item whose held copy is the very object listed and whose words
 * it added under the stamp still current (`SyncManager.stampOf`, `Entry.stamp`). The skip must change nothing: two
 * engines, one skipping and one adding every listed item's words as before (`SyncManager.resketchForTests`), are
 * driven through the same seeded sequences of backfills, sweeps, polls, edits, deletions, sketch saturation and
 * restarts, forgotten sources and users, warm and compact freezes and restarts through the encrypted store, and must
 * hold the same sketch bits and rare-word tables (the sync's snapshot), read the same routing from them and answer the
 * same. The invariants the skip rests on (a term or word added in the current epoch is added again for nothing) are
 * checked on `TermSketch` and `RareTerms` alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { EncryptedFrozenDisk } from "./persist";
import { RareTerms } from "./rare-terms";
import { secondHash, termHash, termHashes, TermSketch } from "./sketch";
import { SyncManager } from "./sync";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEY = new Uint8Array(32).map((_, i) => i + 7);

const dirs: string[] = [];
afterEach(() => {
  SyncManager.resketchForTests = false;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

/** A word of letters only (the sketch keeps no word with a figure), never a stopword: a `q` and a `z` in each. */
function word(n: number): string {
  let s = "";
  do {
    s += String.fromCharCode(97 + (n % 26));
    n = Math.floor(n / 26);
  } while (n > 0);
  return `qz${s}`;
}

/** A connector listing newest first; its items change between calls as the test edits them. */
class Mutable implements Source {
  readonly kind = "test";
  readonly description = "test";
  items: ContextItem[] = [];
  constructor(readonly id: string) {}
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w))).slice(0, 5);
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

const USERS: Scope[] = [
  { tenantId: "t1", userId: "ann" },
  { tenantId: "t1", userId: "bo" },
  { tenantId: "t2", userId: "ann" }, // Same user id, another tenant.
];
const SOURCE_IDS = ["mail", "docs", "crm"];

/** One engine: its own sources (the same edits as the other's), cache, disk and partner. */
interface Engine {
  resketch: boolean;
  dir: string;
  sources: Map<string, Mutable[]>;
  cache: ItemCache;
  partner: ContextPartner;
}

describe("the sync's store skips re-adding unchanged items' words (D1927)", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`seed ${seed}: identical sketches, rare-word tables, routing and answers to the engine that re-adds all`, async () => {
      const r = rng(seed);
      let clock = Date.now();
      const now = () => clock;
      let fresh = 50_000 * seed; // Words no item had yet.
      const vocab = 400;
      const text = (n: number) => Array.from({ length: n }, () => word(Math.floor(r() * vocab))).join(" ");

      // The same items for both engines, as plain data each engine's sources copy.
      type Doc = { ref: string; title: string; text: string; at: number };
      const docs = new Map<string, Doc[]>(); // `${userKey}|${source}` → docs
      const listed = new Map<string, string[]>(); // userKey → source ids the user has
      const key = (s: Scope) => `${s.tenantId}/${s.userId}`;
      for (const s of USERS) {
        listed.set(key(s), [...SOURCE_IDS]);
        for (const src of SOURCE_IDS) {
          const n = 4 + Math.floor(r() * 10);
          docs.set(
            `${key(s)}|${src}`,
            Array.from({ length: n }, (_, i) => ({
              ref: `${src}${i}`,
              title: `${word(i)} ${text(1)}`,
              text: text(5 + Math.floor(r() * 20)),
              at: clock - i * HOUR - Math.floor(r() * HOUR),
            })),
          );
        }
      }
      let nextRef = 1_000;

      const syncSources = (e: Engine) => {
        for (const s of USERS) {
          const have = e.sources.get(key(s)) ?? [];
          const out: Mutable[] = [];
          for (const id of listed.get(key(s))!) {
            const m = have.find((x) => x.id === id) ?? new Mutable(id);
            // Fresh objects each time, as a connector's reply is: the store sees an unchanged item only through the
            // listing's reuse of the held copy.
            m.items = docs
              .get(`${key(s)}|${id}`)!
              .map((d) => ({
                id: itemId(id, d.ref),
                sourceId: id,
                ref: d.ref,
                title: d.title,
                text: d.text,
                updatedAt: d.at,
              }));
            out.push(m);
          }
          e.sources.set(key(s), out);
        }
      };

      const makeCache = () => {
        // Expiry ticks run by hand: two idle ticks freeze warm, four compact.
        const c = new ItemCache({ expireEveryMs: 1, warmIdleMs: 2, freezeIdleMs: 4 });
        c.close();
        return c;
      };
      const makePartner = (e: Engine) => {
        const disk = new EncryptedFrozenDisk({ dir: e.dir, key: KEY, maxBytes: 64 << 20, maxAgeMs: 365 * DAY });
        e.cache.persist(disk);
        SyncManager.resketchForTests = e.resketch;
        const p = new ContextPartner({
          sources: async (s) => e.sources.get(key(s)) ?? [],
          sourceMap: new SourceMap(":memory:", { seed: 1 }),
          cache: e.cache,
          budget: new Budget(),
          model: null,
          now,
          after: () => () => {},
          config: { syncMaxItems: 18, syncPageSize: 3, syncPollPageSize: 2, syncCallsPerMin: 1e6 },
        });
        SyncManager.resketchForTests = false;
        return p;
      };
      const engine = (resketch: boolean): Engine => {
        const dir = mkdtempSync(join(tmpdir(), "eden-sketch-skip-"));
        dirs.push(dir);
        const e = { resketch, dir, sources: new Map(), cache: makeCache() } as unknown as Engine;
        syncSources(e);
        e.partner = makePartner(e);
        return e;
      };
      const engines = [engine(false), engine(true)] as const;
      const skipped = [0, 0]; // Across restarts (each engine's sync counts its own).

      const settle = async (e: Engine) => {
        for (let i = 0; i < 4; i++) {
          for (const s of USERS) await e.partner.sync!.kicked(s);
          await new Promise((res) => setTimeout(res, 0));
        }
      };
      const ticks = async (e: Engine, n: number) => {
        for (let i = 0; i < n; i++) {
          for (const s of USERS) e.partner.sync!.track(s, clock);
          await e.partner.sync!.tick();
          await settle(e);
        }
      };
      const probe = Array.from({ length: 40 }, (_, i) => termHashes(i < 30 ? word(i * 13) : word(fresh + i)));
      const state = (e: Engine) =>
        USERS.map((s) => {
          const sync = e.partner.sync!;
          const snap = sync.snapshot(s);
          const scores = sync.sketchScores(s, probe);
          return JSON.stringify({
            snap,
            scores: scores ? [...scores].sort() : null,
            rare: [...sync.rareHolders(s, probe, 2)].sort(),
            synced: e.cache.syncedCount(s),
          });
        });
      const compare = async (what: string) => {
        const [a, b] = engines.map(state);
        expect(a, what).toEqual(b!);
      };

      const ops = [
        "tick",
        "sweep",
        "edit",
        "add",
        "old",
        "delete",
        "flood",
        "drop-source",
        "forget-source",
        "forget-user",
        "warm",
        "compact",
        "restart",
        "ask",
      ] as const;
      for (const e of engines) await ticks(e, 12);
      await compare("after the backfill");
      for (let step = 0; step < 60; step++) {
        const op = ops[Math.floor(r() * ops.length)]!;
        const s = USERS[Math.floor(r() * USERS.length)]!;
        const have = listed.get(key(s))!;
        const src = have[Math.floor(r() * have.length)];
        const list = src ? docs.get(`${key(s)}|${src}`)! : [];
        let n = 2;
        switch (op) {
          case "tick":
            clock += 10 * 60_000;
            break;
          case "sweep":
            clock += DAY + HOUR;
            n = 6;
            break;
          case "edit":
            if (list.length > 0) list[Math.floor(r() * list.length)]!.text = text(10);
            break;
          case "add":
            if (src) list.push({ ref: `${src}${nextRef++}`, title: text(2), text: text(12), at: clock - 60_000 });
            break;
          case "old":
            // Older than everything held: past the cut, listed and sketched but not stored.
            if (src) list.push({ ref: `${src}${nextRef++}`, title: text(2), text: text(12), at: clock - 400 * DAY });
            break;
          case "delete":
            if (list.length > 1) list.splice(Math.floor(r() * list.length), 1);
            clock += DAY + HOUR;
            n = 6;
            break;
          case "flood": {
            // Hundreds of words no item had: a folded sketch saturates and restarts.
            if (src) {
              const words = Array.from({ length: 700 }, () => word(fresh++)).join(" ");
              list.push({ ref: `${src}${nextRef++}`, title: "flood", text: words, at: clock - 30_000 });
            }
            clock += DAY + HOUR;
            n = 6;
            break;
          }
          case "drop-source":
            if (src && have.length > 1) have.splice(have.indexOf(src), 1);
            break;
          case "forget-source":
            if (src) for (const e of engines) e.partner.forget(s, src);
            break;
          case "forget-user":
            for (const e of engines) e.partner.forget(s);
            break;
          case "warm":
          case "compact":
            for (const e of engines) for (let t = 0; t < (op === "warm" ? 2 : 4); t++) e.cache.expireIdle(clock);
            n = 0;
            break;
          case "restart":
            // Every user on disk, then a new cache and engine over the same files (D425).
            for (const [i, e] of engines.entries()) {
              for (let t = 0; t < 4; t++) e.cache.expireIdle(clock);
              e.cache.flush();
              skipped[i]! += e.partner.sync!.stats.sketchSkipped;
              e.partner.stopSync();
              e.cache = makeCache();
              e.partner = makePartner(e);
            }
            break;
          case "ask":
            break;
        }
        // A source the user no longer has comes back now and then, from its first page.
        if (op === "add" && have.length < SOURCE_IDS.length && r() < 0.3) {
          have.push(SOURCE_IDS.find((x) => !have.includes(x))!);
        }
        for (const e of engines) syncSources(e);
        for (const e of engines) await ticks(e, n);
        if (op === "ask") {
          const q = `What about ${word(Math.floor(r() * vocab))} and ${word(Math.floor(r() * vocab))}?`;
          const out: string[] = [];
          for (const e of engines) {
            const got = await e.partner.observe(
              { ...s, sessionId: "s1", at: clock, kind: "user_message", text: q } as AgentEvent,
              { waitMs: 2_000 },
            );
            await settle(e);
            out.push(JSON.stringify(got.injection?.citations.map((c) => c.itemId) ?? null));
          }
          expect(out[0], `answers at step ${step}`).toBe(out[1]!);
        }
        await compare(`after step ${step} (${op})`);
      }
      // The skip ran: unchanged copies were not sketched again, and the oracle never skips.
      expect(skipped[0]! + engines[0].partner.sync!.stats.sketchSkipped).toBeGreaterThan(0);
      expect(skipped[1]! + engines[1].partner.sync!.stats.sketchSkipped).toBe(0);
    }, 60_000);
  }

  test("a stamp survives a warm and a compact freeze in memory, not a thaw from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sketch-skip-"));
    dirs.push(dir);
    let clock = Date.now();
    const src = new Mutable("mail");
    src.items = Array.from({ length: 6 }, (_, i) => ({
      id: itemId("mail", `m${i}`),
      sourceId: "mail",
      ref: `m${i}`,
      title: `Note ${i}`,
      text: `quarterly plan review number ${word(i)}`,
      updatedAt: clock - i * HOUR,
    }));
    const scope: Scope = { tenantId: "t", userId: "u" };
    const make = () => {
      const cache = new ItemCache({ expireEveryMs: 1, warmIdleMs: 2, freezeIdleMs: 4 });
      cache.close();
      cache.persist(new EncryptedFrozenDisk({ dir, key: KEY, maxBytes: 64 << 20, maxAgeMs: 365 * DAY }));
      const partner = new ContextPartner({
        sources: async () => [src],
        sourceMap: new SourceMap(":memory:", { seed: 1 }),
        cache,
        budget: new Budget(),
        model: null,
        now: () => clock,
        after: () => () => {},
        config: { syncPageSize: 2, syncCallsPerMin: 1e6 },
      });
      return { cache, partner };
    };
    const sweep = async (p: ContextPartner) => {
      clock += DAY + HOUR;
      for (let i = 0; i < 6; i++) {
        p.sync!.track(scope, clock);
        await p.sync!.tick();
      }
    };
    let { cache, partner } = make();
    for (let i = 0; i < 6; i++) {
      partner.sync!.track(scope, clock);
      await partner.sync!.tick();
    }
    await sweep(partner);
    const after1 = partner.sync!.stats.sketchSkipped;
    expect(after1).toBe(6);
    for (const ticks of [2, 4]) {
      for (let t = 0; t < ticks; t++) cache.expireIdle(clock);
      const before = partner.sync!.stats.sketchSkipped;
      await sweep(partner);
      expect(partner.sync!.stats.sketchSkipped - before).toBe(6);
    }
    // A restart: the sketch is read back from disk (a new epoch) and the entries carry no stamp, so every item's
    // words are added again once, then skipped.
    for (let t = 0; t < 4; t++) cache.expireIdle(clock);
    cache.flush();
    ({ cache, partner } = make());
    await sweep(partner);
    expect(cache.freezes.loaded).toBe(1);
    expect(partner.sync!.stats.sketchSkipped).toBe(0);
    await sweep(partner);
    expect(partner.sync!.stats.sketchSkipped).toBe(6);
  });

  test("a saturated sketch is never skipped past: its next add restarts it, whichever item that is", async () => {
    // One small source, folded to the smallest sketch by its backfill; then a day at a time one new item of one word
    // no item had, and a sweep reading the whole listing in one page: the new item first, every unchanged (stamped)
    // one after it. The add that saturates the sketch is the new item's (in the sweep or the poll before it), so the
    // unchanged item next must be added again: that add restarts the sketch, as before.
    let clock = Date.now();
    const scope: Scope = { tenantId: "t", userId: "u" };
    const make = (resketch: boolean) => {
      const src = new Mutable("mail");
      const cache = new ItemCache({ expireEveryMs: 0 });
      SyncManager.resketchForTests = resketch;
      const partner = new ContextPartner({
        sources: async () => [src],
        sourceMap: new SourceMap(":memory:", { seed: 1 }),
        cache,
        budget: new Budget(),
        model: null,
        now: () => clock,
        after: () => () => {},
        config: { syncPageSize: 1_000, syncPollPageSize: 2, syncCallsPerMin: 1e6 },
      });
      SyncManager.resketchForTests = false;
      return { src, partner };
    };
    const engines = [make(false), make(true)];
    const items: ContextItem[] = [];
    const add = (title: string, text: string) =>
      items.push({
        id: itemId("mail", `m${items.length}`),
        sourceId: "mail",
        ref: `m${items.length}`,
        title,
        text,
        updatedAt: clock,
      });
    add("Note", "quarterly plan");
    let restarts = 0;
    let bytes = 0;
    for (let i = 0; i < 700 && restarts < 2; i++) {
      for (const e of engines) {
        e.src.items = items.map((x) => ({ ...x }));
        e.partner.sync!.track(scope, clock);
        await e.partner.sync!.tick();
      }
      const [a, b] = engines.map((e) => JSON.stringify(e.partner.sync!.snapshot(scope)?.sources[0]?.sketch));
      expect(a, `step ${i}`).toBe(b!);
      const now = (engines[1]!.partner.sync!.snapshot(scope)?.sources[0]?.sketch as { bits: string } | null)?.bits;
      if (now && now.length > bytes && bytes > 0) restarts++;
      if (now) bytes = now.length;
      clock += DAY + HOUR; // A sweep each step: the new item first, then every unchanged one.
      add(word(90_000 + i), "");
    }
    expect(restarts).toBeGreaterThan(0);
    expect(engines[0]!.partner.sync!.stats.sketchSkipped).toBeGreaterThan(0);
  });

  test("a stamp is per user and source: another user's identical items, or another source's sketch, never match", () => {
    // Stamps come from one process-wide counter: two sources' or users' stamps never coincide.
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const t = new TermSketch();
      const rare = new RareTerms();
      expect(seen.has(t.epoch)).toBe(false);
      expect(seen.has(rare.epoch)).toBe(false);
      seen.add(t.epoch);
      seen.add(rare.epoch);
    }
  });
});

describe("the invariants the skip rests on", () => {
  test("TermSketch: a term added in the current epoch, added again while not saturated, changes no bit", () => {
    const r = rng(9);
    const t = new TermSketch();
    let epoch = t.epoch;
    let held: [number, number][] = [];
    for (let i = 0; i < 40_000; i++) {
      const h1 = termHash(word(Math.floor(r() * 30_000)));
      const pair: [number, number] = [h1, secondHash(h1)];
      if (r() < 0.002) t.fold();
      t.add(pair[0], pair[1]);
      if (t.epoch !== epoch) {
        epoch = t.epoch;
        held = [];
      }
      held.push(pair);
      if (i % 500 === 0 && !t.saturated) {
        const before = JSON.stringify(t.dump());
        for (const [a, b] of held) t.add(a, b);
        expect(t.epoch).toBe(epoch);
        expect(JSON.stringify(t.dump())).toBe(before);
        for (const [a, b] of held) expect(t.has(a, b)).toBe(true);
      }
    }
  });

  test("TermSketch: a saturated sketch restarts at the next add, with a new epoch", () => {
    const t = new TermSketch();
    t.fold(); // Empty: folds to the smallest size.
    const e0 = t.epoch;
    for (let i = 0; !t.saturated; i++) t.add(...termHashes(word(i)));
    expect(t.epoch).toBe(e0);
    t.add(...termHashes(word(0)));
    expect(t.epoch).not.toBe(e0);
  });

  test("RareTerms: words added in the current epoch, added again, write nothing, up to and past a full table", () => {
    const r = rng(11);
    const rare = new RareTerms();
    const sources = Array.from({ length: 6 }, (_, i) => `s${i}`);
    let epoch = rare.epoch;
    let held: [string, number, number][] = [];
    // About 300,000 distinct words over six sources: past the table's 1 MB, so words are dropped.
    for (let i = 0; i < 360_000; i++) {
      const src = sources[Math.floor(r() * sources.length)]!;
      const h1 = termHash(word(Math.floor(r() * 300_000)));
      const h2 = secondHash(h1);
      if (r() < 0.00002) rare.forgetSource(sources[Math.floor(r() * sources.length)]!);
      const before = rare.epoch;
      rare.add(src, h1, h2);
      if (rare.epoch !== epoch) {
        // A word dropped, or a source forgotten: what was added before may be added for something again.
        epoch = rare.epoch;
        held = [];
        if (rare.epoch !== before) continue; // This very word was not kept.
      }
      held.push([src, h1, h2]);
      if (i % 90_000 === 0 || i === 359_999) {
        const dump = JSON.stringify(rare.dump());
        const dropped = rare.dropped;
        for (const [s, a, b] of held) rare.add(s, a, b);
        expect(rare.epoch).toBe(epoch);
        expect(rare.dropped).toBe(dropped);
        expect(JSON.stringify(rare.dump())).toBe(dump);
      }
    }
    expect(rare.dropped).toBeGreaterThan(0);
  });

  test("RareTerms: a renumbering and a forgotten source each start a new epoch", () => {
    const rare = new RareTerms();
    const e0 = rare.epoch;
    rare.forgetSource("nobody");
    expect(rare.epoch).toBe(e0);
    rare.add("a", ...termHashes("qzword"));
    rare.forgetSource("a");
    expect(rare.epoch).not.toBe(e0);
    const e1 = rare.epoch;
    // 4,094 numbers: the next new source takes back the forgotten one's by renumbering.
    for (let i = 0; i < 4_093; i++) rare.add(`s${i}`, ...termHashes(word(i)));
    expect(rare.epoch).toBe(e1);
    rare.add("late", ...termHashes("qzlate"));
    expect(rare.renumbered).toBe(1);
    expect(rare.epoch).not.toBe(e1);
  });
});
