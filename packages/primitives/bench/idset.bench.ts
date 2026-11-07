/**
 * `IdSet` against `Set<string>` at the sync's scale (D371): a source's synced ids, 1,000 to 3,000 a source, kept for
 * the user's life, consulted per listed item (`has`), re-ordered per stored item (delete + add), trimmed from the front
 * and walked whole now and then (completeness, the sweep's end, the trim).
 *
 * Memory: 300 sets of 3,000 ids each, built from strings no one else holds (as a frozen user's are), measured after a
 * full GC as `heapUsed` (which on Bun 1.4 includes typed arrays' stores), `external` and RSS. Ids are made the way the
 * engine makes them (`<source>:<ref>`), at two lengths: short (the benches' `mail:u12-345`, 13-15 characters) and
 * long (a 16-hex Gmail-like ref, 30 characters).
 *
 *   bun packages/primitives/bench/idset.bench.ts
 */
import { IdSet } from "../src/idset";
import { bench, consume, report } from "./harness";

const SETS = 300;
const PER = 3_000;
const MB = 1024 * 1024;

const shortId = (s: number, i: number) => `mail:u${s}-${i}`;
const longId = (s: number, i: number) =>
  `mail:${(s * 1_000_003 + i).toString(16).padStart(8, "0")}${((i * 2_654_435_761) >>> 0).toString(16).padStart(8, "0")}x${i}`;

function mem(): { heap: number; ext: number; rss: number } {
  Bun.gc(true);
  Bun.gc(true);
  const m = process.memoryUsage();
  return { heap: m.heapUsed, ext: m.external, rss: m.rss };
}

function memory(kind: "set" | "idset", make: (s: number, i: number) => string): string {
  const before = mem();
  const keep: (Set<string> | IdSet)[] = [];
  for (let s = 0; s < SETS; s++) {
    const set = kind === "set" ? new Set<string>() : new IdSet();
    // Ids made by concatenation, as a connector's parsed JSON gives them (flat strings once read).
    for (let i = 0; i < PER; i++) set.add(make(s, i).normalize());
    keep.push(set);
  }
  const after = mem();
  const n = SETS * PER;
  const line =
    `${kind.padEnd(6)} heapUsed ${((after.heap - before.heap) / n).toFixed(1)} B/id, ` +
    `external ${((after.ext - before.ext) / n).toFixed(1)} B/id, RSS ${((after.rss - before.rss) / n).toFixed(1)} B/id ` +
    `(${((after.heap - before.heap) / SETS / 1024).toFixed(1)} KB heap a set of ${PER})`;
  consume(keep.length);
  return line;
}

for (const [name, make] of [
  ["short ids (13-15 chars)", shortId],
  ["long ids (30 chars)", longId],
] as const) {
  console.log(`memory, ${SETS} sets x ${PER}, ${name}:`);
  // Each in a fresh heap state as far as one process allows: the Set first, then the IdSet.
  console.log("  " + memory("set", make));
  console.log("  " + memory("idset", make));
  void MB;
}

// Speed on one source's set of 3,000 (long ids), the operations the sync runs.
const ids = Array.from({ length: PER }, (_, i) => longId(7, i));
const misses = Array.from({ length: PER }, (_, i) => longId(8, i));
const plain = new Set(ids);
const packed = new IdSet();
for (const id of ids) packed.add(id);
let k = 0;
const results = [
  bench("Set has (hit)", () => plain.has(ids[k++ % PER]!), { batch: 10_000 }),
  bench("IdSet has (hit)", () => packed.has(ids[k++ % PER]!), { batch: 10_000 }),
  bench("Set has (miss)", () => plain.has(misses[k++ % PER]!), { batch: 10_000 }),
  bench("IdSet has (miss)", () => packed.has(misses[k++ % PER]!), { batch: 10_000 }),
  bench(
    "Set delete + add (re-order)",
    () => {
      const id = ids[k++ % PER]!;
      plain.delete(id);
      plain.add(id);
    },
    { batch: 10_000 },
  ),
  bench(
    "IdSet delete + add (re-order)",
    () => {
      const id = ids[k++ % PER]!;
      packed.delete(id);
      packed.add(id);
    },
    { batch: 10_000 },
  ),
  bench(
    "Set iterate 3,000",
    () => {
      let n = 0;
      for (const id of plain) n += id.length;
      return n;
    },
    { batch: 20 },
  ),
  bench(
    "IdSet iterate 3,000",
    () => {
      let n = 0;
      for (const id of packed) n += id.length;
      return n;
    },
    { batch: 20 },
  ),
];
report(results);
