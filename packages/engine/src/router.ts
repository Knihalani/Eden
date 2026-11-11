/**
 * M8's connector router (D940–D949; docs/research/m8-router.md): from a request's words and a user's own history,
 * which of the user's sources hold what the request needs, so a lookup reads those live and skips the rest.
 *
 * This file holds the router's features. Terms are the shared tokenizer's (`@eden/primitives`: a letter or digit,
 * then letters, digits, marks, apostrophes, underscores, hyphens; folded; a trailing possessive and punctuation cut;
 * one-character terms dropped), each hashed with FNV-1a over its folded code units, so the lab's trainers (which read
 * terms exported by `m8-export.ts`) and the engine see the same numbers by construction.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classOf, CLASS, fnv1a, foldString, mix32, WORD_PART, WORD_START } from "@eden/primitives";

/** Words a request or item is read for at most (bounded input: the router never reads more). */
export const ROUTER_MAX_TERMS = 512;

function isStart(c: number): boolean {
  return ((c < 128 ? CLASS[c]! : classOf(c)) & WORD_START) !== 0;
}
function isPart(c: number): boolean {
  return ((c < 128 ? CLASS[c]! : classOf(c)) & WORD_PART) !== 0;
}

/** Calls `each(start, end)` for every term span of `text` (after the tokenizer's trims), at most `max`. */
function spans(text: string, max: number, each: (start: number, end: number) => void): void {
  const n = text.length;
  let i = 0;
  let count = 0;
  while (i < n && count < max) {
    if (!isStart(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && isPart(text.charCodeAt(i))) i++;
    let end = i;
    if (end - start > 2) {
      const last = text.charCodeAt(end - 1);
      const prev = text.charCodeAt(end - 2);
      if ((last === 115 || last === 83) && (prev === 39 || prev === 0x2019)) end -= 2;
    }
    while (end > start && !isStart(text.charCodeAt(end - 1))) end--;
    each(start, end);
    count++;
  }
}

/** The terms of `text` as hashes, in order (bigrams are read from neighbours), at most `ROUTER_MAX_TERMS`. */
export function routerTerms(text: string): number[] {
  const out: number[] = [];
  spans(text, ROUTER_MAX_TERMS, (start, end) => {
    const term = foldString(text.slice(start, end));
    if (term.length <= 1) return;
    out.push(fnv1a(term, 0, term.length));
  });
  return out;
}

/**
 * The names a text mentions, as term hashes: a term written with a capital first letter that does not open a
 * sentence (a request's first word, or one after ". ", "! ", "? " or a line break, is often capitalised for its
 * place alone). Deduplicated, at most 32.
 */
export function routerNames(text: string): number[] {
  const out = new Set<number>();
  let opener = true;
  let last = 0;
  spans(text, ROUTER_MAX_TERMS, (start, end) => {
    for (let j = last; j < start; j++) {
      const c = text.charCodeAt(j);
      if (c === 46 || c === 33 || c === 63 || c === 10) opener = true;
    }
    last = end;
    const c = text.charCodeAt(start);
    const capital = c >= 65 && c <= 90 ? true : c >= 128 ? text[start] !== text[start]!.toLowerCase() : false;
    if (capital && !opener && out.size < 32) {
      const term = foldString(text.slice(start, end));
      if (term.length > 1) out.add(fnv1a(term, 0, term.length));
    }
    opener = false;
  });
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------------
// The request side: hashed unigrams and bigrams; the source side: its identity and its description's terms.

/** The request's features: each term mixed, and each pair of neighbours (`mix32(a * φ + b)`). */
export function requestFeatures(terms: readonly number[]): Uint32Array {
  const n = terms.length;
  const out = new Uint32Array(n > 0 ? 2 * n - 1 : 0);
  for (let i = 0; i < n; i++) out[i] = mix32(terms[i]!);
  for (let i = 0; i + 1 < n; i++) out[n + i] = mix32((Math.imul(terms[i]!, 0x9e3779b1) + terms[i + 1]!) >>> 0);
  return out;
}

/** Description terms a source contributes at most. */
const DESC_KEYS = 12;
const TRAILING_NUMBER = /[-_]?\d+$/;

/**
 * A source's keys: its identity without a trailing number ("jira-3" and "jira-7" are one kind of connector), then up
 * to 12 distinct terms of that kind and its description (what reaches a connector no training saw).
 */
export function sourceKeys(id: string, description: string): Uint32Array {
  const kind = id.replace(TRAILING_NUMBER, "");
  const keys = [mix32(fnv1a(kind, 0, kind.length))];
  const seen = new Set<number>();
  // The kind, not the id: a tenant's many connectors of one kind share their keys (and one score a lookup).
  for (const t of routerTerms(`${kind} ${description}`)) {
    if (seen.has(t)) continue;
    seen.add(t);
    keys.push((mix32(t) ^ 0x5bd1e995) >>> 0);
    if (seen.size >= DESC_KEYS) break;
  }
  return Uint32Array.from(keys);
}

/** The table bucket of a (request feature, source key) conjunction. */
export function conjBucket(f: number, k: number, mask: number): number {
  return mix32((Math.imul(f, 0x9e3779b1) + k) >>> 0) & mask;
}

// ---------------------------------------------------------------------------------------------------------------
// The model: a table of conjunction weights (int8) and a small network over each source's evidence.

/** Per-source inputs, in this order (the lab's trainer writes weights for the same order). */
export const ROUTER_FEATURES = [
  "conj", // the conjunction table's score for the request and the source's keys
  "local", // log2(1 + the source's items among the request's 40 best local matches): `routeLocalHits`
  "sketch", // the request's terms in the source's vocabulary sketch: `routeSketch`
  "named", // a name of the request that the source's items mentioned (the source map)
  "rare", // a word of the request that at most two of the user's sources hold (`RareTerms`)
  "used", // an item of the source has reached the agent (`SourceYield`)
  "run", // live reads of the source since one of its items was used, decayed (`SourceYield`)
  "whole", // the synced copy holds the whole source (not cut, D264)
  "hours", // log1p of hours since the copy's last complete poll
  "size", // log1p of the ids the copy holds
  "rate", // log1p of its learned change rate (items an hour), times 100
] as const;
export const ROUTER_NF = ROUTER_FEATURES.length;
/** Request-level inputs of the "nothing needed" score: the best conj, best local, any name, any rare word, terms. */
export const ROUTER_NULL_NF = 5;

export interface RouterWeights {
  /** Conjunction table size (a power of two) and its int8 weights with their scale. */
  buckets: number;
  conj: Int8Array;
  conjScale: number;
  hidden: number;
  /** Input normalisation, then `w1` (NF × hidden, row-major), `b1`, `w2`, `b2`. */
  mu: Float32Array;
  sd: Float32Array;
  w1: Float32Array;
  b1: Float32Array;
  w2: Float32Array;
  b2: number;
  /** The "nothing needed" logit: `nullBias + nullW · request summary`. */
  nullBias: number;
  nullW: Float32Array;
  temperature: number;
  /** The probability under which a source is not read live (fit offline for the recall target). */
  floor: number;
}

const MAGIC = 0x3152384d; // "M8R1"

/** The weights file: "M8R1", the header's byte length, the header (JSON numbers), then the int8 table. */
export function parseRouterWeights(bytes: Uint8Array): RouterWeights {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || view.getUint32(0, true) !== MAGIC) throw new Error("router weights: bad magic");
  const len = view.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len))) as Record<string, unknown>;
  const buckets = Number(head.buckets);
  if (!(buckets > 0) || (buckets & (buckets - 1)) !== 0) throw new Error("router weights: buckets");
  const conj = new Int8Array(bytes.buffer, bytes.byteOffset + 8 + len, buckets).slice();
  const f32 = (k: string, n: number) => {
    const a = head[k] as number[];
    if (!Array.isArray(a) || a.length !== n) throw new Error(`router weights: ${k}`);
    return Float32Array.from(a);
  };
  const hidden = Number(head.hidden);
  return {
    buckets,
    conj,
    conjScale: Number(head.conjScale),
    hidden,
    mu: f32("mu", ROUTER_NF),
    sd: f32("sd", ROUTER_NF),
    w1: f32("w1", ROUTER_NF * hidden),
    b1: f32("b1", hidden),
    w2: f32("w2", hidden),
    b2: Number(head.b2),
    nullBias: Number(head.nullBias),
    nullW: f32("nullW", ROUTER_NULL_NF),
    temperature: Number(head.temperature),
    floor: Number(head.floor),
  };
}

/** Writes the weights file (the lab's export, and tests). */
export function encodeRouterWeights(w: RouterWeights): Uint8Array {
  const head = new TextEncoder().encode(
    JSON.stringify({
      buckets: w.buckets,
      conjScale: w.conjScale,
      hidden: w.hidden,
      mu: [...w.mu],
      sd: [...w.sd],
      w1: [...w.w1],
      b1: [...w.b1],
      w2: [...w.w2],
      b2: w.b2,
      nullBias: w.nullBias,
      nullW: [...w.nullW],
      temperature: w.temperature,
      floor: w.floor,
    }),
  );
  const out = new Uint8Array(8 + head.byteLength + w.buckets);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, head.byteLength, true);
  out.set(head, 8);
  out.set(new Uint8Array(w.conj.buffer, w.conj.byteOffset, w.buckets), 8 + head.byteLength);
  return out;
}

/** The conjunction score of a request's features with one source's keys. */
export function conjScore(w: RouterWeights, feats: Uint32Array, keys: Uint32Array): number {
  const mask = w.buckets - 1;
  let sum = 0;
  for (let i = 0; i < feats.length; i++) {
    const f = feats[i]!;
    for (let j = 0; j < keys.length; j++) sum += w.conj[conjBucket(f, keys[j]!, mask)]!;
  }
  const n = feats.length * keys.length;
  return n > 0 ? (sum * w.conjScale) / Math.sqrt(n) : 0;
}

/**
 * Each source's probability of holding what the request needs, beside the probability that it needs nothing:
 * a softmax over [nothing, sources...] of the network's logits, at the fitted temperature. `x` holds each source's
 * `ROUTER_NF` inputs row by row; `summary` the `ROUTER_NULL_NF` request inputs. Writes into `out` (length n).
 */
export function routeProbabilities(
  w: RouterWeights,
  x: Float64Array,
  n: number,
  summary: Float64Array,
  out: Float64Array,
): number {
  const h = w.hidden;
  const t = w.temperature > 0 ? w.temperature : 1;
  let nul = w.nullBias;
  for (let j = 0; j < ROUTER_NULL_NF; j++) nul += w.nullW[j]! * summary[j]!;
  nul /= t;
  let max = nul;
  for (let s = 0; s < n; s++) {
    let z = w.b2;
    for (let k = 0; k < h; k++) {
      let a = w.b1[k]!;
      for (let f = 0; f < ROUTER_NF; f++) a += ((x[s * ROUTER_NF + f]! - w.mu[f]!) / w.sd[f]!) * w.w1[f * h + k]!;
      if (a > 0) z += a * w.w2[k]!;
    }
    z /= t;
    out[s] = z;
    if (z > max) max = z;
  }
  let sum = Math.exp(nul - max);
  for (let s = 0; s < n; s++) sum += out[s] = Math.exp(out[s]! - max);
  for (let s = 0; s < n; s++) out[s]! /= sum;
  return Math.exp(nul - max) / sum;
}

/** The shipped weights, read once a process from `assets/router.bin` beside this package; null when absent. */
let shipped: RouterWeights | null | undefined;
export function defaultRouterWeights(): RouterWeights | null {
  if (shipped !== undefined) return shipped;
  try {
    shipped = parseRouterWeights(new Uint8Array(readFileSync(join(import.meta.dir, "..", "assets", "router.bin"))));
  } catch {
    shipped = null;
  }
  return shipped;
}
