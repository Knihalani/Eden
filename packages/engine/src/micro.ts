/**
 * The intent micro-expansion's forward (M11, D970; `intentMicro`, a trial; docs/research/m11-intent.md). A small
 * learned model, CopyGen: the item's hashed word, character 3/4-gram and word-bigram ids (CRC-32) give a context
 * vector; a copy head scores each of the item's own stems (`intentTerms`) for whether a request would use it; a
 * generation head scores a closed request vocabulary for terms the item lacks. The expansion is the copied terms and
 * the generated ones above their thresholds, each repeated 1-3 times by its probability. No text is generated, no
 * call is made, nothing is learned per user: the weights are shared and read-only, loaded once per process.
 *
 * The weights are `packages/sim/lab/m11/export.py`'s file: "EIM1", a JSON header, then int8 tables with float32 row
 * scales. `micro.test.ts` checks this forward against the exporter's numpy reference on 64 held-out items.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IntentExpander } from "./intent";
import { intentTerms } from "./intent";

interface Entry {
  dtype: string;
  shape: number[];
  offset: number;
  scale_offset?: number;
  scale_len?: number;
}

interface Header {
  args: {
    ctx: "mean" | "bin";
    gen: "mlp" | "codes" | "none";
    buckets: number;
    tbuckets: number;
    cap: number;
    delex: boolean;
    kc: number;
    kg: number;
    theta_c: number;
    theta_g: number;
    lift: number;
  };
  vocab: string[];
  prior: number[];
  arrays: Record<string, Entry>;
}

/** A matrix of int8 rows with a float scale per row (or one scale for all, `scale.length` 1). */
interface Mat {
  q: Int8Array | Float32Array;
  rows: number;
  cols: number;
  scale: Float32Array | null;
}

const WORD = /[a-z0-9£$€]+/g;
const MAX_WORDS = 200;
/** Own terms the copy head reads at most (by first position), as the trainer's `term_scalars`. */
const MAX_OWN = 150;
const DELEX: [RegExp, string][] = [
  [/\S+@\S+/g, " xemail "],
  [/\b\d{1,2}:\d{2}\b/g, " xtime "],
  [/[£$€]\s?\d[\d,.]*k?/g, " xmoney "],
  [/\b\d+(?:st|nd|rd|th)?\b/g, " xnum "],
];
const CAP_NAME = /\b[A-Z][a-z]+\b/g;

const crc = (s: string): number => Bun.hash.crc32(s) >>> 0;

/** The trainer's `grams`: words, character 3/4-grams inside words, word bigrams; hashed, sorted, at most `cap`. */
export function microGrams(text: string, buckets: number, cap: number): number[] {
  const words = (text.toLowerCase().match(WORD) ?? []).slice(0, MAX_WORDS);
  const out = new Set<number>();
  for (const w of words) {
    out.add(crc(`w${w}`) % buckets);
    const p = `<${w}>`;
    for (const n of [3, 4]) for (let k = 0; k + n <= p.length; k++) out.add(crc(`c${p.slice(k, k + n)}`) % buckets);
  }
  for (let k = 0; k + 1 < words.length; k++) out.add(crc(`b${words[k]} ${words[k + 1]}`) % buckets);
  return [...out].sort((a, b) => a - b).slice(0, cap);
}

function termGrams(t: string, buckets: number): number[] {
  const g = new Set<number>([crc(`s${t}`) % buckets]);
  const p = `<${t}>`;
  for (const n of [3, 4]) for (let k = 0; k + n <= p.length; k++) g.add(crc(`c${p.slice(k, k + n)}`) % buckets);
  return [...g];
}

function delex(text: string): string {
  let t = text;
  for (const [r, s] of DELEX) t = t.replace(r, s);
  return t.replace(CAP_NAME, " xname ");
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const band = (p: number) => (p >= 0.8 ? 3 : p >= 0.55 ? 2 : 1);

export class MicroExpander implements IntentExpander {
  private readonly h: Header;
  private readonly m: Record<string, Mat> = {};
  private readonly d: number;
  private readonly prior: Float64Array;

  constructor(bytes: Uint8Array) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "EIM1") throw new Error("intent micro: not an EIM1 file");
    const hlen = dv.getUint32(4, true);
    this.h = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hlen))) as Header;
    const base = 8 + hlen;
    for (const [name, e] of Object.entries(this.h.arrays)) {
      const n = e.shape.reduce((a, b) => a * b, 1);
      const at = bytes.byteOffset + base + e.offset;
      // Copied out so the arrays are aligned whatever the file's buffer is.
      const q =
        e.dtype === "int8"
          ? new Int8Array(bytes.buffer.slice(at, at + n))
          : new Float32Array(bytes.buffer.slice(at, at + 4 * n));
      const scale =
        e.scale_offset !== undefined
          ? new Float32Array(
              bytes.buffer.slice(
                bytes.byteOffset + base + e.scale_offset,
                bytes.byteOffset + base + e.scale_offset + 4 * e.scale_len!,
              ),
            )
          : null;
      this.m[name] = { q, rows: e.shape[0]!, cols: e.shape.length > 1 ? e.shape[1]! : 1, scale };
    }
    this.d = this.h.args.ctx === "bin" ? this.m.ctx_t!.cols : this.m.ctx!.cols;
    this.prior = Float64Array.from(this.h.prior);
  }

  /** A row of a matrix, dequantised, added into `out` (times `k`). */
  private addRow(m: Mat, r: number, out: Float64Array, k = 1): void {
    const s = (m.scale ? (m.scale.length === 1 ? m.scale[0]! : m.scale[r]!) : 1) * k;
    const o = r * m.cols;
    for (let j = 0; j < m.cols; j++) out[j]! += m.q[o + j]! * s;
  }

  /** `m` (rows x cols) times `x`, plus `b`. */
  private matvec(m: Mat, x: Float64Array, b?: Mat): Float64Array {
    const y = new Float64Array(m.rows);
    for (let r = 0; r < m.rows; r++) {
      const o = r * m.cols;
      let acc = 0;
      for (let j = 0; j < m.cols; j++) acc += m.q[o + j]! * x[j]!;
      y[r] = acc * (m.scale ? (m.scale.length === 1 ? m.scale[0]! : m.scale[r]!) : 1) + (b ? b.q[r]! : 0);
    }
    return y;
  }

  private context(ids: number[]): Float64Array {
    const m = this.m;
    if (this.h.args.ctx === "bin") {
      const x = new Float64Array(this.d);
      for (const id of ids) this.addRow(m.ctx_t!, id, x);
      for (let j = 0; j < this.d; j++) x[j] = x[j]! * m.bn0_s!.q[j]! + m.bn0_h!.q[j]! >= 0 ? 1 : -1;
      const y = this.matvec(m.l1!, x);
      for (let j = 0; j < y.length; j++) y[j] = y[j]! * m.bn1_s!.q[j]! + m.bn1_h!.q[j]! >= 0 ? 1 : -1;
      return y;
    }
    const x = new Float64Array(this.d);
    if (ids.length === 0) return x;
    for (const id of ids) this.addRow(m.ctx!, id, x, 1 / ids.length);
    return x;
  }

  /** The raw scores, for the parity test: generation logits (or null) and each own term's copy logit. */
  forward(title: string, text: string): { gen: Float64Array | null; copy: [string, number][]; terms: string[] } {
    const a = this.h.args;
    const m = this.m;
    const full = `${title}\n${text}`;
    const c = this.context(microGrams(full, a.buckets, a.cap));
    const cg = a.delex ? this.context(microGrams(delex(full), a.buckets, a.cap)) : c;
    let gen: Float64Array | null = null;
    if (a.gen === "mlp") {
      const h = this.matvec(m.gh_w!, cg, m.gh_b);
      for (let j = 0; j < h.length; j++) if (h[j]! < 0) h[j] = 0;
      gen = this.matvec(m.go_w!, h, m.go_b);
    } else if (a.gen === "codes") {
      const z = this.matvec(m.pick_w!, cg, m.pick_b);
      let k = 0;
      for (let j = 1; j < z.length; j++) if (z[j]! > z[k]!) k = j;
      gen = new Float64Array(m.book!.cols);
      this.addRow(m.book!, k, gen);
    }
    const terms = intentTerms(full);
    const titled = new Set(intentTerms(title));
    const first = new Map<string, number>();
    const count = new Map<string, number>();
    terms.forEach((t, i) => {
      if (!first.has(t)) first.set(t, i);
      count.set(t, (count.get(t) ?? 0) + 1);
    });
    const n = Math.max(1, terms.length);
    const own = [...first.keys()].slice(0, MAX_OWN);
    // The copy head's first layer split by input: the item's context and the bias once an item, then each term's own
    // part (its gram rows and six scalars): the same sums, in a fraction of the products.
    const tdim = m.temb!.cols;
    const ch = m.ch_w!;
    const H = ch.rows;
    const base = new Float64Array(H);
    for (let r = 0; r < H; r++) {
      const o = r * ch.cols + tdim;
      let acc = 0;
      for (let j = 0; j < this.d; j++) acc += ch.q[o + j]! * c[j]!;
      base[r] = acc;
    }
    const co = m.co_w!;
    const coB = m.co_b!.q[0]!;
    const te = new Float64Array(tdim);
    const sc = new Float64Array(6);
    const copy: [string, number][] = [];
    for (const t of own) {
      te.fill(0);
      for (const id of termGrams(t, a.tbuckets)) this.addRow(m.temb!, id, te);
      sc[0] = Math.log1p(count.get(t)!);
      sc[1] = first.get(t)! / n;
      sc[2] = titled.has(t) ? 1 : 0;
      sc[3] = /\d/.test(t) ? 1 : 0;
      sc[4] = Math.min(t.length, 12) / 12;
      sc[5] = Math.log1p(n) / 6;
      let z = 0;
      for (let r = 0; r < H; r++) {
        const o = r * ch.cols;
        let acc = base[r]!;
        for (let j = 0; j < tdim; j++) acc += ch.q[o + j]! * te[j]!;
        const os = o + tdim + this.d;
        for (let j = 0; j < 6; j++) acc += ch.q[os + j]! * sc[j]!;
        const hr = acc * ch.scale![r]! + m.ch_b!.q[r]!;
        if (hr > 0) z += co.q[r]! * hr;
      }
      copy.push([t, z * co.scale![0]! + coB]);
    }
    return { gen, copy, terms };
  }

  /** The expansion as `{term: weight}` (1-3), as the trainer's `decode`. */
  weights(title: string, text: string): Map<string, number> {
    const a = this.h.args;
    const { gen, copy, terms } = this.forward(title, text);
    const out = new Map<string, number>();
    const scored = copy.map(([t, z]) => [sigmoid(z), t] as const);
    // Python's sorted(reverse=True) over (p, term): probability, then the term, both descending.
    scored.sort((p, q) => q[0] - p[0] || (q[1] < p[1] ? -1 : q[1] > p[1] ? 1 : 0));
    for (const [p, t] of scored.slice(0, a.kc)) if (p >= a.theta_c) out.set(t, band(p));
    if (gen && a.kg > 0) {
      const own = new Set(terms);
      const pg = Array.from(gen, sigmoid);
      const score = a.lift > 0 ? pg.map((p, i) => p / this.prior[i]!) : pg;
      const order = score.map((_, i) => i).sort((i, j) => score[j]! - score[i]! || i - j);
      let g = 0;
      for (const i of order.slice(0, Math.min(score.length, a.kg + 20))) {
        if (g >= a.kg) break;
        if (pg[i]! < a.theta_g || (a.lift > 0 && score[i]! < a.lift)) continue;
        const t = this.h.vocab[i]!;
        if (!own.has(t) && !out.has(t)) {
          out.set(t, band(pg[i]!));
          g++;
        }
      }
    }
    return out;
  }

  expand(title: string, text: string): readonly string[] {
    const terms: string[] = [];
    for (const [t, w] of this.weights(title, text)) for (let i = 0; i < w; i++) terms.push(t);
    return terms;
  }
}

/** Where the shipped weights live. */
export const MICRO_MODEL_PATH = join(import.meta.dir, "..", "models", "intent-micro.bin");

let shared: MicroExpander | null | undefined;

/** The shared expander, loaded once per process (null when the file is missing or unreadable: fail open). */
export function intentMicroExpander(path = MICRO_MODEL_PATH): MicroExpander | null {
  if (shared !== undefined && path === MICRO_MODEL_PATH) return shared;
  let e: MicroExpander | null = null;
  try {
    e = new MicroExpander(readFileSync(path));
  } catch {
    e = null;
  }
  if (path === MICRO_MODEL_PATH) shared = e;
  return e;
}
