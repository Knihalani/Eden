/**
 * A string interner: term ↔ dense integer id, so indexes, sets and counters work on Uint32Arrays instead of strings.
 *
 * Identity is a fingerprint, two 32-bit lanes (`termHash`) plus the folded length, with no character comparison.
 * Lane one is FNV-1a; lane two is an xor-multiply with a different multiplier and a rotation each step, so its low
 * bits depend on every input bit (without the rotation, the low k bits of both lanes depend only on the low k bits of
 * the characters, and the pair is weaker than 64 bits). Not a proven 64-bit hash: collisions are very unlikely but
 * not quantified here; one would merge two terms' postings, never crash. Measured on a 2 KB email (298 terms), scan
 * plus intern took 17.15 µs comparing against string objects, 15.31 µs against a character arena, and 6.30 µs with
 * the fingerprint (bench/vocab.bench.ts; docs/research/primitives.md).
 *
 * The *Range methods take a range of a larger string whose hash the caller computed while scanning (the tokenizer
 * does), so a known term allocates nothing. Keys are folded (lowercase, accents dropped: "Zoë" and "zoe" are one
 * term); the length that identifies a term is its folded length, which the caller passes.
 *
 * Release. `release(id)` forgets a term: its slot is removed with a backward-shift delete (no tombstones, so lookups
 * stay as short as in a table that never held it), its string and fingerprint are cleared, and its id goes on a free
 * list that the next new term takes. So `size` is the id capacity (every id is below it; what id-indexed arrays are
 * sized by) and `live` the terms held. A caller that keeps per-id state registers `onRelease` to drop it: an id may
 * name another term after a release.
 */

import { Buffer } from "node:buffer";
import { FOLD, FOLD_DROP, FOLD_EXPAND, foldOf, foldString } from "./charclass";

/**
 * The two hash lanes over `s[start, end)`, folded per character (FOLD: lowercase, accents dropped). Returns false if
 * a character expands when folded (a ligature); the caller then folds the whole string with `foldString` first.
 */
export function termHash(s: string, start: number, end: number, out: Uint32Array): boolean {
  let h = 0x811c9dc5 | 0;
  let g = 0x9747b28c | 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    const f = c < 128 ? FOLD[c]! : foldOf(c);
    if (f === FOLD_DROP) continue;
    if (f === FOLD_EXPAND) return false;
    h = Math.imul(h ^ f, 0x01000193);
    g = Math.imul(g ^ f, 0x5bd1e995);
    g = (g << 15) | (g >>> 17);
  }
  out[0] = h;
  out[1] = g;
  return true;
}

/** Folds `term` and hashes it into `out`; returns the folded term. */
function hashTerm(term: string, out: Uint32Array): string {
  if (termHash(term, 0, term.length, out)) return term;
  const folded = foldString(term);
  termHash(folded, 0, folded.length, out);
  return folded;
}

const scratch = new Uint32Array(2);
/** `lens` of a released id: no folded length is this, so `find` never matches it and `rehash` skips it. */
const RELEASED = 0xffff_ffff;
/** `blen` of a term held as a string in `wide` (a character past Latin-1, or a term of 65,535 characters or more). */
const WIDE = 0xffff;

/**
 * Recently decoded terms, process-wide (D998): direct-mapped by (vocabulary, id), so the stopword and usage checks
 * that read every term of an event (`contentTerms`) do not decode each again (about 40 ns a decode; `contentTerms`
 * ran 2.2x slower without it, tokenize.bench). An entry is the reading vocabulary's own term: its key holds the
 * vocabulary's serial number (never an object reference, so a dropped vocabulary is not kept alive), a release
 * evicts the id's entry, and `clearTermMemo` empties it (the engine calls it when a user is forgotten).
 */
const MEMO_SLOTS = 8_192;
const memoOwner = new Int32Array(MEMO_SLOTS);
const memoId = new Int32Array(MEMO_SLOTS);
const memoTerm: string[] = new Array<string>(MEMO_SLOTS).fill("");
let serials = 0;

const memoSlot = (serial: number, id: number) => (Math.imul(id, 0x9e3779b1) ^ Math.imul(serial, 0x85ebca6b)) >>> 19;

/** Empties the decoded-term memo (a forgotten user's terms must not stay resident). */
export function clearTermMemo(): void {
  memoOwner.fill(0);
  memoTerm.fill("");
}

/** What `Vocab.snapshot` saves (D860). */
export interface VocabSnapshot {
  terms: string[];
  free: number[];
  h1: Uint32Array;
  h2: Uint32Array;
  lens: Uint32Array;
}

export class Vocab {
  private slots: Int32Array;
  private mask: number;
  private h1: Uint32Array;
  private h2: Uint32Array;
  private lens: Uint32Array;
  /**
   * The terms (D998): each Latin-1 term's characters as bytes in one arena (`start`, `blen` per id), a term past
   * Latin-1 as a string in `wide`. A string per term was about 35 bytes a term with its array slot (0.5 MB of a heavy
   * user's 18,000 terms, `live-heap.bench.ts`); bytes and offsets are about 6 plus its length. `term` decodes
   * (`latin1Slice`, about 40 ns); a released term's bytes stay until the arena is compacted (`compact`).
   */
  private bytes: Buffer = Buffer.alloc(256);
  private used = 0;
  private dead = 0;
  private start: Uint32Array;
  private blen: Uint16Array;
  private readonly wide = new Map<number, string>();
  /** Ids handed out, live or released. */
  private count = 0;
  /** This vocabulary's key in the decoded-term memo (never 0: a cleared slot's owner). */
  private readonly serial = (serials = (serials % 0x7fff_fffe) + 1);
  /** Released ids, reused last-released first. */
  private readonly free: number[] = [];
  private readonly listeners: ((id: number) => void)[] = [];

  constructor(capacity = 1_024) {
    const size = 1 << Math.ceil(Math.log2(Math.max(16, capacity * 2)));
    this.slots = new Int32Array(size);
    this.mask = size - 1;
    const ids = Math.max(16, capacity);
    this.h1 = new Uint32Array(ids);
    this.h2 = new Uint32Array(ids);
    this.lens = new Uint32Array(ids);
    this.start = new Uint32Array(ids);
    this.blen = new Uint16Array(ids);
  }

  /** The id capacity: every id, live or released, is below it. Size id-indexed arrays by it. */
  get size(): number {
    return this.count;
  }

  /** Terms held (`size` less the released ids awaiting reuse). */
  get live(): number {
    return this.count - this.free.length;
  }

  /** The (folded) term for an id; "" for a released id. */
  term(id: number): string {
    const n = this.blen[id]!;
    if (n === 0) return "";
    const slot = memoSlot(this.serial, id);
    if (memoOwner[slot] === this.serial && memoId[slot] === id) return memoTerm[slot]!;
    const at = this.start[id]!;
    const t = n === WIDE ? this.wide.get(id)! : this.bytes.latin1Slice(at, at + n);
    memoOwner[slot] = this.serial;
    memoId[slot] = id;
    memoTerm[slot] = t;
    return t;
  }

  /**
   * FNV-1a over the term's characters (`hash.ts`'s `fnv1a` of `term(id)`), read from the arena without making the
   * string; -1 for a term held in `wide` (the caller reads `term(id)`). For `TextSketcher`, which hashes each term of
   * every text it loads.
   */
  termFnv(id: number): number {
    const n = this.blen[id]!;
    if (n === WIDE) return -1;
    const b = this.bytes;
    let h = 0x811c9dc5 | 0;
    for (let i = this.start[id]!, end = i + n; i < end; i++) h = Math.imul(h ^ b[i]!, 0x01000193);
    return h >>> 0;
  }

  /** Whether the term holds an ASCII digit, read from the arena; false for a term in `wide` (see `termFnv`). */
  termHasDigit(id: number): boolean {
    const n = this.blen[id]!;
    if (n === WIDE) return false;
    const b = this.bytes;
    for (let i = this.start[id]!, end = i + n; i < end; i++) if (b[i]! >= 48 && b[i]! <= 57) return true;
    return false;
  }

  /** Calls `fn(id)` whenever an id is released (`release`): per-id state kept outside must be dropped then. */
  onRelease(fn: (id: number) => void): void {
    this.listeners.push(fn);
  }

  /**
   * Forgets the term of `id`: lookups no longer find it, `term(id)` returns "", and the id is reused by a later new
   * term. The caller must hold no live reference to the id (an index posting, a stored doc's terms). A released or
   * unknown id is ignored.
   */
  release(id: number): void {
    if (id < 0 || id >= this.count || this.lens[id] === RELEASED) return;
    const slots = this.slots;
    const mask = this.mask;
    let i = this.h1[id]! & mask;
    while (slots[i] !== id + 1) i = (i + 1) & mask;
    // Backward-shift delete (linear probing): pull each later entry of the run into the hole when its home slot does
    // not lie cyclically in (hole, its slot], so every remaining key stays reachable from its home without tombstones.
    let j = i;
    for (;;) {
      j = (j + 1) & mask;
      const v = slots[j]!;
      if (v === 0) break;
      const home = this.h1[v - 1]! & mask;
      if (i <= j ? home > i && home <= j : home > i || home <= j) continue;
      slots[i] = v;
      i = j;
    }
    slots[i] = 0;
    this.drop(id);
    this.h1[id] = 0;
    this.h2[id] = 0;
    this.lens[id] = RELEASED;
    this.free.push(id);
    for (const fn of this.listeners) fn(id);
  }

  /** The id of a term (folded first), or -1. */
  lookup(term: string): number {
    const folded = hashTerm(term, scratch);
    return this.find(scratch[0]!, scratch[1]!, foldedLength(folded));
  }

  /** The id of a term (folded first), adding it if new. */
  intern(term: string): number {
    const folded = hashTerm(term, scratch);
    const h = scratch[0]!;
    const g = scratch[1]!;
    const len = foldedLength(folded);
    const id = this.find(h, g, len);
    return id >= 0 ? id : this.add(foldString(folded), h, g, len);
  }

  /** The id of a folded term of length `len` whose lanes are `h`, `g` (as `termHash` computes them), or -1. */
  lookupRange(h: number, g: number, len: number): number {
    return this.find(h >>> 0, g >>> 0, len);
  }

  /** As `lookupRange`, adding `s[start, end)` (folded) if new. */
  internRange(s: string, start: number, end: number, h: number, g: number, len: number): number {
    const id = this.find(h >>> 0, g >>> 0, len);
    return id >= 0 ? id : this.add(foldString(s.slice(start, end)), h >>> 0, g >>> 0, len);
  }

  /**
   * The vocabulary as plain arrays (a frozen user's blob, D860): each id's term ("" when released), the free list in
   * order, and the fingerprints, so `Vocab.restore` rebuilds it without hashing a term again.
   */
  snapshot(): VocabSnapshot {
    const n = this.count;
    const terms: string[] = new Array(n);
    for (let id = 0; id < n; id++) terms[id] = this.term(id);
    return {
      terms,
      free: this.free.slice(),
      h1: this.h1.slice(0, n),
      h2: this.h2.slice(0, n),
      lens: this.lens.slice(0, n),
    };
  }

  /**
   * The vocabulary `snapshot` saved: the same ids for the same terms, the same free list. Without the fingerprints
   * (a caller that saves bytes by leaving them out), each term is hashed again: its id's term is already folded.
   */
  static restore(s: VocabSnapshot | Omit<VocabSnapshot, "h1" | "h2" | "lens">): Vocab {
    const n = s.terms.length;
    const v = new Vocab(Math.max(256, n));
    if ("h1" in s) {
      v.h1.set(s.h1.subarray(0, n));
      v.h2.set(s.h2.subarray(0, n));
      v.lens.set(s.lens.subarray(0, n));
    } else {
      const released = new Uint8Array(n);
      for (const id of s.free) released[id] = 1;
      for (let id = 0; id < n; id++) {
        if (released[id] === 1) {
          v.lens[id] = RELEASED;
          continue;
        }
        const t = s.terms[id]!;
        hashTerm(t, scratch);
        v.h1[id] = scratch[0]!;
        v.h2[id] = scratch[1]!;
        v.lens[id] = foldedLength(t);
      }
    }
    v.count = n; // first: an arena growth inside `put` copies the ids below `count`
    for (let id = 0; id < n; id++) v.put(id, s.terms[id]!);
    for (const id of s.free) v.free.push(id);
    v.rehash(v.slots.length);
    return v;
  }

  private find(h: number, g: number, len: number): number {
    const slots = this.slots;
    const mask = this.mask;
    for (let i = h & mask; ; i = (i + 1) & mask) {
      const v = slots[i]!;
      if (v === 0) return -1;
      const id = v - 1;
      if (this.h1[id] === h && this.h2[id] === g && this.lens[id] === len) return id;
    }
  }

  private add(term: string, h: number, g: number, len: number): number {
    const reused = this.free.pop();
    if (reused !== undefined) {
      this.put(reused, term);
      this.h1[reused] = h;
      this.h2[reused] = g;
      this.lens[reused] = len;
      this.place(reused, h); // the table never holds more than `size` ids, which it was sized for
      return reused;
    }
    const id = this.count;
    if (id >= this.h1.length) this.growIds(this.h1.length * 2);
    this.put(id, term);
    this.count = id + 1;
    this.h1[id] = h;
    this.h2[id] = g;
    this.lens[id] = len;
    if ((id + 1) * 2 > this.slots.length) this.rehash(this.slots.length * 2);
    else this.place(id, h);
    return id;
  }

  private place(id: number, h: number): void {
    const mask = this.mask;
    let i = h & mask;
    while (this.slots[i] !== 0) i = (i + 1) & mask;
    this.slots[i] = id + 1;
  }

  private rehash(size: number): void {
    this.slots = new Int32Array(size);
    this.mask = size - 1;
    for (let id = 0; id < this.count; id++) if (this.lens[id] !== RELEASED) this.place(id, this.h1[id]!);
  }

  private growIds(n: number): void {
    this.h1 = grow(this.h1, n);
    this.h2 = grow(this.h2, n);
    this.lens = grow(this.lens, n);
    this.start = grow(this.start, n);
    const blen = new Uint16Array(n);
    blen.set(this.blen);
    this.blen = blen;
  }

  /** Holds `term` as id's (the id's arrays already fit it). */
  private put(id: number, term: string): void {
    const n = term.length;
    let latin1 = n < WIDE;
    for (let i = 0; latin1 && i < n; i++) if (term.charCodeAt(i) > 0xff) latin1 = false;
    if (!latin1) {
      this.wide.set(id, term);
      this.blen[id] = WIDE;
      return;
    }
    if (this.used + n > this.bytes.length) this.room(n);
    this.bytes.latin1Write(term, this.used, n);
    this.start[id] = this.used;
    this.blen[id] = n;
    this.used += n;
  }

  /**
   * Forgets id's term (a release): its bytes are zeroed (a released term is content no item holds any more; it must
   * not stay readable in the arena) and dead until the arena is compacted.
   */
  private drop(id: number): void {
    const n = this.blen[id]!;
    if (n === WIDE) this.wide.delete(id);
    else if (n > 0) {
      this.bytes.fill(0, this.start[id]!, this.start[id]! + n);
      this.dead += n;
    }
    const slot = memoSlot(this.serial, id);
    if (memoOwner[slot] === this.serial && memoId[slot] === id) {
      memoOwner[slot] = 0;
      memoTerm[slot] = "";
    }
    this.blen[id] = 0;
  }

  /** Room for `n` more bytes: the live terms copied down when most of the arena is dead, else a doubled arena. */
  private room(n: number): void {
    const live = this.used - this.dead;
    const size = Math.max(256, 2 ** Math.ceil(Math.log2((live + n) * 2)));
    const bytes = Buffer.alloc(size);
    let at = 0;
    for (let id = 0; id < this.count; id++) {
      const len = this.blen[id]!;
      if (len === 0 || len === WIDE) continue;
      this.bytes.copy(bytes, at, this.start[id]!, this.start[id]! + len);
      this.start[id] = at;
      at += len;
    }
    this.bytes = bytes;
    this.used = at;
    this.dead = 0;
  }
}

/** Length of a folded term as the tokenizer counts it: characters that fold to nothing do not count. */
function foldedLength(folded: string): number {
  let n = 0;
  for (let i = 0; i < folded.length; i++) {
    const c = folded.charCodeAt(i);
    if ((c < 128 ? FOLD[c]! : foldOf(c)) !== FOLD_DROP) n++;
  }
  return n;
}

function grow(a: Uint32Array, n: number): Uint32Array {
  const b = new Uint32Array(n);
  b.set(a);
  return b;
}
