/**
 * npm Bloom filter and count-min packages on the workloads of bench/sketch.bench.ts, for the record of why none was
 * adopted. Install them outside the repo and point LIBEVAL at the directory:
 *
 *   cd /tmp/libeval && bun add bloomfilter@1.2.0 bloom-filters@3.0.4 count-min-sketch@0.1.1
 *   LIBEVAL=/tmp/libeval bun packages/primitives/bench/compare/sketch.compare.ts
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { mix32 } from "../../src/hash";
import { bench, report } from "../harness";

const dir = process.env.LIBEVAL;
if (!dir) throw new Error("set LIBEVAL to the directory with the libraries installed");
const req = createRequire(join(dir, "package.json"));
const { BloomFilter: JdBloom } = await import(join(dir, "node_modules/bloomfilter/bloomfilter.js"));
const bf = req("bloom-filters");
const CountMinSketch = req("count-min-sketch");

let seed = 4242;
const rnd = () => (seed = mix32((seed + 0x9e3779b9) | 0));
const N = 2_000;
const present = Array.from({ length: N }, () => `${rnd().toString(16)}:${rnd().toString(16)}`);
const absent = Array.from({ length: 200_000 }, () => `${rnd().toString(16)}:${rnd().toString(16)}`);

console.log(`## Bloom filters, n=${N} string keys (the libraries hash strings), target 0.1%`);
const m = Math.ceil((-N * Math.log(0.001)) / (Math.LN2 * Math.LN2));
const k = Math.round((m / N) * Math.LN2);
const jd = new JdBloom(Math.ceil(m / 32) * 32, k);
for (const s of present) jd.add(s);
const cal = bf.BloomFilter.create(N, 0.001);
for (const s of present) cal.add(s);
let fpJd = 0;
let fpCal = 0;
for (const s of absent) {
  if (jd.test(s)) fpJd++;
  if (cal.has(s)) fpCal++;
}
console.log(`bloomfilter@1.2.0: m=${jd.m} k=${jd.k}, false positives ${fpJd}/${absent.length}`);
console.log(`bloom-filters@3.0.4: false positives ${fpCal}/${absent.length}`);
let q = 0;
const setBaseline = new Set(present);
report([
  bench("bloomfilter@1.2.0 test", () => jd.test(absent[q++ % 4096]!), { batch: 1000 }),
  bench("bloom-filters@3.0.4 has", () => cal.has(absent[q++ % 4096]!), { batch: 200 }),
  bench("Set<string> has (the baseline)", () => setBaseline.has(absent[q++ % 4096]!), { batch: 1000 }),
]);

console.log("\n## count-min-sketch@0.1.1 on the recurrence stream (Zipf 1.0, 5k names, 20k draws), two sizes");
const names = Array.from({ length: 5_000 }, (_, i) => `name-${i}-${rnd()}`);
let sum = 0;
const cdf = names.map((_, i) => (sum += 1 / (i + 1)));
const truth = new Map<string, number>();
const draws: string[] = [];
for (let i = 0; i < 20_000; i++) {
  const u = ((rnd() >>> 0) / 2 ** 32) * sum;
  let a = 0;
  let b = names.length - 1;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (cdf[mid]! < u) a = mid + 1;
    else b = mid;
  }
  draws.push(names[a]!);
  truth.set(names[a]!, (truth.get(names[a]!) ?? 0) + 1);
}
for (const width of [1024, 2560]) {
  const cms = CountMinSketch(1 / width, 0.06); // accuracy, probability → its own width/depth
  for (const d of draws) cms.update(d, 1);
  let ones = 0;
  let promoted = 0;
  for (const [name, c] of truth) {
    if (c !== 1) continue;
    ones++;
    if (cms.query(name) >= 2) promoted++;
  }
  const bytes = cms.table.length * 4;
  console.log(
    `count-min-sketch@0.1.1 (${cms.width}x${cms.depth}, ${(bytes / 1024).toFixed(0)} KB, plain update): seen-once ` +
      `names promoted ${promoted}/${ones} (${((promoted / ones) * 100).toFixed(1)}%)`,
  );
}
