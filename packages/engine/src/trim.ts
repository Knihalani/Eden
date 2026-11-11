/**
 * `packetTrim` (M6, D920; docs/research/m6-trimmer.md): a small learned model that scores each part of a packet item
 * (a sentence or line as `messageParts` splits it) by whether it carries the fact the request needs. No model call
 * and no network: hashed word, bigram and character n-grams of the part (CRC-32 into a fixed table of int8 weights),
 * the request's words it shares, the request's words crossed with the part's status words, and a few numbers about
 * the part and its place in the item. Trained in the lab (`packages/sim/lab/m6/cands.py`) on simulated and
 * generated worlds only; the weights are one file shipped with the engine, read once per process.
 *
 * Every feature mirrors cands.py exactly (the lab's parity check compares the scores on 64 exported parts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Part } from "./render";
import { isStopword } from "./text";

/** The shipped weights (`trim-model.json`, next to this file's package root). */
export const TRIM_MODEL_PATH = join(import.meta.dir, "..", "models", "trim-model.json");

interface TrimModel {
  arch: string;
  /** False for a model trained without the request (cands.py's h5): it reads the part alone. */
  request?: boolean;
  buckets: number;
  /** int8 weights of the hashed features, base64; a feature's weight is `w[i] * scale`. */
  weights: string;
  scale: number;
  dense: number[];
  bias: number;
  threshold: number;
}

const WORD = /[\p{L}\p{N}]+/gu;
const DIGIT = /\d/g;
const STATUS =
  /\b(already|cancel+ed|called off|no longer|not|n't|never|postponed|moved|resched\w*|instead|closed|suspended|paid|refund\w*|done|submitted|expired|blocked|on hold|replaced|changed|withdrawn|declined|full|until|only|must|need|before|deadline|don't|do not|please|warning|important|urgent)\b/gi;
const DATE = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const TIME = /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2} ?(am|pm)\b/i;
const AMOUNT = /[£$€]\s?\d|\d+(\.\d+)? ?(gbp|usd|eur|pounds)\b/i;
const HEADER_KIND = /^(from|date|subject|to):/i;

const toks = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];

/** cands.py's `focus_of`: the request's words, one-letter words and stopwords dropped. */
export function focusOf(request: string): Set<string> {
  return new Set(toks(request).filter((w) => w.length > 1 && !isStopword(w)));
}

// CRC-32 (IEEE, as Python's zlib.crc32), table-driven so a hashed n-gram continues from its prefix's state over the
// word's UTF-8 bytes: no string is built per n-gram (string building was most of the trimmer's time).
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const utf8 = new TextEncoder();
function update(c: number, bytes: Uint8Array, a: number, b: number): number {
  for (let i = a; i < b; i++) c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return c;
}
const stateOf = (s: string) => update(0xffffffff, utf8.encode(s), 0, utf8.encode(s).length);
const done = (c: number, buckets: number) => ((c ^ 0xffffffff) >>> 0) % buckets;
const crc = (s: string, buckets: number) => done(stateOf(s), buckets);
const PREFIX = new Map<string, number>();
const prefixState = (s: string) => {
  let c = PREFIX.get(s);
  if (c === undefined) PREFIX.set(s, (c = stateOf(s)));
  return c;
};
const LT = 60; // "<"
const GT = 62; // ">"
const SPACE = new Uint8Array([32]);

/** m6lib.py's `grams`: hashed words, character 3- and 4-grams inside words, word bigrams (first 120 words). */
export function grams(words: readonly string[], buckets: number, prefix: string, out: Set<number>): void {
  const ws = words.slice(0, 120);
  const pw = prefixState(`${prefix}w`);
  const pc = prefixState(`${prefix}c`);
  const pb = prefixState(`${prefix}b`);
  const enc: Uint8Array[] = [];
  for (const w of ws) {
    const bytes = utf8.encode(w);
    enc.push(bytes);
    out.add(done(update(pw, bytes, 0, bytes.length), buckets));
    // "<w>" by code points (Python slices code points): each one's byte offset in "<" + bytes + ">".
    const p = new Uint8Array(bytes.length + 2);
    p[0] = LT;
    p.set(bytes, 1);
    p[p.length - 1] = GT;
    const off: number[] = [];
    for (let i = 0; i < p.length; i++) if ((p[i]! & 0xc0) !== 0x80) off.push(i);
    off.push(p.length);
    const cps = off.length - 1;
    for (const n of [3, 4])
      for (let k = 0; k + n <= cps; k++) out.add(done(update(pc, p, off[k]!, off[k + n]!), buckets));
  }
  for (let k = 0; k + 1 < enc.length; k++) {
    let c = update(pb, enc[k]!, 0, enc[k]!.length);
    c = update(c, SPACE, 0, 1);
    out.add(done(update(c, enc[k + 1]!, 0, enc[k + 1]!.length), buckets));
  }
}

const count = (re: RegExp, s: string) => s.match(re)?.length ?? 0;
const isUpper = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();

/** cands.py's `dense` with `item_stats`: 27 numbers a part. */
export function denseOf(
  parts: readonly Part[],
  words: readonly (readonly string[])[],
  focus: ReadonlySet<string>,
  title: string,
): number[][] {
  const sets = words.map((w) => new Set(w));
  const n = parts.length;
  const ov = sets.map((set) => {
    let c = 0;
    for (const w of set) if (focus.has(w)) c++;
    return c;
  });
  const st = parts.map((p) => count(STATUS, p.text));
  const dg = parts.map((p) => count(DIGIT, p.text));
  const first = parts.findIndex((p) => !p.header);
  const maxOv = Math.max(...ov);
  const maxSt = Math.max(...st);
  const maxDg = Math.max(...dg);
  const titleHit = toks(title).some((w) => focus.has(w)) ? 1 : 0;
  return parts.map((p, k) => {
    const t = p.text;
    const ws = sets[k]!;
    const o = ov[k]!;
    const kind = HEADER_KIND.exec(t)?.[1]?.toLowerCase() ?? "";
    return [
      1,
      k / Math.max(n - 1, 1),
      k === 0 ? 1 : 0,
      k === n - 1 ? 1 : 0,
      p.quoted ? 1 : 0,
      p.header ? 1 : 0,
      kind === "from" ? 1 : 0,
      kind === "date" ? 1 : 0,
      kind === "subject" || kind === "to" ? 1 : 0,
      Math.log1p(Buffer.byteLength(t)) / 6,
      Math.min(dg[k]!, 10) / 10,
      Math.min(o, 5) / 5,
      o / Math.max(ws.size, 1),
      o ? 1 : 0,
      DATE.test(t) ? 1 : 0,
      TIME.test(t) ? 1 : 0,
      AMOUNT.test(t) ? 1 : 0,
      Math.min(st[k]!, 3) / 3,
      Math.log1p(n) / 3,
      titleHit,
      t.includes("!") || isUpper(t) ? 1 : 0,
      t.includes("?") ? 1 : 0,
      o && o === maxOv ? 1 : 0,
      ov.filter((x) => x > o).length / Math.max(n, 1),
      st[k] && st[k] === maxSt ? 1 : 0,
      dg[k] && dg[k] === maxDg ? 1 : 0,
      k === first ? 1 : 0,
    ];
  });
}

/** cands.py's `sparse` with the request: the part's grams, shared words, request words × the part's status words. */
export function sparseOf(
  text: string,
  words: readonly string[],
  focus: ReadonlySet<string>,
  buckets: number,
): number[] {
  const out = new Set<number>();
  grams(words, buckets, "p", out);
  const ids = [...out];
  for (const w of new Set(words)) if (focus.has(w)) ids.push(crc(`s${w}`, buckets));
  const status = [...text.matchAll(STATUS)].slice(0, 4).map((m) => m[0].toLowerCase());
  const rq = [...focus].sort().slice(0, 12);
  for (const a of rq) for (const b of status) ids.push(crc(`x${a}|${b}`, buckets));
  return ids;
}

const f32 = (b64: string): Float32Array => {
  const b = Buffer.from(b64, "base64");
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * h3, the thread model (cands.py `Thread`): each part a sign code from a ternary hashed table (2 bits a weight,
 * batch norm folded to a scale and shift a bit) beside its 27 numbers, a one-layer bidirectional GRU over the item's
 * parts in order, a linear head on its output and the numbers, plus the linear model's terms.
 */
class ThreadNet {
  private readonly tern: Uint8Array;
  private readonly s: Float32Array;
  private readonly h: Float32Array;
  private readonly g: Record<string, Float32Array> = {};
  private readonly headW: Float32Array;
  private readonly lrW: Float32Array;
  readonly bits: number;
  readonly hidden: number;
  private readonly acc: Int32Array;
  private readonly hBuf: Float64Array;
  /** Per direction, each input row's sum over the sign code's columns (for the ±1 product). */
  private readonly rowSums: Float64Array[];
  private readonly giBuf: Float64Array;
  private readonly ghBuf: Float64Array;
  constructor(private readonly m: ThreadModel) {
    this.tern = new Uint8Array(Buffer.from(m.ternary, "base64"));
    this.s = f32(m.bn_scale);
    this.h = f32(m.bn_shift);
    for (const k of GRU_KEYS) this.g[k] = f32(m[k]);
    this.headW = f32(m.head_w);
    this.lrW = f32(m.lr_w);
    this.bits = m.bits;
    this.hidden = m.hidden;
    this.acc = new Int32Array(m.bits);
    this.rowSums = (["", "_reverse"] as const).map((dir) => {
      const wi = this.g[`weight_ih_l0${dir}`]!;
      const width = m.bits + 27;
      const sums = new Float64Array(3 * m.hidden);
      for (let r = 0; r < sums.length; r++) for (let c = 0; c < m.bits; c++) sums[r]! += wi[r * width + c]!;
      return sums;
    });
    this.hBuf = new Float64Array(m.hidden);
    this.giBuf = new Float64Array(3 * m.hidden);
    this.ghBuf = new Float64Array(3 * m.hidden);
  }

  /** The part's sign code (±1 a bit) from its hashed feature ids. */
  private code(ids: readonly number[], out: Float32Array, at: number): void {
    const B = this.bits; // a multiple of 4: a row is B / 4 whole bytes
    const acc = this.acc;
    acc.fill(0);
    const t = this.tern;
    for (const id of ids) {
      let i = (id * B) >> 2;
      for (let b = 0; b < B; b += 4, i++) {
        const d = t[i]! << 2;
        acc[b]! += DECODE[d]!;
        acc[b + 1]! += DECODE[d + 1]!;
        acc[b + 2]! += DECODE[d + 2]!;
        acc[b + 3]! += DECODE[d + 3]!;
      }
    }
    const a = this.m.a;
    for (let b = 0; b < B; b++) out[at + b] = acc[b]! * a * this.s[b]! + this.h[b]! >= 0 ? 1 : -1;
  }

  /** One GRU direction over the inputs (n × width), writing its hidden states into `out` at column `col`. */
  private run(x: Float32Array, n: number, width: number, dir: "" | "_reverse", out: Float32Array, col: number): void {
    const H = this.hidden;
    const H3 = 3 * H;
    const wi = this.g[`weight_ih_l0${dir}`]!;
    const wh = this.g[`weight_hh_l0${dir}`]!;
    const bi = this.g[`bias_ih_l0${dir}`]!;
    const bh = this.g[`bias_hh_l0${dir}`]!;
    const rowSum = this.rowSums[dir === "" ? 0 : 1]!;
    const B = this.bits;
    const h = this.hBuf;
    h.fill(0);
    const gi = this.giBuf;
    const gh = this.ghBuf;
    for (let step = 0; step < n; step++) {
      const k = dir ? n - 1 - step : step;
      const xo = k * width;
      for (let r = 0; r < H3; r++) {
        // The first `bits` inputs are ±1: their product is the row's sum over them, less twice the −1 columns' weights.
        let si = bi[r]! + rowSum[r]!;
        const row = r * width;
        for (let c = 0; c < B; c++) if (x[xo + c]! < 0) si -= 2 * wi[row + c]!;
        for (let c = B; c < width; c++) si += wi[row + c]! * x[xo + c]!;
        gi[r] = si;
        let sh = bh[r]!;
        let rowh = r * H;
        for (let c = 0; c < H; c++, rowh++) sh += wh[rowh]! * h[c]!;
        gh[r] = sh;
      }
      const o = k * 2 * H + col;
      for (let j = 0; j < H; j++) {
        const rg = sigmoid(gi[j]! + gh[j]!);
        const zg = sigmoid(gi[H + j]! + gh[H + j]!);
        const ng = Math.tanh(gi[2 * H + j]! + rg * gh[2 * H + j]!);
        const hj = (1 - zg) * ng + zg * h[j]!;
        h[j] = hj;
        out[o + j] = hj;
      }
    }
  }

  score(parts: readonly Part[], ids: number[][], dense: number[][]): Float64Array {
    const n = parts.length;
    const B = this.bits;
    const width = B + 27;
    const x = new Float32Array(n * width);
    for (let k = 0; k < n; k++) {
      this.code(ids[k]!, x, k * width);
      for (let j = 0; j < 27; j++) x[k * width + B + j] = dense[k]![j]!;
    }
    const H = this.hidden;
    const o = new Float32Array(n * 2 * H);
    this.run(x, n, width, "", o, 0);
    this.run(x, n, width, "_reverse", o, H);
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let z = this.m.head_b + this.m.lr_b;
      for (let j = 0; j < 2 * H; j++) z += this.headW[j]! * o[k * 2 * H + j]!;
      for (let j = 0; j < 27; j++) z += (this.headW[2 * H + j]! + this.m.lr_dense[j]!) * dense[k]![j]!;
      for (const id of ids[k]!) z += this.lrW[id]!;
      out[k] = sigmoid(z);
    }
    return out;
  }
}

/** A packed byte's four ternary weights (2 bits each, low bits first: 0 → 0, 1 → +1, 2 → −1). */
const DECODE = (() => {
  const d = new Int8Array(1024);
  for (let v = 0; v < 256; v++)
    for (let j = 0; j < 4; j++) {
      const c = (v >> (2 * j)) & 3;
      d[v * 4 + j] = c === 1 ? 1 : c === 2 ? -1 : 0;
    }
  return d;
})();

const GRU_KEYS = [
  "weight_ih_l0",
  "weight_hh_l0",
  "bias_ih_l0",
  "bias_hh_l0",
  "weight_ih_l0_reverse",
  "weight_hh_l0_reverse",
  "bias_ih_l0_reverse",
  "bias_hh_l0_reverse",
] as const;

interface ThreadModel {
  arch: "thread";
  buckets: number;
  bits: number;
  hidden: number;
  ternary: string;
  a: number;
  bn_scale: string;
  bn_shift: string;
  head_w: string;
  head_b: number;
  lr_w: string;
  lr_dense: number[];
  lr_b: number;
  threshold: number;
  [gru: string]: unknown;
}

export class PartTrimmer {
  private readonly w: Int8Array | null = null;
  private readonly net: ThreadNet | null = null;
  private constructor(private readonly m: TrimModel | ThreadModel) {
    if (m.arch === "thread") this.net = new ThreadNet(m as ThreadModel);
    else {
      const bytes = Buffer.from((m as TrimModel).weights, "base64");
      this.w = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
  }

  /** Reads the weights once; null (the trimmer off, `pick` as before) when the file is missing or unreadable. */
  static load(path = TRIM_MODEL_PATH): PartTrimmer | null {
    try {
      const m = JSON.parse(readFileSync(path, "utf8")) as TrimModel | ThreadModel;
      if (m.arch === "thread") return new PartTrimmer(m);
      if (m.arch !== "lr" || (m as TrimModel).dense.length !== 27) return null;
      return new PartTrimmer(m);
    } catch {
      return null;
    }
  }

  get threshold(): number {
    return this.m.threshold;
  }

  /** Each part's keep probability for the request. */
  score(request: string, title: string, parts: readonly Part[]): Float64Array {
    const focus = (this.m as TrimModel).request === false ? new Set<string>() : focusOf(request);
    const words = parts.map((p) => toks(p.text));
    const dense = denseOf(parts, words, focus, title);
    const ids = parts.map((p, k) => sparseOf(p.text, words[k]!, focus, this.m.buckets));
    if (this.net) return this.net.score(parts, ids, dense);
    const m = this.m as TrimModel;
    const out = new Float64Array(parts.length);
    for (let k = 0; k < parts.length; k++) {
      let z = m.bias;
      for (const i of ids[k]!) z += this.w![i]! * m.scale;
      const d = dense[k]!;
      for (let j = 0; j < d.length; j++) z += d[j]! * m.dense[j]!;
      out[k] = sigmoid(z);
    }
    return out;
  }
}
