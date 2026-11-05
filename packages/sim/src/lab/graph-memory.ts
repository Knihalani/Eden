#!/usr/bin/env bun
/**
 * What the knowledge graph (`kg.ts`, the `graph` flag) costs to hold and to build, per user and per item, measured as
 * D63 measured it (docs/research/moonshots.md): full caches of realistic items (worlds at `noiseScale` 1.5 with every
 * dev suite planted, every source item listed), `ItemCache.put` in batches of ten, with the graph and without.
 *
 *   bun packages/sim/src/lab/graph-memory.ts [--users 20] [--items 2000] [--seeds 41,42,43] [--reps 3]
 *
 * Reports heap per user and per item (after a full GC, the graph's share = with − without), put CPU per item with and
 * without the graph, the graph build alone (`extract` and the insert into `UserGraph`, µs per item), node count, and
 * a fingerprint of every walk the dev requests make (ids, scores, masks, ties, flags) plus a churn phase (half the
 * items dropped and re-put), so a change to the graph's storage can show it changed nothing it returns.
 */
import { heapStats } from "bun:jsc";
import { createHash } from "node:crypto";
import type { ContextItem } from "@eden/protocol";
// The benchmark times the graph's two halves (`extract`, the insert into `UserGraph`) directly.
import { extract, extractEntities, ItemCache, seedsOf, timeWindow, UserGraph } from "@eden/engine";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { clearSlot, dress } from "./hidden-context";
import { SUITES } from "./suites";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const USERS = Number(opt("users", "20"));
const ITEMS = Number(opt("items", "2000"));
const SEEDS = opt("seeds", "41,42,43").split(",").map(Number);
const REPS = Number(opt("reps", "3"));
const DEV = ["hidden", "heldout", "heldout2", "heldout3", "heldout4"];

interface World {
  items: ContextItem[];
  now: number;
  requests: string[];
}

const worlds: World[] = SEEDS.map((seed) => {
  const world = buildWorld({ seed: seed * 1_000, noiseScale: 1.5 });
  const requests: string[] = [];
  for (const suite of DEV) {
    const before = world.items.length;
    const tasks = SUITES[suite]!(world, seed, "hidden");
    for (const it of world.items.slice(before)) dress(world, it);
    const keep = new Set(world.items.slice(before).map((it) => it.id));
    for (const t of tasks) clearSlot(world, t.text, keep);
    requests.push(...tasks.map((t) => t.text));
  }
  const all = simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll());
  return { items: all.slice(-ITEMS), now: world.now, requests };
});
const perUser = Math.round(worlds.reduce((s, w) => s + w.items.length, 0) / worlds.length);

const gc = () => {
  Bun.gc(true);
  Bun.gc(true);
  return heapStats().heapSize;
};
const scopeOf = (u: number) => ({ tenantId: "bench", userId: `u${u}` });

/** Puts every user's items in batches of ten; returns the cache and the CPU time (ms). */
function fill(graph: boolean): { cache: ItemCache; ms: number } {
  const cache = new ItemCache();
  if (graph) cache.enableGraph();
  const c0 = process.cpuUsage();
  for (let u = 0; u < USERS; u++) {
    const w = worlds[u % worlds.length]!;
    for (let i = 0; i < w.items.length; i += 10) cache.put(scopeOf(u), w.items.slice(i, i + 10), w.now);
  }
  const c = process.cpuUsage(c0);
  return { cache, ms: (c.user + c.system) / 1_000 };
}

// Heap: the same users with and without a graph, each measured from a clean heap.
const heap = (graph: boolean) => {
  const base = gc();
  const { cache } = fill(graph);
  const bytes = gc() - base;
  cache.close();
  return bytes;
};
heap(true); // Warm the code paths and the worlds' strings.
const heapOff = heap(false);
const heapOn = heap(true);

// Put CPU: the best of `REPS` fills each way.
let putOff = Infinity;
let putOn = Infinity;
for (let r = 0; r < REPS; r++) {
  const a = fill(false);
  a.cache.close();
  putOff = Math.min(putOff, a.ms);
  const b = fill(true);
  b.cache.close();
  putOn = Math.min(putOn, b.ms);
}

// The graph build alone: extraction, then the insert, over every world's items (best of `REPS`).
let extractUs = Infinity;
let addUs = Infinity;
let builtNodes = 0;
const n = worlds.reduce((s, w) => s + w.items.length, 0);
for (let r = 0; r < REPS; r++) {
  let t0 = performance.now();
  for (const w of worlds) for (const it of w.items) extract(it, w.now);
  extractUs = Math.min(extractUs, ((performance.now() - t0) * 1_000) / n);
  t0 = performance.now();
  builtNodes = 0;
  for (const w of worlds) {
    const g = new UserGraph();
    for (const it of w.items) g.add(it, w.now);
    builtNodes += g.size;
  }
  addUs = Math.min(addUs, ((performance.now() - t0) * 1_000) / n);
}

// The fingerprint: every dev request's walk on each world's graph, then again after half its items left and came back.
const hash = createHash("sha256");
let walks = 0;
for (const [i, w] of worlds.entries()) {
  const cache = new ItemCache();
  cache.enableGraph();
  const scope = scopeOf(i);
  for (let k = 0; k < w.items.length; k += 10) cache.put(scope, w.items.slice(k, k + 10), w.now);
  const opts = { budgetMs: 1e9, limit: 16, floor: 0.15 };
  const walkAll = () => {
    for (const text of w.requests) {
      const seeds = seedsOf(text, extractEntities(text), timeWindow(text, w.now)?.days ?? []);
      hash.update(JSON.stringify(cache.walk(scope, seeds, opts, w.now)));
      walks++;
    }
    hash.update(String(cache.graphSize(scope)));
  };
  walkAll();
  cache.close();
  // Churn, on the graph itself: every other item taken out, then put back (its nodes and links leave and return, in a
  // new order), walked after each step.
  const g = new UserGraph();
  for (const it of w.items) g.add(it, w.now);
  const walkGraph = () => {
    for (const text of w.requests) {
      const seeds = seedsOf(text, extractEntities(text), timeWindow(text, w.now)?.days ?? []);
      hash.update(JSON.stringify(g.walk(seeds, opts)));
      walks++;
    }
    hash.update(String(g.size));
  };
  walkGraph();
  // What extraction reads from each item, and each seed's own neighbourhood (`around`, the user's exclusions).
  for (const it of w.items) {
    const x = extract(it, w.now);
    hash.update(JSON.stringify([[...x.nodes], x.links, x.authors, x.automated, x.bound, x.long]));
  }
  for (const text of w.requests) {
    for (const s of seedsOf(text, extractEntities(text), [])) hash.update(JSON.stringify([...g.around(s.key)]));
  }
  const half = w.items.filter((_, k) => k % 2 === 0);
  for (const it of half) g.remove(it.id);
  walkGraph();
  for (const it of half) g.add(it, w.now);
  walkGraph();
}

const kb = (b: number) => Number((b / 1024).toFixed(2));
console.log(
  JSON.stringify(
    {
      users: USERS,
      itemsPerUser: perUser,
      heapPerUserMB: {
        off: Number((heapOff / USERS / 2 ** 20).toFixed(2)),
        on: Number((heapOn / USERS / 2 ** 20).toFixed(2)),
      },
      graphKBPerItem: kb((heapOn - heapOff) / USERS / perUser),
      putUsPerItem: {
        off: Math.round((putOff * 1_000) / USERS / perUser),
        on: Math.round((putOn * 1_000) / USERS / perUser),
      },
      graphPutUsPerItem: Math.round(((putOn - putOff) * 1_000) / USERS / perUser),
      buildUsPerItem: { extract: Number(extractUs.toFixed(1)), extractAndAdd: Number(addUs.toFixed(1)) },
      nodesPerUser: Math.round(builtNodes / worlds.length),
      walks,
      fingerprint: hash.digest("hex").slice(0, 16),
    },
    null,
    2,
  ),
);
