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

const crc = (s: string, buckets: number) => Bun.hash.crc32(s) % buckets;

/** m6lib.py's `grams`: hashed words, character 3- and 4-grams inside words, word bigrams (first 120 words). */
export function grams(text: string, buckets: number, prefix: string, out: Set<number>): void {
  const ws = toks(text).slice(0, 120);
  for (const w of ws) {
    out.add(crc(`${prefix}w${w}`, buckets));
    const p = `<${w}>`;
    for (const n of [3, 4])
      for (let k = 0; k + n <= p.length; k++) out.add(crc(`${prefix}c${p.slice(k, k + n)}`, buckets));
  }
  for (let k = 0; k + 1 < ws.length; k++) out.add(crc(`${prefix}b${ws[k]} ${ws[k + 1]}`, buckets));
}

const count = (re: RegExp, s: string) => s.match(re)?.length ?? 0;
const isUpper = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();

/** cands.py's `dense` with `item_stats`: 27 numbers a part. */
export function denseOf(parts: readonly Part[], focus: ReadonlySet<string>, title: string): number[][] {
  const n = parts.length;
  const ov = parts.map((p) => {
    let c = 0;
    for (const w of new Set(toks(p.text))) if (focus.has(w)) c++;
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
    const ws = new Set(toks(t));
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
export function sparseOf(text: string, focus: ReadonlySet<string>, buckets: number): number[] {
  const out = new Set<number>();
  grams(text, buckets, "p", out);
  const ids = [...out];
  for (const w of new Set(toks(text))) if (focus.has(w)) ids.push(crc(`s${w}`, buckets));
  const status = [...text.matchAll(STATUS)].slice(0, 4).map((m) => m[0].toLowerCase());
  const rq = [...focus].sort().slice(0, 12);
  for (const a of rq) for (const b of status) ids.push(crc(`x${a}|${b}`, buckets));
  return ids;
}

export class PartTrimmer {
  private readonly w: Int8Array;
  private constructor(private readonly m: TrimModel) {
    const bytes = Buffer.from(m.weights, "base64");
    this.w = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Reads the weights once; null (the trimmer off, `pick` as before) when the file is missing or unreadable. */
  static load(path = TRIM_MODEL_PATH): PartTrimmer | null {
    try {
      const m = JSON.parse(readFileSync(path, "utf8")) as TrimModel;
      if (m.arch !== "lr" || m.dense.length !== 27) return null;
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
    const focus = this.m.request === false ? new Set<string>() : focusOf(request);
    const dense = denseOf(parts, focus, title);
    const out = new Float64Array(parts.length);
    const { buckets, scale, bias } = this.m;
    for (let k = 0; k < parts.length; k++) {
      let z = bias;
      for (const i of sparseOf(parts[k]!.text, focus, buckets)) z += this.w[i]! * scale;
      const d = dense[k]!;
      for (let j = 0; j < d.length; j++) z += d[j]! * this.m.dense[j]!;
      out[k] = 1 / (1 + Math.exp(-z));
    }
    return out;
  }
}
