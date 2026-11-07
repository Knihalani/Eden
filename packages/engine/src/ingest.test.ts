import { afterAll, describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { PoolFullError, WorkerPool } from "@eden/primitives";
import type { AgentEvent, ContextItem, Scope } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { buildWorkload } from "../bench/workload";
import { ItemCache, sanitizeItem } from "./cache";
import { attachChunk, INGEST_MODULE, mentionsOf, pooledIngest, prepareItems } from "./ingest";
import { ContextPartner } from "./partner";
import { preparedMentions, takeMentions, takePrepared } from "./prepared";

const NOW = Date.UTC(2026, 10, 3, 9);
const KEY = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
const OPT = { maxTextChars: 8_000, now: NOW, graph: true, mentions: true, pack: true };

/** Items in many scripts and shapes: accents, typographic dashes, a ligature, an emoji, dates that bind, a secret. */
function mixed(): ContextItem[] {
  const words = [
    "Zoë Müller",
    "Łukasz Nowak",
    "naïve",
    "ﬁnance",
    "café",
    "Ahmed Hassan",
    "INV-7174",
    "Umbrella Health",
    "release",
    "→",
    "—",
    "🎉",
    "Straße",
    "İstanbul",
    "don't",
    "Sam's",
  ];
  const out: ContextItem[] = [];
  for (let i = 0; i < 60; i++) {
    const pick = (k: number) => words[(i * 7 + k * 3) % words.length]!;
    const lines = [
      `From: ${pick(0)} <p${i}@umbrellahealth.com>`,
      `To: ${pick(1)} <me@example.com>`,
      `Hi ${pick(2)}, ${pick(3)} ${pick(4)} ${pick(5)} — the ${pick(6)} plan ${pick(9)} ${pick(10)} ${pick(11)}.`,
      i % 3 === 0 ? `No production changes from 28 Oct until 3 Nov; ${pick(7)} is on hold.` : `Thanks ${pick(8)}.`,
      i % 5 === 0 ? `token ${KEY}` : "",
      `${pick(12)} ${pick(13)} ${pick(14)} ${pick(15)} `.repeat(1 + (i % 9) * 12),
    ];
    out.push({
      id: `mail:m${i}`,
      sourceId: "mail",
      ref: `m${i}`,
      title: i % 4 === 0 ? `#legal ${pick(1)} — ${pick(6)}` : `Re: ${pick(7)} ${i}`,
      text: lines.join("\n"),
      updatedAt: NOW - i * 60_000,
      ...(i % 6 === 0 ? { meta: { start: "2026-11-05T10:00:00+01:00", people: `${pick(0)}; ${pick(1)}` } } : {}),
    });
  }
  return out;
}

async function workload(n: number): Promise<ContextItem[]> {
  const w = buildWorkload({ itemsPerSource: Math.ceil(n / 4) + 10, events: 1, seed: 7 });
  const signal = new AbortController().signal;
  const all = (
    await Promise.all(
      w.sources.map((s) =>
        s.search({ scope: w.scope, text: "", entities: w.people.slice(0, 300), limit: 10_000 }, signal),
      ),
    )
  ).flat();
  return all.slice(0, n);
}

/** Redacted copies with their reading attached, as the worker returns them (run here, on this thread). */
function prepared(raw: ContextItem[], now = NOW): ContextItem[] {
  // In chunks of 16, as the hook sends them, so a chunk's shared term table serves several items.
  const out: ContextItem[] = [];
  for (let i = 0; i < raw.length; i += 16) {
    const { items, chunk } = prepareItems({ items: raw.slice(i, i + 16), opt: { ...OPT, now } });
    attachChunk(items, chunk);
    out.push(...items);
  }
  return out;
}

/** Everything a user's cache derives from its items, read through its public surface. */
function snapshot(cache: ItemCache, scope: Scope, items: ContextItem[]) {
  const vocab = cache.peekVocab(scope)!;
  const terms: string[] = [];
  for (let id = 0; id < vocab.size; id++) terms.push(vocab.term(id));
  const searches = ["umbrella health", "zoe muller", "inv 7174", "production changes", "finance cafe", "lukasz"].map(
    (q) => {
      const ids: number[] = [];
      for (const w of q.split(" ")) {
        const id = vocab.lookup(w);
        if (id >= 0) ids.push(id);
      }
      return cache.search(scope, ids, ids.length, 20, NOW).map((h) => [h.item.id, h.doc, h.score, h.matched]);
    },
  );
  const stored = items.map((i) => cache.get(scope, i.id, NOW));
  const seeds = ["n:umbrellahealth", "n:zoemuller", "i:inv-7174", "d:2026-10-30", "n:lukasznowak", "c:#legal"];
  const walks = seeds.map((key) =>
    cache.walk(scope, [{ key, weight: 1 }], { budgetMs: 1e9, limit: 50, floor: 0 }, NOW).map((w) => [w.id, w.score]),
  );
  return {
    terms,
    searches,
    stored: stored.map((s) => s && { ...s }),
    walks,
    graph: cache.graphSize(scope),
    docs: items.map((i) => {
      const hit = cache.hits(scope, [i.id], NOW)[0];
      return hit ? [...cache.termsOf(scope, hit.doc)] : null;
    }),
    self: cache.selfOf(scope),
    offset: cache.offsetOf(scope),
  };
}

function cacheWithGraph(): ItemCache {
  const c = new ItemCache({ expireEveryMs: 0, maxSyncedPerUser: 5_000 });
  c.enableGraph();
  return c;
}

describe("the ingest worker's reading (D216)", () => {
  for (const [name, load] of [
    ["mixed scripts, dates and secrets", async () => mixed()],
    ["the bench workload", () => workload(300)],
  ] as const) {
    test(`stores what reading on the event loop stores: ${name}`, async () => {
      const raw = await load();
      const scope = { tenantId: "t", userId: "u" };
      const plain = cacheWithGraph();
      const viaWorker = cacheWithGraph();
      // Two pages each, so the second page's terms meet a vocabulary the first built.
      const half = Math.floor(raw.length / 2);
      for (const page of [raw.slice(0, half), raw.slice(half)]) {
        const a = plain.put(
          scope,
          page.map((i) => sanitizeItem(i)),
          NOW,
          true,
          true,
        );
        const b = viaWorker.put(scope, prepared(page), NOW, true, true);
        expect(b.map((i) => ({ ...i }))).toEqual(a.map((i) => ({ ...i })));
        // Mentions the worker read are the ones the partner would read, noted once per stored copy.
        for (const item of b) {
          expect(takeMentions(item)).toEqual(mentionsOf(item));
          expect(takeMentions(item)).toBeUndefined();
        }
      }
      expect(snapshot(viaWorker, scope, raw)).toEqual(snapshot(plain, scope, raw));
      // Redaction ran first, in the worker: no stored copy holds the key.
      expect(JSON.stringify(snapshot(viaWorker, scope, raw).stored)).not.toContain(KEY);
    });
  }

  test("a graph reading that binds a date is read again at another clock", () => {
    const later = NOW + 200 * 86_400_000; // Late May 2027: "28 Oct" is nearest in 2027 now.
    const raw = mixed();
    const scope = { tenantId: "t", userId: "u" };
    const plain = cacheWithGraph();
    const viaWorker = cacheWithGraph();
    plain.put(
      scope,
      raw.map((i) => sanitizeItem(i)),
      later,
      true,
      true,
    );
    // Read at NOW, stored at `later`: "until 3 Nov" and the year of "28 Oct" depend on the clock.
    viaWorker.put(scope, prepared(raw, NOW), later, true, true);
    const seeds = ["d:2026-10-30", "d:2027-10-30", "n:umbrellahealth"];
    const walk = (c: ItemCache) =>
      seeds.map((key) =>
        c.walk(scope, [{ key, weight: 1 }], { budgetMs: 1e9, limit: 50, floor: 0 }, later).map((w) => w.id),
      );
    expect(walk(viaWorker)).toEqual(walk(plain));
  });

  test("users stay apart: one user's reading never reaches another's cache", () => {
    const raw = mixed();
    const a = { tenantId: "t", userId: "a" };
    const b = { tenantId: "t", userId: "b" };
    const both = cacheWithGraph();
    const alone = cacheWithGraph();
    both.put(a, prepared(raw.slice(0, 30)), NOW, true, true);
    both.put(b, prepared(raw.slice(30)), NOW, true, true);
    alone.put(
      b,
      raw.slice(30).map((i) => sanitizeItem(i)),
      NOW,
      true,
      true,
    );
    // User b's vocabulary, index and graph are what b's own items make, whatever a's reading held.
    expect(snapshot(both, b, raw.slice(30))).toEqual(snapshot(alone, b, raw.slice(30)));
    expect(both.get(b, raw[0]!.id, NOW)).toBeNull();
  });

  test("a reading is taken once: a page put twice is read again, and none is kept after its put", () => {
    const [item] = prepared(mixed().slice(1, 2));
    expect(takePrepared(item!)).toBeDefined();
    expect(takePrepared(item!)).toBeUndefined();
    const [again] = prepared(mixed().slice(1, 2));
    const cache = cacheWithGraph();
    cache.put({ tenantId: "t", userId: "u" }, [again!], NOW, true, true);
    expect(takePrepared(again!)).toBeUndefined();
  });
});

describe("pooledIngest", () => {
  let pool: WorkerPool | undefined;
  afterAll(() => pool?.close());

  test("redacts and reads in a worker, the same items as sanitizeItem", async () => {
    pool = await WorkerPool.start({
      module: INGEST_MODULE,
      size: 1,
      maxQueue: 100,
      maxBatch: 4,
      taskTimeoutMs: 10_000,
      inlineBelow: 0,
      warm: "warmIngest",
    });
    const raw = mixed();
    const hook = pooledIngest(pool, { inlineBelow: 0, now: () => NOW, graph: true, mentions: true, pack: true });
    const out = await hook(raw);
    expect(out.map((i) => ({ ...i }))).toEqual(raw.map((i) => sanitizeItem(i)));
    expect(JSON.stringify(out)).not.toContain(KEY);
    // Each came with its reading, as the worker read it.
    for (const item of out) expect(preparedMentions(takePrepared(item)!)).toEqual(mentionsOf(item));
    expect(await pool.run<boolean>("ingestWarmed", null)).toBe(true);
  });

  test("a small page is redacted on the calling thread, with no reading", () => {
    let called = 0;
    const fake = {
      run: async () => {
        called++;
        return [];
      },
    } as unknown as Pick<WorkerPool, "run">;
    const raw = mixed().slice(0, 1);
    const out = pooledIngest(fake, { inlineBelow: 1e9, now: () => NOW, graph: true, mentions: true, pack: true })(raw);
    expect(out).toEqual(raw.map((i) => sanitizeItem(i)));
    expect(called).toBe(0);
  });

  test("fails closed when a chunk fails; a full pool redacts here instead", async () => {
    const raw = mixed();
    const failing = { run: async () => Promise.reject(new Error("deadline")) } as unknown as Pick<WorkerPool, "run">;
    const hook = pooledIngest(failing, { inlineBelow: 0, now: () => NOW, graph: true, mentions: true, pack: true });
    await expect(Promise.resolve(hook(raw))).rejects.toThrow(/ingest failed/);
    const full = { run: async () => Promise.reject(new PoolFullError("full")) } as unknown as Pick<WorkerPool, "run">;
    const out = await pooledIngest(full, { inlineBelow: 0, now: () => NOW, graph: true, mentions: true, pack: true })(
      raw,
    );
    expect(out).toEqual(raw.map((i) => sanitizeItem(i)));
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
});

describe("a partner with the ingest worker (trial ingestWorker)", () => {
  test("delivers what the event-loop path delivers, redacted, its lookups read in the worker", async () => {
    const pool = await WorkerPool.start({
      module: INGEST_MODULE,
      size: 1,
      maxQueue: 100,
      maxBatch: 4,
      taskTimeoutMs: 10_000,
      inlineBelow: 0,
    });
    try {
      const docs = [
        { ref: "deal-9", title: "Globex renewal", text: `Globex renewal due 2026-11-30, Dana Lee, api key ${KEY}` },
        ...mixed().map((i) => ({ ref: i.ref, title: i.title, text: `${i.text} Globex renewal with Dana Lee.` })),
      ];
      const run = async (worker: boolean) => {
        const cache = new ItemCache({ expireEveryMs: 0 });
        const p = new ContextPartner({
          sources: async () => [new StaticSource("crm", "Deals", docs)],
          sourceMap: new SourceMap(),
          cache,
          budget: new Budget(),
          model: null,
          now: () => NOW,
          config: { ingestWorker: worker },
          ...(worker ? { ingestPool: pool } : {}),
        });
        const event = { tenantId: "t", userId: "u", sessionId: "s", at: NOW, kind: "user_message" } as const;
        const r = await p.observe(
          { ...event, text: "Draft a note to Dana Lee about the Globex renewal" } as AgentEvent,
          { waitMs: 5_000 },
        );
        return { r, size: cache.graphSize({ tenantId: "t", userId: "u" }) };
      };
      const before = pool.stats().completed;
      const viaWorker = await run(true);
      expect(pool.stats().completed).toBeGreaterThan(before);
      const plain = await run(false);
      expect(plain.r.injection?.citations.map((c) => c.itemId)).toContain("crm:deal-9");
      expect(plain.size).toBeGreaterThan(0);
      expect(viaWorker.r.injection?.text).toBe(plain.r.injection?.text);
      expect(viaWorker.r.injection?.citations).toEqual(plain.r.injection?.citations);
      expect(viaWorker.size).toBe(plain.size);
      expect(viaWorker.r.injection?.text).not.toContain(KEY);
    } finally {
      pool.close();
    }
  });
});
