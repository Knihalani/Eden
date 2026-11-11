/**
 * M13's turn gate (D1010-D1019, docs/research/m13-gate.md): a tiny learned model that reads one user turn and says
 * whether it starts the push (an acting request or a question about acting) and what kind of turn it is. Features
 * are hashed character and word n-grams (no tokenizer, no pretrained table), so it reads any language. The Python
 * twin is packages/sim/lab/m13/feats.py: the two must give the same ids for the same text (`turn-gate.test.ts`).
 */

import { readFileSync } from "node:fs";

const FNV0 = 2166136261;
const FNVP = 16777619;
/** Code points read after normalising: a turn is decided on its head (a bound on work, not a heuristic). */
const MAXCP = 300;
const WS = /[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
const WORDS = /[\p{L}\p{M}\p{N}'’]+/gu;

/** NFKC, lower case, ASCII digits to 0, white space runs to one space, the first `MAXCP` code points. */
export function gateNorm(s: string): string {
  const head = Array.from(s.slice(0, 8 * MAXCP))
    .slice(0, 4 * MAXCP)
    .join("");
  const t = head
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[0-9]/g, "0")
    .replace(WS, " ")
    .replace(/^ +| +$/g, "");
  return Array.from(t).slice(0, MAXCP).join("");
}

function hashOf(salt: number, cps: ArrayLike<number>, from = 0, to = cps.length): number {
  let x = Math.imul(FNV0 ^ salt, FNVP) >>> 0;
  for (let i = from; i < to; i++) x = Math.imul(x ^ cps[i]!, FNVP) >>> 0;
  return x;
}

/** Every lo..hi-gram of `cps[from, to)`, one FNV pass per start position (feats.py's `grams`). */
function grams(cps: Int32Array, from: number, to: number, lo: number, hi: number, salt: number, out: Ids): void {
  const seed = Math.imul(FNV0 ^ salt, FNVP) >>> 0;
  for (let i = from; i < to; i++) {
    let x = seed;
    const top = Math.min(hi, to - i);
    for (let k = 1; k <= top; k++) {
      x = Math.imul(x ^ cps[i + k - 1]!, FNVP) >>> 0;
      if (k >= lo) out.add(Math.imul(x ^ (k + 0x5bd1), FNVP) >>> 0);
    }
  }
}

/** A growable list of feature ids, masked as added, sorted and made unique once at the end. */
class Ids {
  buf = new Int32Array(4096);
  n = 0;
  constructor(readonly mask: number) {}
  add(x: number): void {
    if (this.n === this.buf.length) {
      const b = new Int32Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    this.buf[this.n++] = x & this.mask;
  }
  done(): number[] {
    const s = this.buf.subarray(0, this.n).sort();
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) if (i === 0 || s[i] !== s[i - 1]) out.push(s[i]!);
    return out;
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

/** The turn's feature ids (sorted, unique), as feats.py's `featurise` with groups "chewp" (and its skeleton). */
export function gateFeatures(text: string, bits: number, skeleton?: ReadonlySet<string>): number[] {
  const out = new Ids((1 << bits) - 1);
  const t = gateNorm(text);
  // BOS (2), the code points, EOS (3): one array, read in windows for the whole, the head and the tail.
  const cps = new Int32Array(t.length + 2);
  let n = 0;
  cps[n++] = 2;
  for (const ch of t) cps[n++] = ch.codePointAt(0)!;
  cps[n++] = 3;
  grams(cps, 0, n, 1, 4, 100, out);
  grams(cps, 0, Math.min(20, n - 1), 2, 4, 200, out);
  grams(cps, Math.max(1, n - 10), n, 1, 3, 300, out);
  const ws = gateWords(t);
  const wc = ws.map(codePoints);
  for (const w of wc) out.add(hashOf(400, w));
  for (let i = 0; i + 1 < wc.length; i++) out.add(hashOf(401, [...wc[i]!, 32, ...wc[i + 1]!]));
  for (let i = 0; i < Math.min(3, wc.length); i++) out.add(hashOf(500 + i, wc[i]!));
  if (wc.length) out.add(hashOf(510, wc[wc.length - 1]!));
  out.add(hashOf(520, [Math.min(wc.length, 20)]));
  if (skeleton) {
    const seq: number[][] = [[2]];
    for (const w of ws.slice(0, 40)) seq.push(codePoints(skeleton.has(w) ? w : w.includes("0") ? "0" : "x"));
    seq.push([3]);
    for (let k = 1; k <= 3; k++)
      for (let i = 0; i + k <= seq.length; i++) {
        const g: number[] = [];
        for (const w of seq.slice(i, i + k)) g.push(...w, 32);
        out.add(hashOf(700 + k + (i === 0 ? 10 : 0), g));
      }
  }
  return out.done();
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
  logit: number;
  kinds: TurnVerdict["kind"][];
  skel: string[];
  arrays: { name: string; dtype: "int8" | "float32"; shape: number[]; offset: number }[];
}

const RULE_IDS = { listed: 1, opened: 2, none: 3 } as const;
const CLAUSE = /(?<=[,;:.!?¿¡—–])\s+|\s+(?=(?:but|so|and then|anyway|also)\s)/i;

/** A turn's clauses for the clause gate (H4): at most six, none when the turn is one clause. */
export function gateClauses(text: string): string[] {
  const parts = text.split(CLAUSE).filter((p) => p && p.trim());
  return parts.length > 1 ? parts.slice(0, 6) : [];
}

export class TurnGate {
  private readonly h: Header;
  private readonly emb: Int8Array | Float32Array;
  private readonly scale: Float32Array | null;
  private readonly arr: Map<string, Float32Array> = new Map();
  private readonly skel: ReadonlySet<string> | undefined;
  private readonly x: Float64Array;
  private readonly y: Float64Array;

  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "EDG1") throw new Error("turn gate: bad magic");
    const len = view.getUint32(4, true);
    this.h = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
    const base = bytes.byteOffset + 8 + len;
    let emb: Int8Array | Float32Array | null = null;
    for (const a of this.h.arrays) {
      const n = a.shape.reduce((x, y) => x * y, 1);
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
    this.emb = emb;
    this.scale = this.arr.get("scale") ?? null;
    this.skel = this.h.skel.length ? new Set(this.h.skel) : undefined;
    this.x = new Float64Array(this.h.dim);
    this.y = new Float64Array(this.h.hidden || this.h.dim);
  }

  get bytes(): number {
    return this.emb.byteLength + [...this.arr.values()].reduce((s, a) => s + a.byteLength, 0);
  }

  /** The pooled code of one text: its features' mean embedding, through the hidden layer if any (into `this.y`). */
  private encode(text: string, rule?: RuleReading): Float64Array {
    const { dim, bits, hidden } = this.h;
    const ids = gateFeatures(text, bits, this.skel);
    if (this.h.rule && rule) {
      const mask = (1 << bits) - 1;
      const extra = [hashOf(600, [RULE_IDS[rule.how]]) & mask, hashOf(601, [rule.rest ? 2 : 1]) & mask];
      for (const e of extra) if (!ids.includes(e)) ids.push(e);
    }
    const x = this.x;
    x.fill(0);
    const ids2 = ids.length ? ids : [0];
    for (const f of ids2) {
      const row = f * dim;
      for (let d = 0; d < dim; d++) x[d]! += this.emb[row + d]!;
    }
    const n = ids2.length;
    for (let d = 0; d < dim; d++) x[d] = (x[d]! * (this.scale ? this.scale[d]! : 1)) / n;
    if (!hidden) {
      this.y.set(x);
      return this.y;
    }
    const W = this.arr.get("hidW")!;
    const B = this.arr.get("hidB")!;
    for (let j = 0; j < hidden; j++) {
      let s = B[j]!;
      for (let d = 0; d < dim; d++) s += W[j * dim + d]! * x[d]!;
      this.y[j] = s > 0 ? s : 0;
    }
    return this.y;
  }

  private dot(name: string, row: number, v: Float64Array): number {
    const W = this.arr.get(name)!;
    const n = v.length;
    let s = 0;
    for (let i = 0; i < n; i++) s += W[row * n + i]! * v[i]!;
    return s;
  }

  /** The gate's reading of one user turn. Pure CPU, bounded by `MAXCP` code points a text (and six clauses). */
  read(text: string, rule?: RuleReading): TurnVerdict {
    const v = this.encode(text, rule);
    let logit = this.dot("needsW", 0, v) + this.arr.get("needsB")![0]!;
    let best = 0;
    let top = -Infinity;
    const kb = this.arr.get("kindB")!;
    for (let k = 0; k < kb.length; k++) {
      const s = this.dot("kindW", k, v) + kb[k]!;
      if (s > top) [top, best] = [s, k];
    }
    if (this.h.arch === "mil")
      for (const c of gateClauses(text)) {
        const vc = this.encode(c);
        logit = Math.max(logit, this.dot("needsW", 0, vc) + this.arr.get("needsB")![0]!);
      }
    return { needs: logit >= this.h.logit, kind: this.h.kinds[best]!, logit };
  }
}

let loaded: TurnGate | null | undefined;

/**
 * The shipped gate (`turn-gate.bin` beside this file), read once a process; null when it cannot be read or parsed,
 * and the caller then keeps the rules (fail open, D1010).
 */
export function turnGate(): TurnGate | null {
  if (loaded !== undefined) return loaded;
  try {
    loaded = new TurnGate(new Uint8Array(readFileSync(new URL("./turn-gate.bin", import.meta.url))));
  } catch {
    loaded = null;
  }
  return loaded;
}
