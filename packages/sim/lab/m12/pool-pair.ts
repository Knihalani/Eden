/**
 * M12 (lab only; D1002 rejected the trial `poolScan` and deleted its engine wiring; docs/research/m12-pool.md): the
 * TypeScript forward of the request × item scorer distilled offline from an
 * 8B teacher's scores (packages/sim/lab/m12/pairnet.py), served as a binary network. No model call, no vectors from a
 * pretrained model: hashed word, character 3/4-gram and word-bigram ids of the engine's own terms, a ternary table
 * into a sign code (an item's at ingest or first use, the request's once), then
 * - the scan score: the two codes' agreement (bits that match, scaled), read for every held item, and
 * - the pair score: two binary layers over [request XNOR item, request, item] and a float head, read for candidates.
 *
 * The file (`EP12`, version 1, little-endian; export_pair.py): magic, u32 version, bits B, buckets NB, width W, 32,
 * f32 scan scale; then the request encoder (+1 plane NB×B/32 u32, −1 plane, f32 scale B, f32 shift B), the item
 * encoder (the same), layer 1 (W rows of 3B/32 u32 sign words, f32 scale W, f32 shift W), layer 2 (32 rows of W/32
 * words, scale 32, shift 32), head (f32 × 32, f32 bias).
 */

const MAGIC = 0x32315045; // "EP12"

/** zlib's CRC-32 (the trainer hashes grams with Python's `zlib.crc32` over UTF-8 bytes). */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
/** CRC-32 state after one more byte. */
function step(c: number, b: number): number {
  return CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
}

/** The CRC state after `s[start, end)` as UTF-8, from state `c` (no allocation). */
function crcRange(c: number, s: string, start: number, end: number): number {
  for (let k = start; k < end; k++) {
    let u = s.charCodeAt(k);
    if (u >= 0xd800 && u < 0xdc00 && k + 1 < end) {
      const lo = s.charCodeAt(k + 1);
      if (lo >= 0xdc00 && lo < 0xe000) {
        u = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00);
        k++;
      }
    }
    if (u < 0x80) c = step(c, u);
    else if (u < 0x800) c = step(step(c, 0xc0 | (u >> 6)), 0x80 | (u & 63));
    else if (u < 0x10000) c = step(step(step(c, 0xe0 | (u >> 12)), 0x80 | ((u >> 6) & 63)), 0x80 | (u & 63));
    else
      c = step(step(step(step(c, 0xf0 | (u >> 18)), 0x80 | ((u >> 12) & 63)), 0x80 | ((u >> 6) & 63)), 0x80 | (u & 63));
  }
  return c;
}

const fin = (c: number) => (c ^ 0xffffffff) >>> 0;
const W_ = step(0xffffffff, 119); // "w"
const C_ = step(0xffffffff, 99); // "c"
const B_ = step(0xffffffff, 98); // "b"
const LT = 60; // "<"
const GT = 62; // ">"

/** pairnet.py's `grams` over a term list: sorted distinct bucket ids, at most `cap`. */
export function gramsOf(terms: readonly string[], buckets: number, cap = 400): Uint32Array {
  const out = new Set<number>();
  const n = Math.min(terms.length, 200);
  for (let i = 0; i < n; i++) {
    const t = terms[i]!;
    out.add(fin(crcRange(W_, t, 0, t.length)) % buckets);
    // The character n-grams of "<t>": the first starts with "<", the last ends with ">".
    const L = t.length + 2;
    for (let g = 3; g <= 4; g++) {
      for (let k = 0; k + g <= L; k++) {
        let c = C_;
        const from = k === 0 ? 0 : k - 1;
        if (k === 0) c = step(c, LT);
        const to = Math.min(t.length, k + g - 1);
        c = crcRange(c, t, from, to);
        if (k + g === L) c = step(c, GT);
        out.add(fin(c) % buckets);
      }
    }
  }
  for (let i = 0; i + 1 < n; i++) {
    const a = terms[i]!;
    const b = terms[i + 1]!;
    out.add(fin(crcRange(step(crcRange(B_, a, 0, a.length), 32), b, 0, b.length)) % buckets);
  }
  const ids = Uint32Array.from(out).sort();
  return ids.length === 0 ? Uint32Array.of(0) : ids.subarray(0, cap);
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export interface PoolPair {
  readonly bits: number;
  readonly buckets: number;
  /** Bytes the model holds. */
  readonly bytes: number;
  /** A request's code, from its query terms (stopwords out). */
  code(terms: readonly string[], side: "request"): Int32Array;
  /** An item's code, from its title's terms and its text's (the file says how many of the text's it reads). */
  itemCode(title: readonly string[], text: readonly string[]): Int32Array;
  /** The codes' agreement, scaled (the scan score). */
  scan(q: Int32Array, i: Int32Array): number;
  /** The pair score of a request code and an item code. */
  score(q: Int32Array, i: Int32Array): number;
}

/** Reads an `EP12` file. Throws on a malformed one (a deploy error, not a request's). */
export function loadPoolPair(buf: Uint8Array): PoolPair {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 28 || view.getUint32(0, true) !== MAGIC) throw new Error("pool pair: not an EP12 file");
  const version = view.getUint32(4, true);
  if (version !== 1 && version !== 2) throw new Error("pool pair: unknown version");
  const B = view.getUint32(8, true);
  const NB = view.getUint32(12, true);
  const W = view.getUint32(16, true);
  const H = view.getUint32(20, true);
  const dscale = view.getFloat32(24, true);
  // Version 2: an item is read as its title's terms and its text's first `itemCap` (0: all).
  const itemCap = version >= 2 ? view.getUint32(28, true) : 0;
  if (B % 32 || W % 32 || H !== 32) throw new Error("pool pair: bad shape");
  const bw = B / 32;
  let at = version >= 2 ? 32 : 28;
  // Copies, so every array is 4-byte aligned whatever the buffer's offset.
  // Bit words as Int32Array: bitwise operators work on int32, and a Uint32Array element over 2^31 is not a small
  // integer to the JIT (a pair score ran 6x slower with them).
  const u32 = (n: number) => {
    const out = new Int32Array(n);
    for (let k = 0; k < n; k++) out[k] = view.getInt32(at + 4 * k, true);
    at += 4 * n;
    return out;
  };
  const f32 = (n: number) => {
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = view.getFloat32(at + 4 * k, true);
    at += 4 * n;
    return out;
  };
  const side = () => ({ pos: u32(NB * bw), neg: u32(NB * bw), scale: f32(B), shift: f32(B) });
  const qe = side();
  const ie = side();
  const in1 = (3 * B) / 32;
  const l1 = { w: u32(W * in1), scale: f32(W), shift: f32(W) };
  const l2 = { w: u32(H * (W / 32)), scale: f32(H), shift: f32(H) };
  const head = f32(H);
  const bias = f32(1)[0]!;
  if (at !== buf.byteLength) throw new Error("pool pair: trailing bytes");
  const count = new Int32Array(B);
  const xnor = new Int32Array(bw);
  const h1 = new Int32Array(W / 32);
  const qPart = new Int32Array(W);
  let lastQ: Int32Array | null = null;
  const [l1w, l1s, l1t] = [l1.w, l1.scale, l1.shift];
  const [l2w, l2s, l2t] = [l2.w, l2.scale, l2.shift];
  const encode = (e: typeof qe, terms: readonly string[]): Int32Array => {
    count.fill(0);
    const g = gramsOf(terms, NB);
    for (let k = 0; k < g.length; k++) {
      const row = g[k]! * bw;
      for (let j = 0; j < bw; j++) {
        let p = e.pos[row + j]!;
        let n = e.neg[row + j]!;
        const base = j * 32;
        while (p !== 0) {
          const b = 31 - Math.clz32(p & -p);
          count[base + b]!++;
          p &= p - 1;
        }
        while (n !== 0) {
          const b = 31 - Math.clz32(n & -n);
          count[base + b]!--;
          n &= n - 1;
        }
      }
    }
    const out = new Int32Array(bw);
    for (let b = 0; b < B; b++) if (count[b]! * e.scale[b]! + e.shift[b]! >= 0) out[b >>> 5]! |= 1 << (b & 31);
    return out;
  };
  return {
    bits: B,
    buckets: NB,
    bytes: buf.byteLength,
    code(terms) {
      return encode(qe, terms);
    },
    itemCode(title, text) {
      return encode(
        ie,
        itemCap > 0 && text.length > itemCap ? [...title, ...text.slice(0, itemCap)] : [...title, ...text],
      );
    },
    scan(q, i) {
      let diff = 0;
      for (let j = 0; j < bw; j++) diff += popcount(q[j]! ^ i[j]!);
      return (B - 2 * diff) * dscale;
    },
    score(q, i) {
      // Layer 1's input bits: [q XNOR i, q, i] (a set bit is +1). The q part of each row's mismatches is the same for
      // every candidate of a request, so it is counted once a request (`qPart`, keyed by the code array).
      if (q !== lastQ) {
        lastQ = q;
        for (let o = 0; o < W; o++) {
          let d = 0;
          const row = o * in1 + bw;
          for (let j = 0; j < bw; j++) d += popcount(q[j]! ^ l1w[row + j]!);
          qPart[o] = d;
        }
      }
      for (let j = 0; j < bw; j++) xnor[j] = ~(q[j]! ^ i[j]!);
      h1.fill(0);
      for (let o = 0; o < W; o++) {
        let diff = qPart[o]!;
        const row = o * in1;
        const r2 = row + 2 * bw;
        for (let j = 0; j < bw; j++) diff += popcount(xnor[j]! ^ l1w[row + j]!) + popcount(i[j]! ^ l1w[r2 + j]!);
        if ((3 * B - 2 * diff) * l1s[o]! + l1t[o]! >= 0) h1[o >>> 5]! |= 1 << (o & 31);
      }
      let s = bias;
      const w2 = W / 32;
      for (let o = 0; o < H; o++) {
        let diff = 0;
        for (let j = 0; j < w2; j++) diff += popcount(h1[j]! ^ l2w[o * w2 + j]!);
        s += (W - 2 * diff) * l2s[o]! + l2t[o]! >= 0 ? head[o]! : -head[o]!;
      }
      return s;
    },
  };
}
