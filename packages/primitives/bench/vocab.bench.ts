/**
 * Interner designs on the same scan: identity by comparing against string objects, against a character arena, or by
 * a two-lane fingerprint with no comparison (what `Vocab` does). Each is a minimal open-addressing table.
 */
import { heapStats } from "bun:jsc";
import { CLASS, classOf, WORD_PART, WORD_START } from "../src/charclass";
import { tokenizeInto } from "../src/tokenize";
import { Vocab } from "../src/vocab";
import { bench, corpus, report } from "./harness";

const text = corpus(2048);
const SIZE = 1 << 12;
const MASK = SIZE - 1;

/** Scans ASCII terms of `text`, calling `visit(start, end, h, g)` with both hash lanes. */
function scan(t: string, visit: (s: number, e: number, h: number, g: number) => number): number {
  const n = t.length;
  let i = 0;
  let acc = 0;
  while (i < n) {
    let c = t.charCodeAt(i);
    if (((c < 128 ? CLASS[c]! : classOf(c)) & WORD_START) === 0) {
      i++;
      continue;
    }
    const s = i;
    let h = 0x811c9dc5 | 0;
    let g = 0x9747b28c | 0;
    for (; i < n; i++) {
      c = t.charCodeAt(i);
      if (((c < 128 ? CLASS[c]! : classOf(c)) & WORD_PART) === 0) break;
      if (c >= 65 && c <= 90) c |= 32;
      h = Math.imul(h ^ c, 0x01000193);
      g = Math.imul(g ^ c, 0x5bd1e995);
      g = (g << 15) | (g >>> 17);
    }
    if (i - s > 1) acc += visit(s, i, h >>> 0, g >>> 0);
  }
  return acc;
}

// (a) compare against string objects
const aSlots = new Int32Array(SIZE);
const aHash: number[] = [];
const aStr: string[] = [];
function viaStrings(s: number, e: number, h: number): number {
  for (let i = h & MASK; ; i = (i + 1) & MASK) {
    const v = aSlots[i]!;
    if (v === 0) {
      aStr.push(text.slice(s, e).toLowerCase());
      aHash.push(h);
      aSlots[i] = aStr.length;
      return aStr.length;
    }
    const t = aStr[v - 1]!;
    if (aHash[v - 1] !== h || t.length !== e - s) continue;
    let j = 0;
    for (; j < t.length; j++) {
      let c = text.charCodeAt(s + j);
      if (c >= 65 && c <= 90) c |= 32;
      if (c !== t.charCodeAt(j)) break;
    }
    if (j === t.length) return v;
  }
}

// (b) compare against a character arena
const bSlots = new Int32Array(SIZE);
const bHash = new Uint32Array(SIZE);
const bOff = new Uint32Array(SIZE);
const bLen = new Uint32Array(SIZE);
const arena = new Uint16Array(1 << 16);
let used = 0;
let bCount = 0;
function viaArena(s: number, e: number, h: number): number {
  const len = e - s;
  for (let i = h & MASK; ; i = (i + 1) & MASK) {
    const v = bSlots[i]!;
    if (v === 0) {
      const id = bCount++;
      for (let j = 0; j < len; j++) {
        let c = text.charCodeAt(s + j);
        if (c >= 65 && c <= 90) c |= 32;
        arena[used + j] = c;
      }
      bOff[id] = used;
      bLen[id] = len;
      bHash[id] = h;
      used += len;
      bSlots[i] = id + 1;
      return id + 1;
    }
    const id = v - 1;
    if (bHash[id] !== h || bLen[id] !== len) continue;
    const off = bOff[id]!;
    let j = 0;
    for (; j < len; j++) {
      let c = text.charCodeAt(s + j);
      if (c >= 65 && c <= 90) c |= 32;
      if (c !== arena[off + j]) break;
    }
    if (j === len) return v;
  }
}

// (c) two-lane fingerprint, no comparison
const cH = new Uint32Array(SIZE);
const cG = new Uint32Array(SIZE);
const cLen = new Uint32Array(SIZE);
const cSlots = new Int32Array(SIZE);
let cCount = 0;
function viaFingerprint(s: number, e: number, h: number, g: number): number {
  const len = e - s;
  for (let i = h & MASK; ; i = (i + 1) & MASK) {
    const v = cSlots[i]!;
    if (v === 0) {
      const id = cCount++;
      cH[id] = h;
      cG[id] = g;
      cLen[id] = len;
      cSlots[i] = id + 1;
      return id + 1;
    }
    const id = v - 1;
    if (cH[id] === h && cG[id] === g && cLen[id] === len) return v;
  }
}

report([
  bench("scan + hash only", () => scan(text, () => 1), { batch: 50 }),
  bench("+ intern, compare against string objects", () => scan(text, viaStrings), { batch: 50 }),
  bench("+ intern, compare against a char arena", () => scan(text, viaArena), { batch: 50 }),
  bench("+ intern, two-lane fingerprint (Vocab)", () => scan(text, viaFingerprint), { batch: 50 }),
]);

// The Vocab class itself: lookups of known terms (what every query does), and a churn of new terms in and old ones
// released at a steady 4,096 live (what an index with `onTermFreed` does to a user's vocabulary; release is new).
const words = [...new Set(text.toLowerCase().match(/[a-z]+/g) ?? [])];
const known = new Vocab();
for (const w of words) known.intern(w);
let wi = 0;
const churn = new Vocab();
const ring: number[] = [];
let fresh = 0;
const rows = [
  bench(`Vocab.lookup, ${words.length} known terms`, () => {
    let acc = 0;
    for (let i = 0; i < words.length; i++) acc += known.lookup(words[(wi + i) % words.length]!);
    wi++;
    return acc;
  }),
];
if (typeof (churn as { release?: unknown }).release === "function") {
  for (; fresh < 4_096; fresh++) ring.push(churn.intern(`t${fresh}`));
  rows.push(
    bench("Vocab.intern new + release oldest, 4,096 live", () => {
      churn.release(ring[fresh % 4_096]!);
      ring[fresh % 4_096] = churn.intern(`t${fresh}`);
      fresh++;
      return churn.size;
    }),
  );
}
report(rows);

// Every term new (a cold vocabulary): what interning a user's first items costs, where each new term is folded and
// stored. 2 KB of text with 10% non-ASCII, a fresh Vocab per run.
const cold = corpus(2048, { nonAscii: true, seed: 5 });
const coldOut = new Uint32Array(cold.length);
report([
  bench("tokenizeInto, cold Vocab (every term new), 2 KB +10% non-ASCII", () =>
    tokenizeInto(cold, new Vocab(256), true, coldOut, null),
  ),
]);

// Heap per stored term: the slope of the JSC heap from 20k to 120k distinct terms of 9-22 characters, each interned
// from a slice of one flat text (as `tokenizeInto` hands them over).
{
  const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let seed = 11;
  const rand = () => (seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0) / 2 ** 32;
  const parts: string[] = [];
  for (let i = 0; i < 120_000; i++) {
    let w = "";
    for (let j = 8 + Math.floor(rand() * 10); j > 0; j--) w += letters[Math.floor(rand() * letters.length)];
    parts.push(`${w}${i}`);
  }
  const flat = parts.join(" ");
  parts.length = 0;
  const v = new Vocab(1 << 18);
  let at = 0;
  const intern = (n: number) => {
    for (let k = 0; k < n; k++) {
      let e = flat.indexOf(" ", at);
      if (e < 0) e = flat.length;
      v.intern(flat.slice(at, e));
      at = e + 1;
    }
  };
  const heap = () => {
    Bun.gc(true);
    Bun.gc(true);
    return heapStats().heapSize;
  };
  intern(20_000);
  const a = heap();
  intern(100_000);
  const b = heap();
  console.log(`Vocab heap per stored term (20k -> 120k terms): ${((b - a) / 100_000).toFixed(1)} B/term`);
}
