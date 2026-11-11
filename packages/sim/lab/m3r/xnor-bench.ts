/**
 * M3 (D907): the binarised scorer's CPU kernels in plain TypeScript, timed. Shapes are TwinXor's local ones
 * (packages/sim/lab/m3r/binnet.py `pair`, 128 bits): an item's code at ingest from about 300 hashed n-gram ids
 * through a ternary table (two bit-planes: plus and minus) into 128 int16 accumulators and a sign; a candidate's
 * score from 640 input bits (q XNOR i, q, i, i XNOR twin, twin) through 128 then 32 binary neurons (XNOR-popcount
 * against ±1 weights, a per-neuron threshold standing for the folded batch norm) and an int8 head.
 *
 *   bun packages/sim/lab/m3r/xnor-bench.ts
 */
const BITS = 128;
const W32 = BITS / 32;
const BUCKETS = 1 << 16;

/** Set bits in a 32-bit word (SWAR). */
function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/** A binary layer: `out` neurons over `inWords` packed input words; weights packed the same way (1 = +1). */
function binaryLayer(inWords: number, out: number, rnd: () => number) {
  const w = new Uint32Array(out * inWords);
  for (let i = 0; i < w.length; i++) w[i] = (rnd() * 2 ** 32) >>> 0;
  const thr = new Int32Array(out);
  for (let o = 0; o < out; o++) thr[o] = (inWords * 32) >> 1;
  const outWords = Math.ceil(out / 32);
  return (x: Uint32Array, y: Uint32Array) => {
    y.fill(0, 0, outWords);
    for (let o = 0; o < out; o++) {
      let agree = 0;
      const base = o * inWords;
      for (let k = 0; k < inWords; k++) agree += popcount(~(x[k]! ^ w[base + k]!));
      if (agree >= thr[o]!) y[o >>> 5]! |= 1 << (o & 31);
    }
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

const rnd = rng(7);
// Ternary encoder table as two bit-planes a bucket: plus[b][word], minus[b][word].
const plus = new Uint32Array(BUCKETS * W32);
const minus = new Uint32Array(BUCKETS * W32);
for (let i = 0; i < plus.length; i++) {
  const a = (rnd() * 2 ** 32) >>> 0;
  const b = (rnd() * 2 ** 32) >>> 0;
  plus[i] = a & ~b & ((rnd() * 2 ** 32) >>> 0);
  minus[i] = b & ~a & ((rnd() * 2 ** 32) >>> 0);
}
const bias = new Int16Array(BITS);
const acc = new Int16Array(BITS);

/** An item's 128-bit code from its n-gram ids: per bit, (plus count − minus count + bias) ≥ 0. */
function encode(ids: Uint32Array, out: Uint32Array) {
  acc.set(bias);
  for (let n = 0; n < ids.length; n++) {
    const base = ids[n]! * W32;
    for (let k = 0; k < W32; k++) {
      let p = plus[base + k]!;
      let m = minus[base + k]!;
      // Walk only set bits: ternary rows are sparse (about two thirds zeros).
      while (p) {
        const t = p & -p;
        acc[(k << 5) + (31 - Math.clz32(t))]!++;
        p ^= t;
      }
      while (m) {
        const t = m & -m;
        acc[(k << 5) + (31 - Math.clz32(t))]!--;
        m ^= t;
      }
    }
  }
  out.fill(0);
  for (let b = 0; b < BITS; b++) if (acc[b]! >= 0) out[b >>> 5]! |= 1 << (b & 31);
}

const L1 = binaryLayer(5 * W32, 128, rnd);
const L2 = binaryLayer(4, 32, rnd);
const head = new Int8Array(32).map(() => Math.round((rnd() - 0.5) * 254));

const x = new Uint32Array(5 * W32);
const h1 = new Uint32Array(4);
const h2 = new Uint32Array(1);
/** One candidate's score from the request's, the item's and the twin's codes. */
function score(q: Uint32Array, i: Uint32Array, t: Uint32Array): number {
  for (let k = 0; k < W32; k++) {
    x[k] = ~(q[k]! ^ i[k]!);
    x[W32 + k] = q[k]!;
    x[2 * W32 + k] = i[k]!;
    x[3 * W32 + k] = ~(i[k]! ^ t[k]!);
    x[4 * W32 + k] = t[k]!;
  }
  L1(x, h1);
  L2(h1, h2);
  let s = 0;
  for (let o = 0; o < 32; o++) s += (h2[0]! >>> o) & 1 ? head[o]! : -head[o]!;
  return s;
}

// Ingest: 3,000 items of about 300 n-gram ids.
const items = Array.from({ length: 3_000 }, () => Uint32Array.from({ length: 300 }, () => (rnd() * BUCKETS) >>> 0));
const codes = Array.from({ length: 3_000 }, () => new Uint32Array(W32));
for (let r = 0; r < 2; r++) for (let n = 0; n < 200; n++) encode(items[n]!, codes[n]!); // warm-up
let t0 = performance.now();
for (let n = 0; n < items.length; n++) encode(items[n]!, codes[n]!);
const ingestUs = ((performance.now() - t0) * 1_000) / items.length;

// Request: encode the request (40 ids), then score 95 candidates.
const q = new Uint32Array(W32);
const reqIds = Uint32Array.from({ length: 40 }, () => (rnd() * BUCKETS) >>> 0);
let sink = 0;
for (let r = 0; r < 200; r++) sink += score(codes[r]!, codes[r + 1]!, codes[r + 2]!);
const reps = 200;
t0 = performance.now();
for (let r = 0; r < reps; r++) {
  encode(reqIds, q);
  for (let c = 0; c < 95; c++) sink += score(q, codes[(r * 95 + c) % 3_000]!, codes[(r * 95 + c + 7) % 3_000]!);
}
const requestUs = ((performance.now() - t0) * 1_000) / reps;
t0 = performance.now();
for (let r = 0; r < 20_000; r++) sink += score(q, codes[r % 3_000]!, codes[(r + 7) % 3_000]!);
const candidateUs = ((performance.now() - t0) * 1_000) / 20_000;

const tableBytes = plus.byteLength + minus.byteLength;
const scorerBytes = 128 * 5 * W32 * 4 + 32 * 4 * 4 + 32;
console.log(
  JSON.stringify({
    ingest_us_item: +ingestUs.toFixed(2),
    request_us_95_candidates: +requestUs.toFixed(1),
    candidate_us: +candidateUs.toFixed(3),
    user_bytes_3000_items: 3_000 * W32 * 4,
    shared_model_bytes: tableBytes + scorerBytes,
    sink: sink % 7,
  }),
);
