/**
 * Packing: cost per packet, how close the Lin–Bilmes greedy gets to the exact optimum, and how often each objective
 * lets a near-duplicate into the packet.
 *
 * Instances are shaped like a lookup's candidates: rel ~ Beta(1.2, 2.5) (calibrated usefulness, mostly low), sizes
 * log-normal with median ~150 bytes, and items in topic clusters (same cluster: similarity 0.5–1, near duplicates
 * included; otherwise 0–0.15). Two classes:
 * - "eden": 50 candidates pre-truncated to ≤ 300 bytes (25% of the budget), budget 1,200 bytes, at most 3 items;
 * - "tight": 20 candidates up to 1,200 bytes, budget 1,200, at most 6 items (the knapsack side of the problem).
 */
import { jaccardMatrix, Packer } from "../src/pack";
import { Xoshiro128 } from "../src/random";
import { tokenizeInto } from "../src/tokenize";
import { Vocab } from "../src/vocab";
import { bench, corpus, report } from "./harness";

interface Instance {
  n: number;
  rel: Float64Array;
  cost: Float64Array;
  sim: Float64Array;
}

function instance(rng: Xoshiro128, n: number, maxCost: number): Instance {
  const rel = new Float64Array(n);
  const cost = new Float64Array(n);
  const sim = new Float64Array(n * n);
  const cluster = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    rel[i] = rng.beta(1.2, 2.5);
    cost[i] = Math.min(maxCost, Math.max(40, Math.round(Math.exp(5 + 1.1 * rng.normal()))));
    cluster[i] = rng.below(Math.max(2, n >> 2));
  }
  for (let i = 0; i < n; i++) {
    sim[i * n + i] = 1;
    for (let j = 0; j < i; j++) {
      const s = cluster[i] === cluster[j] ? 0.5 + 0.5 * rng.uniform() : 0.15 * rng.uniform();
      sim[i * n + j] = s;
      sim[j * n + i] = s;
    }
  }
  return { n, rel, cost, sim };
}

/** One cost-scaled greedy pass on Packer's objective (β = 1), without the plain pass `pack` adds: its value. */
function scaledOnly(x: Instance, budget: number, cap: number, r: number): number {
  const open = new Uint8Array(x.n).fill(1);
  const pen = new Float64Array(x.n);
  let count = 0;
  let used = 0;
  let value = 0;
  while (count < cap) {
    let pick = -1;
    let best = 0;
    let bestGain = 0;
    for (let k = 0; k < x.n; k++) {
      if (!open[k] || x.cost[k]! > budget) continue;
      const gain = x.rel[k]! - pen[k]!;
      const ratio = gain / Math.pow(x.cost[k]!, r);
      if (gain > 0 && ratio > best) ((best = ratio), (bestGain = gain), (pick = k));
    }
    if (pick < 0) break;
    open[pick] = 0;
    if (used + x.cost[pick]! > budget) continue;
    count++;
    used += x.cost[pick]!;
    value += bestGain;
    for (let k = 0; k < x.n; k++) pen[k]! += x.sim[pick * x.n + k]! * Math.min(x.rel[pick]!, x.rel[k]!);
  }
  return value;
}

/** Classic λ-MMR (max-similarity penalty) with the same budget, cap, cost scaling and stop rule, for comparison. */
function mmr(x: Instance, budget: number, cap: number, lambda: number, r: number, out: Int32Array): number {
  const open = new Uint8Array(x.n).fill(1);
  const maxSim = new Float64Array(x.n);
  let count = 0;
  let used = 0;
  while (count < cap) {
    let pick = -1;
    let best = 0;
    for (let k = 0; k < x.n; k++) {
      if (!open[k] || x.cost[k]! > budget) continue;
      const gain = lambda * x.rel[k]! - (1 - lambda) * maxSim[k]!;
      const ratio = gain / Math.pow(x.cost[k]!, r);
      if (gain > 0 && ratio > best) ((best = ratio), (pick = k));
    }
    if (pick < 0) break;
    open[pick] = 0;
    if (used + x.cost[pick]! > budget) continue;
    out[count++] = pick;
    used += x.cost[pick]!;
    for (let k = 0; k < x.n; k++) maxSim[k] = Math.max(maxSim[k]!, x.sim[pick * x.n + k]!);
  }
  return count;
}

// ── Cost ──
{
  const rng = new Xoshiro128(1);
  const e50 = instance(rng, 50, 300);
  const e20 = instance(rng, 20, 300);
  const packer = new Packer(50);
  const out = new Int32Array(50);
  // Two sets of 50 short texts, tokenized once; the timed part is the 50×50 Jaccard matrix. The harness corpus has
  // only ~60 distinct words (dense overlap, a worst case for merging); the Zipf texts draw 45 words each from a
  // 5,000-word vocabulary with exponent 1, closer to real snippets.
  const vocab = new Vocab();
  const zipfCdf = new Float64Array(5000);
  for (let r = 0, sum = 0; r < 5000; r++) zipfCdf[r] = sum += 1 / (r + 1);
  const zipfWord = () => {
    const u = rng.uniform() * zipfCdf[4999]!;
    let lo = 0;
    let hi = 4999;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (zipfCdf[mid]! < u) lo = mid + 1;
      else hi = mid;
    }
    return `w${lo}`;
  };
  const sets = [
    ["harness corpus", (i: number) => corpus(300, { seed: i + 1 })],
    ["Zipf, 5k words", () => Array.from({ length: 45 }, zipfWord).join(" ")],
  ] as const;
  const timings = [
    bench("pack, 20 candidates, r = 0.5", () => packer.pack(e20.rel, e20.cost, e20.sim, 20, 1200, 3, 1, 0.5, out)),
    bench("pack, 50 candidates, r = 0.5", () => packer.pack(e50.rel, e50.cost, e50.sim, 50, 1200, 3, 1, 0.5, out)),
    bench("pack, 50 candidates, r = 0 (one greedy pass)", () =>
      packer.pack(e50.rel, e50.cost, e50.sim, 50, 1200, 3, 1, 0, out),
    ),
    bench("packExact, 20 candidates, ≤ 3 items", () =>
      packer.packExact(e20.rel, e20.cost, e20.sim, 20, 1200, 3, 1, out),
    ),
    bench(
      "packExact, 50 candidates, ≤ 3 items",
      () => packer.packExact(e50.rel, e50.cost, e50.sim, 50, 1200, 3, 1, out),
      { batch: 5 },
    ),
  ];
  for (const [name, text] of sets) {
    const ids = new Uint32Array(50 * 128);
    const offsets = new Uint32Array(51);
    let at = 0;
    for (let i = 0; i < 50; i++) {
      at += tokenizeInto(text(i), vocab, true, ids.subarray(at, at + 128), null);
      offsets[i + 1] = at;
    }
    const work = new Uint32Array(at);
    const lengths = new Uint32Array(50);
    const jac = new Float64Array(2500);
    timings.push(
      bench(
        `jaccardMatrix, 50 items, ${name} (${at} ids)`,
        () => {
          work.set(ids.subarray(0, at));
          jaccardMatrix(work, offsets, 50, lengths, jac);
        },
        { batch: 20 },
      ),
    );
  }
  report(timings);
}

// ── Greedy vs exact ──
for (const [cls, n, maxCost, cap] of [
  ["eden", 50, 300, 3],
  ["tight", 20, 1200, 6],
] as const) {
  const trials = 2000;
  const rng = new Xoshiro128(cls === "eden" ? 11 : 12);
  const packer = new Packer(n);
  const out = new Int32Array(n);
  const stats = [0, 0.5, 1].map((r) => ({ r, min: Infinity, sum: 0, optimal: 0, plain: 0, alone: 0, aloneMin: 1 }));
  for (let t = 0; t < trials; t++) {
    const x = instance(rng, n, maxCost);
    packer.packExact(x.rel, x.cost, x.sim, n, 1200, cap, 1, out);
    const opt = packer.value;
    for (const st of stats) {
      packer.pack(x.rel, x.cost, x.sim, n, 1200, cap, 1, st.r, out);
      const ratio = opt > 0 ? packer.value / opt : 1;
      st.min = Math.min(st.min, ratio);
      st.sum += ratio;
      if (ratio > 1 - 1e-12) st.optimal++;
      if (packer.usedPlain && st.r !== 0) st.plain++;
      const alone = opt > 0 ? scaledOnly(x, 1200, cap, st.r) / opt : 1;
      st.alone += alone;
      st.aloneMin = Math.min(st.aloneMin, alone);
    }
  }
  console.log(
    `── greedy / exact optimum, "${cls}" (${n} candidates, ≤ ${cap} items, 1,200 bytes), ${trials} instances`,
  );
  for (const st of stats) {
    console.log(
      `   r = ${st.r.toFixed(1)}  mean ${(st.sum / trials).toFixed(4)}  min ${st.min.toFixed(4)}  ` +
        `optimal ${((100 * st.optimal) / trials).toFixed(1)}%  plain greedy kept ${st.plain}  ` +
        `(cost-scaled pass alone: mean ${(st.alone / trials).toFixed(4)}, min ${st.aloneMin.toFixed(4)})`,
    );
  }
}

// ── Near-duplicates admitted: this objective (β = 1) vs λ-MMR ──
{
  const trials = 2000;
  const rng = new Xoshiro128(13);
  const packer = new Packer(50);
  const out = new Int32Array(50);
  const rows: [string, (x: Instance) => number][] = [
    ["Packer β = 1, r = 0.5", (x) => packer.pack(x.rel, x.cost, x.sim, x.n, 1200, 3, 1, 0.5, out)],
    ["λ-MMR λ = 0.7, r = 0.5", (x) => mmr(x, 1200, 3, 0.7, 0.5, out)],
    ["λ-MMR λ = 0.5, r = 0.5", (x) => mmr(x, 1200, 3, 0.5, 0.5, out)],
  ];
  const instances = Array.from({ length: trials }, () => instance(rng, 50, 300));
  console.log(`── packets with a pair of similarity ≥ 0.8, "eden" class, ${trials} instances`);
  for (const [name, f] of rows) {
    let dup = 0;
    let items = 0;
    let relSum = 0;
    for (const x of instances) {
      const got = f(x);
      items += got;
      let has = false;
      for (let a = 0; a < got; a++) {
        relSum += x.rel[out[a]!]!;
        for (let b = 0; b < a; b++) if (x.sim[out[a]! * x.n + out[b]!]! >= 0.8) has = true;
      }
      if (has) dup++;
    }
    console.log(
      `   ${name.padEnd(24)} near-duplicate packets ${((100 * dup) / trials).toFixed(1)}%  ` +
        `items/packet ${(items / trials).toFixed(2)}  Σ rel/packet ${(relSum / trials).toFixed(3)}`,
    );
  }
}
