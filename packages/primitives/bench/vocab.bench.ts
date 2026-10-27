/**
 * Interner designs on the same scan: identity by comparing against string objects, against a character arena, or by
 * a two-lane fingerprint with no comparison (what `Vocab` does). Each is a minimal open-addressing table.
 */
import { CLASS, classOf, WORD_PART, WORD_START } from "../src/charclass";
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
