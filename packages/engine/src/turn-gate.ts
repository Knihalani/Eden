/**
 * M13's turn gate (D1010-D1019, docs/research/m13-gate.md): a tiny learned model that reads one user turn and says
 * whether it starts the push (an acting request or a question about acting) and what kind of turn it is. Features
 * are hashed character and word n-grams (no tokenizer, no pretrained table), so it reads any language. The Python
 * twin is packages/sim/lab/m13/feats.py: the two must give the same ids for the same text (`turn-gate.test.ts`).
 *
 * D1890: features are hashed straight from code points in module scratch arrays (no strings or arrays a word, no
 * sort: a bitset makes ids unique), a turn in ASCII and common typographic punctuation is normalised in one pass, and
 * the forward sums int8 rows in Int32. Every output is the same bits as before: `turn-gate-oracle.test.ts` holds the
 * earlier code and compares ids, logits and kinds on fuzzed turns.
 */

import { readFileSync } from "node:fs";
import gateFile from "./turn-gate.bin" with { type: "file" };

const FNV0 = 2166136261;
const FNVP = 16777619;
/** Code points read after normalising: a turn is decided on its head (a bound on work, not a heuristic). */
const MAXCP = 300;
const WS = /[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
const WORDS = /[\p{L}\p{M}\p{N}'’]+/gu;
const WORD_EXEC = /[\p{L}\p{M}\p{N}'’]+/gu;

/** The first `max` code points of `s` (`Array.from(s).slice(0, max).join("")`, a lone surrogate counting one). */
function headCps(s: string, max: number): string {
  let i = 0;
  for (let k = 0; i < s.length && k < max; k++) {
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
  }
  return i >= s.length ? s : s.slice(0, i);
}

/** The general normalisation: NFKC, lower case, ASCII digits to 0, white space runs to one space, trimmed. */
function normSlow(s: string): string {
  const t = headCps(s.slice(0, 8 * MAXCP), 4 * MAXCP)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[0-9]/g, "0")
    .replace(WS, " ")
    .replace(/^ +| +$/g, "");
  return headCps(t, MAXCP);
}

/**
 * Characters past ASCII that NFKC and lower-casing leave alone and that never join with a neighbour: ‘ ’ “ ” – —.
 * A head of ASCII and these is normalised in one pass (`normFast`); anything else takes `normSlow`.
 */
function plain(c: number): boolean {
  return c < 128 || c === 0x2018 || c === 0x2019 || c === 0x201c || c === 0x201d || c === 0x2013 || c === 0x2014;
}

// Scratch reused by every call (each call runs to its end with no await, so one set a process is enough).
/** BOS (2), the normalised turn's code points, EOS (3). */
const CPS = new Int32Array(MAXCP + 2);
/** Words as [start, end) into CPS. */
const WS0 = new Int32Array(MAXCP);
const WS1 = new Int32Array(MAXCP);
/** UTF-16 index of the normalised string to its code point's index (the slow path's word spans). */
const U2C = new Int32Array(2 * MAXCP + 1);
/** The raw ids of one turn, masked, with repeats. */
let RAW = new Int32Array(2048);
let rawN = 0;
let rawMask = 0;
/** Ids seen, one bit each, for masks up to 2^20 (all zero between calls). */
let SEEN = new Uint32Array(0);
/** One turn's unique ids, unsorted. */
let UNIQ = new Int32Array(2048);

/** Fills CPS[1..] from a head of `plain` characters in one pass; -1 when the head has any other character. */
function normFast(s: string): number {
  const lim = Math.min(s.length, 4 * MAXCP);
  for (let i = 0; i < lim; i++) if (!plain(s.charCodeAt(i))) return -1;
  let n = 1;
  let pend = false;
  for (let i = 0; i < lim; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) {
      pend = n > 1;
      continue;
    }
    if (pend) {
      CPS[n++] = 32;
      pend = false;
      if (n > MAXCP) break;
    }
    CPS[n++] = c >= 65 && c <= 90 ? c + 32 : c >= 48 && c <= 57 ? 48 : c;
    if (n > MAXCP) break;
  }
  return n - 1;
}

/** NFKC, lower case, ASCII digits to 0, white space runs to one space, the first `MAXCP` code points. */
export function gateNorm(s: string): string {
  const n = normFast(s);
  if (n < 0) return normSlow(s);
  let t = "";
  for (let i = 1; i <= n; i += 256) t += String.fromCharCode(...CPS.subarray(i, Math.min(i + 256, n + 1)));
  return t;
}

/** A word character of the fast path's alphabet (lower-cased ASCII letters, digits, ' and ’). */
function wordCp(c: number): boolean {
  return (c >= 97 && c <= 122) || c === 48 || c === 39 || c === 0x2019;
}

/**
 * Normalises `text` into CPS (BOS and EOS included) and its words into WS0/WS1. Returns the code point count with
 * BOS and EOS in the low 16 bits and the word count above.
 */
function load(text: string): number {
  let m = normFast(text);
  let w = 0;
  if (m >= 0) {
    for (let i = 1; i <= m;) {
      if (!wordCp(CPS[i]!)) {
        i++;
        continue;
      }
      const a = i;
      while (i <= m && wordCp(CPS[i]!)) i++;
      WS0[w] = a;
      WS1[w++] = i;
    }
  } else {
    const t = normSlow(text);
    m = 0;
    for (let i = 0; i < t.length;) {
      const c = t.codePointAt(i)!;
      U2C[i] = m;
      CPS[1 + m++] = c;
      i += c > 0xffff ? 2 : 1;
    }
    U2C[t.length] = m;
    WORD_EXEC.lastIndex = 0;
    for (let r = WORD_EXEC.exec(t); r; r = WORD_EXEC.exec(t)) {
      WS0[w] = 1 + U2C[r.index]!;
      WS1[w++] = 1 + U2C[r.index + r[0].length]!;
    }
  }
  CPS[0] = 2;
  CPS[m + 1] = 3;
  return (m + 2) | (w << 16);
}

function add(x: number): void {
  if (rawN === RAW.length) {
    const b = new Int32Array(RAW.length * 2);
    b.set(RAW);
    RAW = b;
  }
  RAW[rawN++] = x & rawMask;
}

function seedOf(salt: number): number {
  return Math.imul(FNV0 ^ salt, FNVP) >>> 0;
}

/** FNV-1a over CPS[from, to) from state `x`. */
function fold(x: number, from: number, to: number): number {
  for (let i = from; i < to; i++) x = Math.imul(x ^ CPS[i]!, FNVP) >>> 0;
  return x;
}

function hashOf(salt: number, cps: ArrayLike<number>): number {
  let x = seedOf(salt);
  for (let i = 0; i < cps.length; i++) x = Math.imul(x ^ cps[i]!, FNVP) >>> 0;
  return x;
}

/** Every lo..hi-gram of `CPS[from, to)`, one FNV pass per start position (feats.py's `grams`). */
function grams(from: number, to: number, lo: number, hi: number, salt: number): void {
  const seed = seedOf(salt);
  for (let i = from; i < to; i++) {
    let x = seed;
    const top = Math.min(hi, to - i);
    for (let k = 1; k <= top; k++) {
      x = Math.imul(x ^ CPS[i + k - 1]!, FNVP) >>> 0;
      if (k >= lo) add(Math.imul(x ^ (k + 0x5bd1), FNVP) >>> 0);
    }
  }
}

function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!);
  return out;
}

/** Runs of letters, marks, numbers and apostrophes (feats.py's `words`). */
export function gateWords(t: string): string[] {
  return t.match(WORDS) ?? [];
}

/** The turn's raw ids into RAW (masked, with repeats), as feats.py's `featurise` with groups "chewp"; its words. */
function collect(text: string, bits: number, skeleton?: ReadonlySet<string>): number {
  rawN = 0;
  rawMask = (1 << bits) - 1;
  const packed = load(text);
  const n = packed & 0xffff;
  const wc = packed >>> 16;
  grams(0, n, 1, 4, 100);
  grams(0, Math.min(20, n - 1), 2, 4, 200);
  grams(Math.max(1, n - 10), n, 1, 3, 300);
  const s400 = seedOf(400);
  const s401 = seedOf(401);
  for (let i = 0; i < wc; i++) add(fold(s400, WS0[i]!, WS1[i]!));
  for (let i = 0; i + 1 < wc; i++) {
    const x = Math.imul(fold(s401, WS0[i]!, WS1[i]!) ^ 32, FNVP) >>> 0;
    add(fold(x, WS0[i + 1]!, WS1[i + 1]!));
  }
  for (let i = 0; i < Math.min(3, wc); i++) add(fold(seedOf(500 + i), WS0[i]!, WS1[i]!));
  if (wc) add(fold(seedOf(510), WS0[wc - 1]!, WS1[wc - 1]!));
  add(Math.imul(seedOf(520) ^ Math.min(wc, 20), FNVP) >>> 0);
  if (skeleton) {
    // H8's skeleton (no shipped weights use it): word strings, read as before.
    const ws: string[] = [];
    for (let i = 0; i < Math.min(wc, 40); i++) ws.push(String.fromCodePoint(...CPS.subarray(WS0[i]!, WS1[i]!)));
    const seq: number[][] = [[2]];
    for (const w of ws) seq.push(codePoints(skeleton.has(w) ? w : w.includes("0") ? "0" : "x"));
    seq.push([3]);
    for (let k = 1; k <= 3; k++)
      for (let i = 0; i + k <= seq.length; i++) {
        const g: number[] = [];
        for (const w of seq.slice(i, i + k)) g.push(...w, 32);
        add(hashOf(700 + k + (i === 0 ? 10 : 0), g));
      }
  }
  return wc;
}

/** RAW's ids made unique into UNIQ (unsorted); returns the count. Masks over 2^20 sort instead of a bitset. */
function unique(bits: number): number {
  // Room for every raw id and the rule's two.
  if (UNIQ.length < rawN + 2) UNIQ = new Int32Array(RAW.length + 2);
  if (bits > 20) {
    const s = RAW.subarray(0, rawN).sort();
    let u = 0;
    for (let i = 0; i < s.length; i++) if (i === 0 || s[i] !== s[i - 1]) UNIQ[u++] = s[i]!;
    return u;
  }
  const words = 1 << Math.max(0, bits - 5);
  if (SEEN.length < words) SEEN = new Uint32Array(words);
  let u = 0;
  for (let i = 0; i < rawN; i++) {
    const f = RAW[i]!;
    const b = 1 << (f & 31);
    const w = f >>> 5;
    if (SEEN[w]! & b) continue;
    SEEN[w]! |= b;
    UNIQ[u++] = f;
  }
  for (let i = 0; i < u; i++) SEEN[UNIQ[i]! >>> 5] = 0;
  return u;
}

/** The turn's feature ids (sorted, unique), as feats.py's `featurise` with groups "chewp" (and its skeleton). */
export function gateFeatures(text: string, bits: number, skeleton?: ReadonlySet<string>): number[] {
  collect(text, bits, skeleton);
  const u = unique(bits);
  const out: number[] = [];
  if (bits > 16) {
    const s = UNIQ.subarray(0, u).sort();
    for (let i = 0; i < u; i++) out.push(s[i]!);
    return out;
  }
  // Sorted by a scan of the bitset (2,048 words at 16 bits), cheaper than sorting the ~400 ids of a turn.
  for (let i = 0; i < u; i++) SEEN[UNIQ[i]! >>> 5]! |= 1 << (UNIQ[i]! & 31);
  const words = 1 << Math.max(0, bits - 5);
  for (let w = 0; w < words; w++) {
    let b = SEEN[w]!;
    if (b === 0) continue;
    SEEN[w] = 0;
    while (b !== 0) {
      const low = b & -b;
      out.push((w << 5) | (31 - Math.clz32(low)));
      b ^= low;
    }
  }
  return out;
}

/** What the gate says about one turn. `needs`: start the push (an acting request or a question about acting). */
export interface TurnVerdict {
  needs: boolean;
  kind: "act" | "qact" | "ask" | "chatter" | "statement";
  logit: number;
}

/** The shipped rule's reading of the turn (`pushStart`), an input of a rule-residual gate (H7). */
export interface RuleReading {
  how: "listed" | "opened" | "none";
  rest: boolean;
}

interface Header {
  v: number;
  arch: "bag" | "mil";
  bits: number;
  dim: number;
  hidden: number;
  quant: "int8" | "none";
  rule: boolean;
  rule2: boolean;
  logit: number;
  /** The union (D1011): a turn the rule starts passes unless the gate's logit is under this (null: no union). */
  veto: number | null;
  kinds: TurnVerdict["kind"][];
  skel: string[];
  arrays: { name: string; dtype: "int8" | "float32"; shape: number[]; offset: number }[];
}

const RULE_IDS = { listed: 1, opened: 2, none: 3 } as const;
/** The stopgap's floor (D1015): the fewest words a turn needs for the gate alone to start the push. */
export const MIN_ADD_WORDS = 3;
const CLAUSE = /(?<=[,;:.!?¿¡—–])\s+|\s+(?=(?:but|so|and then|anyway|also)\s)/i;

/** A turn's clauses for the clause gate (H4): at most six, none when the turn is one clause. */
export function gateClauses(text: string): string[] {
  const parts = text
    .slice(0, 8 * MAXCP)
    .split(CLAUSE)
    .filter((p) => p && p.trim());
  return parts.length > 1 ? parts.slice(0, 6) : [];
}

export class TurnGate {
  private readonly h: Header;
  private readonly emb: Int8Array | Float32Array;
  private readonly emb4: Uint32Array | null;
  private readonly lanes: Int32Array;
  private readonly tableBytes: number;
  private readonly scale: Float32Array | null;
  private readonly arr: Map<string, Float32Array> = new Map();
  private readonly skel: ReadonlySet<string> | undefined;
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  /** The pooled sums of an int8 table, exact in Int32 (|sum| ≤ 127 × 2^20 ids). */
  private readonly acc: Int32Array;
  /** The forward's float arrays as doubles, read with no lookup a turn (the same values: float32 → double is exact). */
  private readonly hidW: Float64Array | null;
  private readonly hidB: Float64Array | null;
  private readonly needsW: Float64Array;
  private readonly needsB: number;
  private readonly kindW: Float64Array;
  private readonly kindB: Float64Array;
  /** The word count of the last whole turn `encode` read (the stopgap's, D1015). */
  private words = 0;

  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "EDG1") throw new Error("turn gate: bad magic");
    const len = view.getUint32(4, true);
    this.h = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
    const base = bytes.byteOffset + 8 + len;
    let emb: Int8Array | Float32Array | null = null;
    for (const a of this.h.arrays) {
      const n = a.shape.reduce((x, y) => x * y, 1);
      // An array past the file's end (a cut or partial file) is refused, never read as zeros.
      if (8 + len + a.offset + n * (a.dtype === "int8" ? 1 : 4) > bytes.byteLength)
        throw new Error("turn gate: an array past the end of the file");
      if (a.dtype === "int8") emb = new Int8Array(bytes.buffer, base + a.offset, n);
      else {
        // Float arrays are copied: the file's offsets are 4-aligned within it, not necessarily in the buffer.
        const f = new Float32Array(n);
        f.set(new Float32Array(bytes.slice(8 + len + a.offset, 8 + len + a.offset + 4 * n).buffer));
        if (a.name === "emb") emb = f;
        else this.arr.set(a.name, f);
      }
    }
    if (!emb) throw new Error("turn gate: no table");
    // Every array the forward reads, at the size it reads: a file that would throw or read garbage at `read` is
    // refused here, so `loadTurnGate` gives null and the rule decides (fail open).
    const { bits, dim, hidden, kinds, logit, veto } = this.h;
    const width = dim + (this.h.rule2 ? 4 : 0);
    const out = hidden || width;
    const size = (name: string) => this.arr.get(name)?.length ?? -1;
    const ok =
      (this.h.arch === "bag" || this.h.arch === "mil") &&
      Number.isInteger(bits) &&
      bits > 0 &&
      bits <= 24 &&
      emb.length === (1 << bits) * dim &&
      (this.h.quant !== "int8" || size("scale") === dim) &&
      (!hidden || (size("hidW") === hidden * width && size("hidB") === hidden)) &&
      size("needsW") === out &&
      size("needsB") === 1 &&
      Array.isArray(kinds) &&
      kinds.length > 0 &&
      size("kindW") === kinds.length * out &&
      size("kindB") === kinds.length &&
      Number.isFinite(logit) &&
      (veto === null || Number.isFinite(veto));
    if (!ok) throw new Error("turn gate: a malformed weights file");
    this.tableBytes = emb.byteLength;
    // The int8 table read four dims a word: a view of the file's bytes where they sit 4-aligned (the shipped file
    // does: no copy, no load cost), else one aligned copy. Only where dims come four to a word in byte order (little
    // endian, a dim count a multiple of four); else the int8 rows are read one by one.
    const le = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    if (emb instanceof Int8Array && dim % 4 === 0 && le) {
      if (emb.byteOffset % 4 === 0) this.emb4 = new Uint32Array(emb.buffer, emb.byteOffset, emb.length >> 2);
      else {
        const words = new Uint32Array(emb.length >> 2);
        new Int8Array(words.buffer).set(emb);
        this.emb4 = words;
      }
      this.emb = new Int8Array(0);
    } else {
      this.emb4 = null;
      this.emb = emb;
    }
    this.lanes = new Int32Array(2 * (dim >> 2));
    this.scale = this.arr.get("scale") ?? null;
    this.skel = this.h.skel.length ? new Set(this.h.skel) : undefined;
    // H7': the rule's reading (listed, opened, none, lead-in read) sits beside the pooled code.
    this.x = new Float64Array(this.h.dim + (this.h.rule2 ? 4 : 0));
    this.y = new Float64Array(this.h.hidden || this.x.length);
    this.acc = new Int32Array(dim);
    const f64 = (name: string) => Float64Array.from(this.arr.get(name)!);
    this.hidW = hidden ? f64("hidW") : null;
    this.hidB = hidden ? f64("hidB") : null;
    this.needsW = f64("needsW");
    this.needsB = this.arr.get("needsB")![0]!;
    this.kindW = f64("kindW");
    this.kindB = f64("kindB");
  }

  get bytes(): number {
    return this.tableBytes + [...this.arr.values()].reduce((s, a) => s + a.byteLength, 0);
  }

  /** The pooled code of one text: its features' mean embedding, through the hidden layer if any (into `this.y`). */
  private encode(text: string, rule?: RuleReading): Float64Array {
    const { dim, bits, hidden } = this.h;
    const words = collect(text, bits, this.skel);
    let n = unique(bits);
    const emb = this.emb;
    // A float table keeps the earlier sum's order (sorted ids, then the rule's): float addition is not associative.
    if (!(emb instanceof Int8Array)) UNIQ.subarray(0, n).sort();
    if (this.h.rule && rule) {
      // The rule's ids join the turn's unless already there.
      const mask = (1 << bits) - 1;
      for (const e of [hashOf(600, [RULE_IDS[rule.how]]) & mask, hashOf(601, [rule.rest ? 2 : 1]) & mask]) {
        let has = false;
        for (let i = 0; i < n && !has; i++) has = UNIQ[i] === e;
        if (!has) UNIQ[n++] = e;
      }
    }
    if (n === 0) UNIQ[n++] = 0;
    const x = this.x;
    x.fill(0);
    const emb4 = this.emb4;
    if (emb4) {
      // Four dims a word, two 16-bit lanes an add (SWAR) over the bytes made unsigned (v + 128): a lane holds at most
      // 256 of them (65,280), so it is flushed every 256 rows; the sum less 128 a row is the int8 sum exactly.
      const q = dim >> 2;
      const acc = this.acc;
      const lanes = this.lanes;
      acc.fill(0);
      for (let s = 0; s < n; s += 256) {
        lanes.fill(0);
        const e = Math.min(n, s + 256);
        for (let i = s; i < e; i++) {
          const r = UNIQ[i]! * q;
          for (let k = 0; k < q; k++) {
            // XOR 0x80 a byte makes each int8 v the unsigned v + 128.
            const w = emb4[r + k]! ^ 0x80808080;
            lanes[k]! += w & 0xff00ff;
            lanes[q + k]! += (w >>> 8) & 0xff00ff;
          }
        }
        for (let k = 0, d = 0; k < q; k++, d += 4) {
          acc[d]! += lanes[k]! & 0xffff;
          acc[d + 1]! += lanes[q + k]! & 0xffff;
          acc[d + 2]! += lanes[k]! >>> 16;
          acc[d + 3]! += lanes[q + k]! >>> 16;
        }
      }
      for (let d = 0; d < dim; d++) x[d] = acc[d]! - 128 * n;
    } else if (emb instanceof Int8Array) {
      // Int8 rows summed in Int32: exact, as the doubles were (sums of small integers), and the same order-free sum.
      const acc = this.acc;
      acc.fill(0);
      for (let i = 0; i < n; i++) {
        const row = UNIQ[i]! * dim;
        for (let d = 0; d < dim; d++) acc[d]! += emb[row + d]!;
      }
      for (let d = 0; d < dim; d++) x[d] = acc[d]!;
    } else {
      for (let i = 0; i < n; i++) {
        const row = UNIQ[i]! * dim;
        for (let d = 0; d < dim; d++) x[d]! += emb[row + d]!;
      }
    }
    const scale = this.scale;
    for (let d = 0; d < dim; d++) x[d] = (x[d]! * (scale ? scale[d]! : 1)) / n;
    if (this.h.rule2) {
      // A clause is read with no rule reading (zeros), as gate.py's `Mil` reads it.
      x[dim] = rule?.how === "listed" ? 1 : 0;
      x[dim + 1] = rule?.how === "opened" ? 1 : 0;
      x[dim + 2] = rule?.how === "none" ? 1 : 0;
      x[dim + 3] = rule?.rest ? 1 : 0;
    }
    this.words = words;
    if (!hidden) {
      this.y.set(x);
      return this.y;
    }
    const W = this.hidW!;
    const B = this.hidB!;
    const y = this.y;
    const width = x.length;
    for (let j = 0, r = 0; j < hidden; j++, r += width) {
      let s = B[j]!;
      for (let d = 0; d < width; d++) s += W[r + d]! * x[d]!;
      y[j] = s > 0 ? s : 0;
    }
    return y;
  }

  private dot(W: Float64Array, row: number, v: Float64Array): number {
    const n = v.length;
    const r = row * n;
    let s = 0;
    for (let i = 0; i < n; i++) s += W[r + i]! * v[i]!;
    return s;
  }

  /** The gate's reading of one user turn. Pure CPU, bounded by `MAXCP` code points a text (and six clauses). */
  read(text: string, rule?: RuleReading): TurnVerdict {
    const v = this.encode(text, rule);
    const words = this.words;
    let logit = this.dot(this.needsW, 0, v) + this.needsB;
    let best = 0;
    let top = -Infinity;
    const kb = this.kindB;
    for (let k = 0; k < kb.length; k++) {
      const s = this.dot(this.kindW, k, v) + kb[k]!;
      if (s > top) [top, best] = [s, k];
    }
    if (this.h.arch === "mil")
      for (const c of gateClauses(text)) {
        const vc = this.encode(c);
        logit = Math.max(logit, this.dot(this.needsW, 0, vc) + this.needsB);
      }
    const started = rule !== undefined && rule.how !== "none";
    const ruled = started && this.h.veto !== null && logit >= this.h.veto;
    // Stopgap (D1015): a start the gate alone would make on a turn of fewer than `MIN_ADD_WORDS` words is refused.
    // The round-3 weights read short throwaway turns ("hello", "hi", "?", "asdf") as terse commands; a retrain that
    // fixed them raised false starts elsewhere (m13-gate.md §7.2). Rule starts ("cancel it", "book it") are untouched.
    const adds = logit >= this.h.logit && (started || words >= MIN_ADD_WORDS);
    return { needs: adds || ruled, kind: this.h.kinds[best]!, logit };
  }
}

/** A gate read from a file, or null when it cannot be read or parsed (the caller keeps the rules: fail open). */
export function loadTurnGate(file: URL | string): TurnGate | null {
  try {
    return new TurnGate(new Uint8Array(readFileSync(file)));
  } catch {
    return null;
  }
}

let loaded: TurnGate | null | undefined;

/** The shipped gate (`turn-gate.bin` beside this file), read once a process (D1010). */
export function turnGate(): TurnGate | null {
  if (loaded === undefined) loaded = loadTurnGate(gateFile);
  return loaded;
}
