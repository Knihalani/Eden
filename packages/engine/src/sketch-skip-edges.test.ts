/**
 * D1927's differential test (`sketch-skip.test.ts`) at two edges its seeds rarely reach, each a skipping engine
 * against one that adds every listed item's words again (`PartnerDeps.syncResketchForTests`), compared after every
 * step (the sync's snapshots: sketch bits and `RareTerms` dumps; words' rare holders; sketch scores; synced counts):
 * - a user with more sources than `RareTerms` can number (4,094), whose items are a few fresh words each: a source
 *   with no number has its words dropped (`dropped`, a new epoch), and a word it dropped can later be written by a
 *   numbered source, so adding the dropped one's item again marks the word common. A drop that kept its epoch would
 *   leave that item stamped and skip it, the word "held by one" (it fails seeds 2 and 4 here).
 * - sketches restarting in the middle of a listing read a page at a time (a flood of fresh words into a sketch folded
 *   small), entries reordered by a lookup's put, warm and compact freezes, then a sweep: the restarted pages' entries
 *   carry a stale stamp beside the next pages' entries carrying the current one, so a thaw that gave an entry the
 *   next one's stamp would skip an item whose words the restart lost.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import type { EngineConfig } from "./config";
import { ContextPartner } from "./partner";
import { termHashes } from "./sketch";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

/** A word of letters only (the sketch keeps no word with a figure), never a stopword. */
function word(n: number): string {
  let s = "";
  do {
    s += String.fromCharCode(97 + (n % 26));
    n = Math.floor(n / 26);
  } while (n > 0);
  return `qz${s}`;
}

type Doc = { ref: string; title: string; text: string; at: number };

/** A connector listing newest first, its items fresh objects at every call (as a connector's reply is). */
class Listing implements Source {
  readonly kind = "test";
  readonly description = "test";
  constructor(
    readonly id: string,
    readonly docs: Doc[],
  ) {}
  async search(): Promise<ContextItem[]> {
    return [];
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const sorted = [...this.docs].sort((a, b) => b.at - a.at);
    const at = cursor ? Number(cursor) : 0;
    const items = sorted.slice(at, at + limit).map((d) => ({
      id: itemId(this.id, d.ref),
      sourceId: this.id,
      ref: d.ref,
      title: d.title,
      text: d.text,
      updatedAt: d.at,
    }));
    return { items, next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

/** Two engines over the same sources (the docs are shared, so an edit reaches both): skipping and re-adding all. */
function pair(scope: Scope, sources: Listing[], now: () => number, config: Partial<EngineConfig>) {
  const make = (resketch: boolean) => {
    // Expiry ticks run by hand: two idle ticks freeze warm, four compact.
    const cache = new ItemCache({ expireEveryMs: 1, warmIdleMs: 2, freezeIdleMs: 4 });
    cache.close();
    const partner = new ContextPartner({
      sources: async (s) => (s.tenantId === scope.tenantId && s.userId === scope.userId ? sources : []),
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache,
      budget: new Budget(),
      model: null,
      now,
      after: () => () => {},
      config: { syncCallsPerMin: 1e7, ...config },
      syncResketchForTests: resketch,
    });
    return { cache, partner };
  };
  return [make(false), make(true)] as const;
}

type Engine = ReturnType<typeof pair>[number];

async function ticks(e: Engine, scope: Scope, clock: number, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    e.partner.sync!.track(scope, clock);
    await e.partner.sync!.tick();
    await e.partner.sync!.kicked(scope);
    await new Promise((res) => setTimeout(res, 0)); // Pages waiting their turn (`syncIngestTurns`) are stored.
  }
}

function state(e: Engine, scope: Scope, words: string[]): string {
  const sync = e.partner.sync!;
  const probe = words.map((w) => termHashes(w));
  const scores = sync.sketchScores(scope, probe);
  return JSON.stringify({
    snap: sync.snapshot(scope),
    // Each word's own holders (a union over many words would hide one word's change).
    holders: probe.map((t) => [...sync.rareHolders(scope, [t], 2)].sort()),
    scores: scores ? [...scores].sort() : null,
    synced: e.cache.syncedCount(scope),
  });
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe("D1927 at its edges: identical state to the engine that re-adds every item", () => {
  for (const seed of [1, 2, 3, 4]) {
    test(`seed ${seed}: more sources than RareTerms numbers, items of a few fresh words (words dropped)`, async () => {
      const r = rng(seed);
      let clock = Date.parse("2026-11-01T00:00:00Z");
      const scope: Scope = { tenantId: "t", userId: `u${seed}` };
      // 4,094 numbers: the last sources listed have none, and their words are dropped (`RareTerms.add`).
      const N = 4_110;
      let fresh = 10_000 * seed;
      // Words still being taken up: an added item reuses a few of them, so a word a numberless source dropped is
      // often listed by a numbered one later, and the other way round.
      const recent: string[] = [];
      const take = () => {
        const w = word(fresh++);
        recent.push(w);
        if (recent.length > 24) recent.shift();
        return w;
      };
      const sources = Array.from(
        { length: N },
        (_, i) =>
          new Listing(`s${i}`, [
            { ref: "a", title: word(i % 50), text: `${take()} ${word(i % 9)}`, at: clock - (i + 1) * 1_000 },
          ]),
      );
      const engines = pair(scope, sources, () => clock, { syncMaxItems: 20_000, syncPageSize: 2 });
      for (const e of engines) stops.push(() => e.partner.stopSync());
      const used = new Set<string>();
      const compare = (what: string) => {
        // The table's bytes are in the snapshot; the holders are read for the words in play and a sample of the rest.
        const words = [...used].filter((_, i) => i % 25 === 0).concat(recent);
        const [a, b] = engines.map((e) => state(e, scope, words));
        expect(a, what).toBe(b!);
      };
      for (const e of engines) await ticks(e, scope, clock, 4);
      for (const s of sources) for (const d of s.docs) for (const w of d.text.split(" ")) used.add(w);
      compare("after the backfill");
      let nextRef = 0;
      const ops = ["add", "add", "add", "sweep", "sweep", "tick", "forget", "edit", "warm", "compact"] as const;
      for (let step = 0; step < 24; step++) {
        const op = ops[Math.floor(r() * ops.length)]!;
        // Half the time one of the last sources (numberless, unless a forgotten source's number came back to it).
        const pick = () => sources[r() < 0.5 ? N - 1 - Math.floor(r() * 40) : Math.floor(r() * N)]!;
        let n = 2;
        switch (op) {
          case "add":
            // Several sources at once, each a new item of a few recent words and one fresh one.
            for (let k = 0; k < 12; k++) {
              const s = pick();
              const words = [recent[Math.floor(r() * recent.length)]!, recent[Math.floor(r() * recent.length)]!];
              s.docs.push({ ref: `n${nextRef++}`, title: take(), text: words.join(" "), at: clock - 500 });
            }
            clock += 60_000;
            break;
          case "edit": {
            const d = pick().docs[0]!;
            d.text = `${take()} ${recent[Math.floor(r() * recent.length)]!}`;
            clock += 60_000;
            break;
          }
          case "sweep":
            clock += DAY + HOUR;
            n = 4;
            break;
          case "tick":
            clock += 10 * 60_000;
            break;
          case "forget": {
            // A numbered source forgotten: its number is retired, and a numberless one takes it back (renumbering).
            const s = sources[Math.floor(r() * 4_000)]!;
            for (const e of engines) e.partner.forget(scope, s.id);
            clock += DAY + HOUR;
            n = 4;
            break;
          }
          case "warm":
          case "compact":
            for (const e of engines) for (let t = 0; t < (op === "warm" ? 2 : 4); t++) e.cache.expireIdle(clock);
            n = 0;
            break;
        }
        for (const s of sources) for (const d of s.docs) for (const w of `${d.title} ${d.text}`.split(" ")) used.add(w);
        for (const e of engines) await ticks(e, scope, clock, n);
        compare(`after step ${step} (${op})`);
      }
      // Every number taken, so the last sources' words were dropped. Each drop moves the table's epoch, so the skip
      // rarely runs for such a user (any page after a drop is added again); the oracle never skips.
      const snap = engines[0].partner.sync!.snapshot(scope)!;
      expect((snap.rare as { ids: unknown[] }).ids.length).toBe(4_094);
      expect(engines[1].partner.sync!.stats.sketchSkipped).toBe(0);
    }, 120_000);
  }

  for (const seed of Array.from({ length: 12 }, (_, i) => i + 1)) {
    test(`seed ${seed}: sketches restarting mid-listing, entries reordered, frozen warm or compact, then a sweep`, async () => {
      const r = rng(100 + seed);
      let clock = Date.parse("2026-11-01T00:00:00Z");
      const scope: Scope = { tenantId: "t", userId: `v${seed}` };
      let fresh = 100_000 * seed;
      const vocab = 200;
      const text = (n: number) => Array.from({ length: n }, () => word(Math.floor(r() * vocab))).join(" ");
      // One source, or two whose pages interleave in the cache's order.
      const sources = ["mail", "docs"].slice(0, 1 + (seed % 2)).map(
        (id) =>
          new Listing(
            id,
            Array.from({ length: 4 + Math.floor(r() * 6) }, (_, i) => ({
              ref: `${id}${i}`,
              title: text(1),
              text: text(4 + Math.floor(r() * 10)),
              at: clock - (i + 1) * HOUR,
            })),
          ),
      );
      // One to three items a page: a restart leaves its page's entries and the pages' before it stale (their words
      // lost with the old bits) beside the next pages' entries under the current stamp, in the cache's order.
      const pageSize = 1 + Math.floor(r() * 3);
      const engines = pair(scope, sources, () => clock, { syncPageSize: pageSize, syncPollPageSize: pageSize });
      for (const e of engines) stops.push(() => e.partner.stopSync());
      const words = Array.from({ length: 60 }, (_, i) => word(i * 3));
      const compare = (what: string) => {
        const [a, b] = engines.map((e) => state(e, scope, words));
        expect(a, what).toBe(b!);
      };
      const run = async (n: number, what: string) => {
        for (const e of engines) await ticks(e, scope, clock, n);
        compare(what);
      };
      await run(8, "after the backfill");
      let nextRef = 0;
      for (let round = 0; round < 12; round++) {
        const src = sources[Math.floor(r() * sources.length)]!;
        // The last flood deleted and the source read again from its first page: a new sketch, folded small at its
        // end, which the next flood saturates.
        if (round > 0 && r() < 0.8) {
          for (const x of sources) x.docs.splice(0, x.docs.length, ...x.docs.filter((d) => d.title !== "flood"));
          for (const e of engines) e.partner.forget(scope, src.id);
          for (let k = 0; k < 4; k++) {
            clock += 20 * 60_000;
            await run(3, `round ${round}: read again`);
          }
        }
        if (r() < 0.3) {
          src.docs[Math.floor(r() * src.docs.length)]!.text = text(8);
          src.docs.push({ ref: `a${nextRef++}`, title: text(1), text: text(8), at: clock - 60_000 });
        }
        // Fresh words at a random place in the listing (newest, or between held items): the restart comes in the
        // page that reads it, by a sweep or by a poll.
        const size = 300 + Math.floor(r() * 500);
        const flood = Array.from({ length: size }, () => word(fresh++)).join(" ");
        const at = r() < 0.3 ? clock - 30_000 : clock - Math.floor(r() * 8) * HOUR - 30_000;
        src.docs.push({ ref: `f${nextRef++}`, title: "flood", text: flood, at });
        if (r() < 0.6) clock += DAY + HOUR;
        else clock += 2 * HOUR;
        await run(6, `round ${round}: flood`);
        if (r() < 0.6) {
          // A lookup's put of what it found (fresh copies equal to the held ones: D1722 keeps the held object and
          // its stamp) moves those entries last in the cache's order, after entries a later page stamped.
          const listed = (await src.list(scope, undefined, 1_000)).items.filter(() => r() < 0.5);
          for (const e of engines)
            e.cache.put(
              scope,
              listed.sort(() => r() - 0.5),
              clock,
            );
          compare(`round ${round}: lookup`);
        }
        const freeze = r();
        if (freeze < 0.85) {
          for (const e of engines) for (let t = 0; t < (freeze < 0.4 ? 2 : 4); t++) e.cache.expireIdle(clock);
          compare(`round ${round}: frozen ${freeze < 0.4 ? "warm" : "compact"}`);
        }
        clock += DAY + HOUR;
        await run(6, `round ${round}: sweep (${pageSize} a page)`);
      }
      expect(engines[0].partner.sync!.stats.sketchSkipped).toBeGreaterThan(0);
      expect(engines[1].partner.sync!.stats.sketchSkipped).toBe(0);
    }, 60_000);
  }
});
