/**
 * M3b (D907 follow-on): H10's compressed supersession network in plain TypeScript, from `h10.py export`'s flat files.
 *
 * At ingest an item is encoded once: binnet's hashed n-grams, a sum of table rows (int8 with a float32 scale a row,
 * low rank r), a projection r -> d with the batch norm folded in, tanh, and the code stored as d int8 values (or d
 * sign bits). A pair (older, newer) then costs only the head: [a, b, a*b] -> h units -> tanh -> one logit.
 *
 * Checks its logits and decisions (at the dev threshold for precision 0.95, and at 0) against PyTorch's on the exported
 * held-out pairs, and times an item's encoding over many texts and a pair's score.
 *
 *   bun packages/sim/lab/m3r/h10-forward.ts DIR [DIR...]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
const WORD = /[a-z0-9£$€]+/g;
const utf8 = new TextEncoder();
const LT = "<".charCodeAt(0);
const GT = ">".charCodeAt(0);

/** CRC-32 (zlib's) of a one-byte tag followed by `bytes[from, to)`, with no string built. */
function crcOf(tag: number, bytes: Uint8Array, from: number, to: number): number {
  let c = CRC[(0xffffffff ^ tag) & 0xff]! ^ (0xffffffff >>> 8);
  for (let i = from; i < to; i++) c = CRC[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

let buf = new Uint8Array(4096);
let ends = new Int32Array(1024);
const seen = new Uint8Array(1 << 16);
const found = new Int32Array(8192);

/**
 * binnet.py's `grams` (words, character 3- and 4-grams of "<word>", word bigrams; CRC-32 into 2^16 buckets; sorted,
 * at most 300), with identical ids but no per-n-gram strings: each word's UTF-8 bytes go once into a buffer and every
 * n-gram is a CRC over a byte range (character n-grams by character boundaries, so £ and € count as one character).
 */
export function fastGrams(text: string, cap = 300): number[] {
  const words = (text.toLowerCase().match(WORD) ?? []).slice(0, 150);
  let nf = 0;
  const add = (h: number) => {
    const g = h & 0xffff;
    if (!seen[g]) {
      seen[g] = 1;
      found[nf++] = g;
    }
  };
  let prevFrom = -1;
  let prevTo = -1;
  let pos = 0;
  for (const w of words) {
    // "<" + word + ">" at buf[pos..], with the byte offset where each character ends. When the buffer would overflow,
    // the previous word (needed for this bigram) moves to the front first.
    const need = 3 * w.length + 2;
    if (2 * need > buf.length || w.length + 2 > ends.length) {
      // A very long word: grow the buffers (keeping the previous word's bytes).
      const nb = new Uint8Array(4 * need + 4096);
      nb.set(buf.subarray(0, pos));
      buf = nb;
      ends = new Int32Array(Math.max(ends.length, w.length + 2));
    }
    if (pos + need > buf.length) {
      buf.copyWithin(0, prevFrom, prevTo);
      prevTo -= prevFrom;
      prevFrom = 0;
      pos = prevTo;
    }
    const start = pos;
    buf[pos++] = LT;
    let nc = 0;
    ends[nc++] = pos;
    utf8.encodeInto(w, buf.subarray(pos));
    for (let i = 0; i < w.length; i++) {
      const code = w.charCodeAt(i);
      pos += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      ends[nc++] = pos;
    }
    buf[pos++] = GT;
    ends[nc++] = pos;
    const wFrom = start + 1;
    const wTo = pos - 1;
    add(crcOf(0x77, buf, wFrom, wTo)); // "w" + word
    // character n-grams: characters [k, k+n) of "<word>", their bytes from ends[k-1] (or start) to ends[k+n-1]
    for (const n of [3, 4])
      for (let k = 0; k + n <= nc; k++) add(crcOf(0x63, buf, k ? ends[k - 1]! : start, ends[k + n - 1]!));
    if (prevFrom >= 0) {
      // "b" + previous + " " + this word: CRC over the previous word's bytes, a space, then this word's bytes.
      let c = CRC[(0xffffffff ^ 0x62) & 0xff]! ^ (0xffffffff >>> 8);
      for (let i = prevFrom; i < prevTo; i++) c = CRC[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
      c = CRC[(c ^ 0x20) & 0xff]! ^ (c >>> 8);
      for (let i = wFrom; i < wTo; i++) c = CRC[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
      add((c ^ 0xffffffff) >>> 0);
    }
    prevFrom = wFrom;
    prevTo = wTo;
  }
  const out = Array.from(found.subarray(0, nf)).sort((a, b) => a - b);
  for (let i = 0; i < nf; i++) seen[found[i]!] = 0;
  return out.slice(0, cap);
}

type Meta = {
  cfg: { buckets: number; d: number; r: number; table: string; code: "int8" | "bits" | "float"; h: number };
  size_bytes: number;
  code_bytes: number;
  threshold_p95_dev: number;
  arrays: Record<string, { dtype: string; shape: number[] }>;
  checks: { a: string; b: string; logit: number; label: number }[];
};

/** Round half to even, as PyTorch's `round` (the int8 code must match it exactly on ties). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function h10Network(dir: string) {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
  const arr = (name: string) => {
    if (!meta.arrays[name]) return undefined;
    const buf = readFileSync(join(dir, `${name}.bin`));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const dt = meta.arrays[name]!.dtype;
    return dt === "int8" ? new Int8Array(ab) : dt === "uint8" ? new Uint8Array(ab) : new Float32Array(ab);
  };
  const { buckets, d, code } = meta.cfg;
  // An int4 table ships packed (`table4`: two values a byte, read in place); int8 and float tables as they are.
  const table4 = arr("table4") as Uint8Array | undefined;
  const table = table4 ?? arr("table")!;
  const rowScale = arr("row_scale") as Float32Array | undefined;
  const width = table4 ? meta.arrays.table4!.shape[1]! * 2 : meta.arrays.table!.shape[1]!; // r (low rank), else d
  const proj = arr("proj") as Float32Array | undefined; // d x r, the encoder's batch norm folded in
  const encS = arr("enc_s") as Float32Array | undefined;
  const encH = arr("enc_h") as Float32Array;
  const l1 = arr("l1") as Float32Array; // h x 3d
  const n1S = arr("n1_s") as Float32Array;
  const n1H = arr("n1_h") as Float32Array;
  const outW = arr("out_w") as Float32Array;
  const outB = (arr("out_b") as Float32Array)[0]!;
  const H = n1S.length;
  // The int8 code is q/127: fold the 1/127 (and 1/127^2 for the product) into the head's weights once.
  const qa = code === "int8" ? 1 / 127 : 1;
  const Wa = new Float64Array(H * d);
  const Wb = new Float64Array(H * d);
  const Wab = new Float64Array(H * d);
  for (let o = 0; o < H; o++)
    for (let k = 0; k < d; k++) {
      Wa[o * d + k] = l1[o * 3 * d + k]! * qa;
      Wb[o * d + k] = l1[o * 3 * d + d + k]! * qa;
      Wab[o * d + k] = l1[o * 3 * d + 2 * d + k]! * qa * qa;
    }
  const acc = new Float64Array(width);

  /** An item's stored code: d int8 values (q in [-127, 127]) or d signs (±1). Runs once an item, at ingest. */
  const encode = (text: string): Int8Array | Float32Array => {
    acc.fill(0);
    const ids = fastGrams(text);
    for (const g0 of ids.length ? ids : [0]) {
      const g = g0 % buckets;
      const s = rowScale ? rowScale[g]! : 1;
      if (table4) {
        // Each byte holds columns 2k (low nibble) and 2k+1 (high), 4-bit two's complement.
        const base = (g * width) >> 1;
        for (let k = 0; k < width; k += 2) {
          const b = table4[base + (k >> 1)]!;
          acc[k]! += (((b & 15) ^ 8) - 8) * s;
          acc[k + 1]! += (((b >> 4) ^ 8) - 8) * s;
        }
      } else {
        const base = g * width;
        for (let k = 0; k < width; k++) acc[k]! += table[base + k]! * s;
      }
    }
    // A float-code net (a full-width teacher) keeps tanh as is; the students store int8 or signs.
    const out = code === "float" ? new Float32Array(d) : new Int8Array(d);
    for (let j = 0; j < d; j++) {
      let pre: number;
      if (proj) {
        let s = 0;
        const base = j * width;
        for (let k = 0; k < width; k++) s += proj[base + k]! * acc[k]!;
        pre = s + encH[j]!;
      } else pre = acc[j]! * encS![j]! + encH[j]!;
      out[j] =
        code === "bits" ? (pre >= 0 ? 1 : -1) : code === "float" ? Math.tanh(pre) : roundEven(Math.tanh(pre) * 127);
    }
    return out;
  };

  const ab = new Float64Array(d);
  /** The logit that `newer` replaces `older`, from their stored codes. Runs a pair. */
  const replaces = (a: Int8Array | Float32Array, b: Int8Array | Float32Array): number => {
    for (let k = 0; k < d; k++) ab[k] = a[k]! * b[k]!;
    let y = outB;
    for (let o = 0; o < H; o++) {
      let s = 0;
      const base = o * d;
      for (let k = 0; k < d; k++) s += Wa[base + k]! * a[k]! + Wb[base + k]! * b[k]! + Wab[base + k]! * ab[k]!;
      y += outW[o]! * Math.tanh(s * n1S[o]! + n1H[o]!);
    }
    return y;
  };
  type Code = Int8Array | Float32Array;
  /** One half of the head's first layer for an item: W·a (W_a as the older item, W_b as the newer). */
  const half = (W: Float64Array, a: Code): Float64Array => {
    const u = new Float64Array(H);
    for (let o = 0; o < H; o++) {
      let s0 = 0;
      let s1 = 0;
      const base = o * d;
      for (let k = 0; k < d; k += 2) {
        s0 += W[base + k]! * a[k]!;
        s1 += W[base + k + 1]! * a[k + 1]!;
      }
      u[o] = s0 + s1;
    }
    return u;
  };
  /**
   * Many pairs at once (D914): each older item's W_a·a and each newer item's W_b·b are computed once, so a pair pays
   * only W_ab·(a⊙b), a third of `replaces`' multiply-adds. Same logits as `replaces` up to float summation order.
   */
  const replacesMany = (pairs: readonly (readonly [Code, Code])[]): number[] => {
    const us = new Map<Code, Float64Array>();
    const vs = new Map<Code, Float64Array>();
    return pairs.map(([a, b]) => {
      let u = us.get(a);
      if (!u) us.set(a, (u = half(Wa, a)));
      let v = vs.get(b);
      if (!v) vs.set(b, (v = half(Wb, b)));
      for (let k = 0; k < d; k++) ab[k] = a[k]! * b[k]!;
      let y = outB;
      for (let o = 0; o < H; o++) {
        let s0 = 0;
        let s1 = 0;
        const base = o * d;
        for (let k = 0; k < d; k += 2) {
          s0 += Wab[base + k]! * ab[k]!;
          s1 += Wab[base + k + 1]! * ab[k + 1]!;
        }
        y += outW[o]! * Math.tanh((u[o]! + v[o]! + s0 + s1) * n1S[o]! + n1H[o]!);
      }
      return y;
    });
  };
  return { meta, encode, replaces, replacesMany };
}

if (import.meta.main) {
  for (const dir of process.argv.slice(2)) {
    const net = h10Network(dir);
    const { meta } = net;
    const th = meta.threshold_p95_dev;
    let maxErr = 0;
    let same0 = 0;
    let sameTh = 0;
    const many = net.replacesMany(meta.checks.map((c) => [net.encode(c.a), net.encode(c.b)] as const));
    let maxErrMany = 0;
    let sameMany = 0;
    meta.checks.forEach((c, i) => {
      maxErrMany = Math.max(maxErrMany, Math.abs(many[i]! - c.logit));
      sameMany += many[i]! >= th === c.logit >= th ? 1 : 0;
    });
    for (const c of meta.checks) {
      const got = net.replaces(net.encode(c.a), net.encode(c.b));
      maxErr = Math.max(maxErr, Math.abs(got - c.logit));
      same0 += got >= 0 === c.logit >= 0 ? 1 : 0;
      sameTh += got >= th === c.logit >= th ? 1 : 0;
    }
    // Timing over the checks' distinct texts (real item lengths), warmed up first.
    const texts = [...new Set(meta.checks.flatMap((c) => [c.a, c.b]))];
    for (const t of texts) net.encode(t);
    const reps = 20;
    let t0 = performance.now();
    let codes: (Int8Array | Float32Array)[] = [];
    for (let r = 0; r < reps; r++) codes = texts.map((t) => net.encode(t));
    const encodeUs = ((performance.now() - t0) * 1000) / (reps * texts.length);
    let sink = 0;
    const n = codes.length;
    for (let i = 0; i < 2000; i++) sink += net.replaces(codes[i % n]!, codes[(i * 7 + 1) % n]!);
    const pairs = 50_000;
    t0 = performance.now();
    for (let i = 0; i < pairs; i++) sink += net.replaces(codes[i % n]!, codes[(i * 7 + 1) % n]!);
    const pairUs = ((performance.now() - t0) * 1000) / pairs;
    // A push pass as the trial asks it (D914): 5 handed items against up to 15 newer pooled ones, `npairs` pairs over
    // 20 distinct codes, scored in one batch.
    const pass = (npairs: number) => {
      const ps: [Int8Array | Float32Array, Int8Array | Float32Array][] = [];
      for (let i = 0; i < npairs; i++) ps.push([codes[i % 5]!, codes[5 + (i % 15)]!]);
      for (let w = 0; w < 50; w++) net.replacesMany(ps);
      const reps = 400;
      const t = performance.now();
      for (let r = 0; r < reps; r++) sink += net.replacesMany(ps)[0]!;
      return +(((performance.now() - t) * 1000) / reps).toFixed(1);
    };
    const passUs = Object.fromEntries((process.env.H10_PASS_PAIRS ?? "29,44,60").split(",").map((n) => [n, pass(+n)]));
    console.log(
      JSON.stringify({
        dir,
        cfg: meta.cfg,
        size_bytes: meta.size_bytes,
        code_bytes: meta.code_bytes,
        checks: meta.checks.length,
        max_abs_err_vs_torch: +maxErr.toFixed(5),
        same_decision_at_0: same0,
        same_decision_at_p95_threshold: sameTh,
        batch_max_abs_err_vs_torch: +maxErrMany.toFixed(5),
        batch_same_decision_at_p95_threshold: sameMany,
        pass_us_by_pairs: passUs,
        encode_us_item: +encodeUs.toFixed(1),
        pair_us: +pairUs.toFixed(2),
        texts: texts.length,
        sink: Math.sign(sink),
      }),
    );
  }
}
