/**
 * Multi-pattern literal matching (Aho–Corasick), folded: case-insensitive and accent-insensitive, the same folding
 * as the tokenizer (FOLD in charclass.ts). One pass over the text finds every occurrence of every pattern, whatever
 * the number of patterns: for 244 gitleaks keywords over 2 KB it replaces 290 `includes` scans
 * (bench/matcher.bench.ts).
 *
 * The automaton is a dense DFA over a compressed alphabet: only characters that occur in some pattern get their own
 * column; every other character shares column 0. A transition is one Int32Array load, with no failure-link walking at
 * scan time. Memory is states × alphabet × 4 bytes, so this suits up to tens of thousands of states (keyword sets,
 * cue lists); a per-user gazetteer of 100k names belongs in a token-level trie instead.
 *
 * `wholeWord` reports only matches not flanked by letters or digits: "al" does not match inside "also", while "dana"
 * matches in "Dana's" and "bring" in "bring-it" (apostrophes, hyphens and underscores are boundaries here). Combining
 * marks belong to the letter before them: they are skipped when looking for a boundary, and a match's end extends
 * over trailing marks ("café" spelled with a combining accent is matched whole, and "danáx" holds no "dana").
 */
import { CLASS, classOf, FOLD, FOLD_DROP, FOLD_EXPAND, foldOf, foldString, WORD_START } from "./charclass.ts";

export interface MatcherOptions {
  wholeWord?: boolean;
}

/** Called per match with the pattern's index and the match's [start, end) in the original text. */
export type OnMatch = (pattern: number, start: number, end: number) => void;

/** Receives the occurrences `MultiMatcher.scan` keeps: the pattern's index and the match's start. */
export interface MatchSink {
  add(pattern: number, start: number): void;
}

export class MultiMatcher {
  /** The patterns as folded, in the order given. */
  readonly patterns: string[];
  private readonly wholeWord: boolean;
  private readonly asciiCol = new Int32Array(128);
  private readonly otherCol = new Map<number, number>();
  private readonly cols: number;
  /**
   * The transitions: per (state, column), at `state * cols + column`, the next state times `cols` (where its row
   * starts), shifted left one, with bit 0 set when patterns end there. One load per character, no multiply, and
   * `scan` tests for outputs without reading `outStart`.
   */
  private readonly delta: Int32Array;
  /** CSR lists of the patterns ending at each state, own and inherited through suffix links. */
  private readonly outStart: Int32Array;
  private readonly outList: Int32Array;
  private readonly lens: Int32Array;
  private readonly ring: Int32Array;
  /** Per ring slot, its letter's place in a ligature's expansion (0 for an ordinary character). */
  private readonly part: Uint8Array;
  private readonly ringMask: number;
  /** Per ASCII code unit, its folded character's column. */
  private readonly foldCol = new Int32Array(128);
  /**
   * `scan`'s scratch (D1850): at a state's row (`state * cols`, as `delta` gives it, so no division), the scan's
   * `generation` once every pattern ending there is hit and not kept in this text, so the state's later matches do
   * nothing (`keep` only goes from 1 to 0 within a scan). A megabyte of `sk-` with nothing kept scanned in 5.4 ms,
   * calling `emit` at every occurrence for nothing, and scans in 2.4 ms now (one byte per transition entry). A
   * generation, not a list reset after the loop: V8 compiles the loop on stack replacement before any code after it
   * has run, and code there without type feedback deoptimized the scan at the end of every call.
   */
  private readonly quiet: Uint8Array;
  /** 1 to 255; the next scan after 255 clears `quiet`. */
  private generation = 0;

  constructor(patterns: string[], options: MatcherOptions = {}) {
    this.wholeWord = options.wholeWord ?? false;
    this.patterns = patterns.map(foldPattern);
    this.lens = Int32Array.from(this.patterns, (p) => p.length);

    // Alphabet: one column per distinct character in the patterns, column 0 for everything else.
    let cols = 1;
    for (const p of this.patterns) {
      for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        if (c < 128) {
          if (this.asciiCol[c] === 0) this.asciiCol[c] = cols++;
        } else if (!this.otherCol.has(c)) {
          this.otherCol.set(c, cols++);
        }
      }
    }
    this.cols = cols;

    // Trie, as growable arrays of children per (state, column).
    const children: Int32Array[] = [new Int32Array(cols).fill(-1)];
    const own: number[][] = [[]];
    this.patterns.forEach((p, index) => {
      let s = 0;
      for (let i = 0; i < p.length; i++) {
        const col = this.column(p.charCodeAt(i));
        let next = children[s]![col]!;
        if (next < 0) {
          next = children.length;
          children.push(new Int32Array(cols).fill(-1));
          own.push([]);
          children[s]![col] = next;
        }
        s = next;
      }
      if (p.length > 0) own[s]!.push(index);
    });

    // BFS: failure links, full transition table, and output lists merged along failure links.
    const states = children.length;
    const delta = new Int32Array(states * cols);
    const fail = new Int32Array(states);
    const out: number[][] = own.map((list) => [...list]);
    const queue: number[] = [];
    for (let col = 0; col < cols; col++) {
      const child = children[0]![col]!;
      delta[col] = child < 0 ? 0 : child;
      if (child > 0) queue.push(child);
    }
    for (let head = 0; head < queue.length; head++) {
      const s = queue[head]!;
      out[s]!.push(...out[fail[s]!]!);
      for (let col = 0; col < cols; col++) {
        const child = children[s]![col]!;
        if (child < 0) {
          delta[s * cols + col] = delta[fail[s]! * cols + col]!;
        } else {
          fail[child] = delta[fail[s]! * cols + col]!;
          delta[s * cols + col] = child;
          queue.push(child);
        }
      }
    }
    this.outStart = new Int32Array(states + 1);
    for (let s = 0; s < states; s++) this.outStart[s + 1] = this.outStart[s]! + out[s]!.length;
    this.outList = Int32Array.from(out.flat());
    for (let k = 0; k < delta.length; k++) {
      const next = delta[k]!;
      delta[k] = ((next * cols) << 1) | (out[next]!.length > 0 ? 1 : 0);
    }
    this.delta = delta;
    for (let c = 0; c < 128; c++) this.foldCol[c] = this.asciiCol[FOLD[c]!]!;

    // Original offsets of the last few folded characters, to recover a match's start (folding drops marks).
    const longest = Math.max(1, ...this.lens);
    const size = 1 << Math.ceil(Math.log2(longest + 1));
    this.ring = new Int32Array(size);
    this.part = new Uint8Array(size);
    this.ringMask = size - 1;
    this.quiet = new Uint8Array(states * cols);
  }

  get stateCount(): number {
    return this.outStart.length - 1;
  }

  private column(f: number): number {
    return f < 128 ? this.asciiCol[f]! : (this.otherCol.get(f) ?? 0);
  }

  /** Calls `onMatch` for every occurrence of every pattern, in order of match end. */
  forEach(text: string, onMatch: OnMatch): void {
    this.run(text, onMatch, null);
  }

  /** True if any pattern occurs. Stops at the first match. */
  any(text: string): boolean {
    let found = false;
    this.run(text, null, () => {
      found = true;
      return true;
    });
    return found;
  }

  /**
   * Sets `hits[p] = 1` for each pattern `p` that occurs and returns how many distinct patterns did. `hits` must have
   * `patterns.length` entries and start zeroed. For prefilters: which rules' keywords are present.
   */
  markHits(text: string, hits: Uint8Array): number {
    let distinct = 0;
    this.run(
      text,
      (p) => {
        if (hits[p] === 0) {
          hits[p] = 1;
          distinct++;
        }
      },
      null,
    );
    return distinct;
  }

  /**
   * `markHits`, also writing each pattern that occurs to `firsts` (in order of first match; `patterns.length`
   * entries, so a caller can reset `hits` by them), and passing every occurrence of a pattern `p` with
   * `keep[p] === 1` to `sink.add(p, start)`, in order of match end, with the start `forEach` reports. The sink may
   * clear `keep` entries during the scan (never set them). One pass; an
   * ASCII character costs one table load (for a prefilter that also wants to know where some of its words are). Not
   * for a `wholeWord` matcher (it throws).
   */
  scan(text: string, hits: Uint8Array, firsts: Int32Array, keep: Uint8Array, sink: MatchSink): number {
    if (this.wholeWord) throw new Error("scan does not support wholeWord");
    if (this.generation === 255) {
      this.quiet.fill(0);
      this.generation = 0;
    }
    const generation = ++this.generation;
    const quiet = this.quiet;
    const packed = this.delta;
    const foldCol = this.foldCol;
    const asciiCol = this.asciiCol;
    const cols = this.cols;
    const n = text.length;
    let distinct = 0;
    let s = 0; // the state times cols
    // The last index whose character did not fold to exactly one (a mark dropped, a ligature expanded): a match whose
    // characters all come after it starts `length - 1` characters before its last.
    let special = -1;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      let d: number;
      if (c < 128) {
        d = packed[s + foldCol[c]!]!;
        s = d >> 1;
        if ((d & 1) !== 0 && quiet[s] !== generation)
          distinct = this.emit(s / cols, i, 0, special, text, hits, firsts, distinct, keep, sink);
        continue;
      }
      const f = foldOf(c);
      if (f === FOLD_DROP) {
        special = i;
        continue;
      }
      if (f !== FOLD_EXPAND) {
        d = packed[s + this.column(f)]!;
        s = d >> 1;
        if ((d & 1) !== 0 && quiet[s] !== generation)
          distinct = this.emit(s / cols, i, 0, special, text, hits, firsts, distinct, keep, sink);
        continue;
      }
      special = i;
      const expanded = expansionOf(c);
      for (let u = 0; u < expanded.length; u++) {
        const e = expanded.charCodeAt(u);
        d = packed[s + (e < 128 ? asciiCol[e]! : this.column(e))]!;
        s = d >> 1;
        if ((d & 1) !== 0 && quiet[s] !== generation)
          distinct = this.emit(s / cols, i, u, special, text, hits, firsts, distinct, keep, sink);
      }
    }
    return distinct;
  }

  /**
   * The patterns ending in `state` at character `i` (unit `u` of its expansion): hits and `firsts` (returns the count
   * of distinct patterns so far, `distinct` before), and starts for `keep`.
   */
  private emit(
    state: number,
    i: number,
    u: number,
    special: number,
    text: string,
    hits: Uint8Array,
    firsts: Int32Array,
    distinct: number,
    keep: Uint8Array,
    sink: MatchSink,
  ): number {
    const to = this.outStart[state + 1]!;
    let kept = false;
    for (let j = this.outStart[state]!; j < to; j++) {
      const p = this.outList[j]!;
      if (hits[p] === 0) {
        hits[p] = 1;
        firsts[distinct++] = p;
      }
      if (keep[p] !== 1) continue;
      kept = true;
      const len = this.lens[p]!;
      sink.add(p, i - len >= special ? i - len + 1 : startOf(text, i, u, len));
    }
    if (!kept) {
      this.quiet[state * this.cols] = this.generation;
    }
    return distinct;
  }

  private run(text: string, onMatch: OnMatch | null, stop: (() => boolean) | null): void {
    const n = text.length;
    const delta = this.delta;
    const cols = this.cols;
    const asciiCol = this.asciiCol;
    const outStart = this.outStart;
    const ring = this.ring;
    const part = this.part;
    const ringMask = this.ringMask;
    const wholeWord = this.wholeWord;
    let s = 0;
    let k = 0; // folded characters consumed
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      let col: number;
      // A character that folds to several (a ligature: "ﬁ" is "fi") is fed as its expansion, as the tokenizer and
      // foldPattern read it; every expanded character starts at the ligature's index.
      let expanded: string | null = null;
      if (c < 128) {
        col = asciiCol[FOLD[c]!]!;
      } else {
        const f = foldOf(c);
        if (f === FOLD_DROP) continue;
        if (f === FOLD_EXPAND) {
          expanded = expansionOf(c);
          if (expanded.length === 0) continue;
          col = this.column(expanded.charCodeAt(0));
        } else col = this.column(f);
      }
      for (let u = 0; ;) {
        ring[k & ringMask] = i;
        part[k & ringMask] = u;
        k++;
        const d = delta[s + col]!;
        s = d >> 1; // the next state's row
        const out = (d & 1) !== 0;
        const from = out ? outStart[s / cols]! : 0;
        const to = out ? outStart[s / cols + 1]! : 0;
        for (let j = from; j < to; j++) {
          const p = this.outList[j]!;
          const slot = (k - this.lens[p]!) & ringMask;
          const start = ring[slot]!;
          const end = afterMarks(text, i + 1);
          if (wholeWord) {
            // Inside a ligature is inside a word: a whole-word match must start on an expansion's first letter and
            // end on its last ("ile" is not a word in "ﬁle", nor "f" in "ﬁ").
            if (part[slot] !== 0 || (expanded !== null && u !== expanded.length - 1)) continue;
            if (!(boundaryBefore(text, start) && boundaryAt(text, end))) continue;
          }
          if (stop !== null && stop()) return;
          if (onMatch !== null) onMatch(p, start, end);
        }
        if (expanded === null || ++u >= expanded.length) break;
        const e = expanded.charCodeAt(u);
        col = e < 128 ? asciiCol[e]! : this.column(e);
      }
    }
  }
}

/**
 * What a character that folds to several (`FOLD_EXPAND`, a ligature) folds to, worked out once per code unit: made
 * afresh (`normalize` and a new string a character), a text of ligatures cost about 0.4 µs a character to match.
 */
function expansionOf(c: number): string {
  const k = EXPANSION_AT[c]!;
  if (k !== 0) return EXPANSIONS[k]!;
  const expanded = foldString(String.fromCharCode(c));
  EXPANSION_AT[c] = EXPANSIONS.length;
  EXPANSIONS.push(expanded);
  return expanded;
}
/**
 * `expansionOf`'s answers: per code unit, its place in `EXPANSIONS` (0: not yet known), at most one per code unit
 * that expands (a few thousand in Unicode). A typed index, not a Map: V8 read the Map at 20 ns a ligature, twice
 * JavaScriptCore's time, and an array indexed by code unit fell into V8's slow dictionary mode (D1850).
 */
const EXPANSION_AT = new Uint16Array(65_536);
const EXPANSIONS: string[] = [""];

/**
 * Where a match of `len` folded characters ending at unit `u` of character `i` starts, as `run`'s ring of offsets
 * records it: counted back over what each character folds to (a mark to nothing, a ligature to its expansion).
 */
function startOf(text: string, i: number, u: number, len: number): number {
  let need = len - (u + 1);
  let at = i;
  while (need > 0 && at > 0) {
    at--;
    const c = text.charCodeAt(at);
    const f = c < 128 ? FOLD[c]! : foldOf(c);
    if (f === FOLD_DROP) continue;
    need -= f === FOLD_EXPAND ? expansionOf(c).length : 1;
  }
  return at;
}

const isDropped = (c: number) => c >= 128 && foldOf(c) === FOLD_DROP && (classOf(c) & WORD_START) === 0;
const isWordStart = (c: number) => ((c < 128 ? CLASS[c]! : classOf(c)) & WORD_START) !== 0;

/** The first index at or after `at` that is not a combining mark (marks belong to the letter before them). */
function afterMarks(text: string, at: number): number {
  while (at < text.length && isDropped(text.charCodeAt(at))) at++;
  return at;
}

/** True if no letter or digit sits at `at` (the end of the text counts as a boundary). */
function boundaryAt(text: string, at: number): boolean {
  return at >= text.length || !isWordStart(text.charCodeAt(at));
}

/** True if no letter or digit precedes `start`, skipping combining marks (which belong to a letter). */
function boundaryBefore(text: string, start: number): boolean {
  let at = start - 1;
  while (at >= 0 && isDropped(text.charCodeAt(at))) at--;
  return at < 0 || !isWordStart(text.charCodeAt(at));
}

/** A pattern folded as the scanner folds text: per character, dropping marks; ligatures expanded. */
function foldPattern(p: string): string {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    const f = c < 128 ? FOLD[c]! : foldOf(c);
    if (f === FOLD_DROP) continue;
    if (f === FOLD_EXPAND) return foldPattern(foldString(p));
    out += String.fromCharCode(f);
  }
  return out;
}
