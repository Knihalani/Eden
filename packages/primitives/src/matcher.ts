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
import { CLASS, classOf, FOLD, FOLD_DROP, FOLD_EXPAND, foldOf, foldString, WORD_START } from "./charclass";

export interface MatcherOptions {
  wholeWord?: boolean;
}

/** Called per match with the pattern's index and the match's [start, end) in the original text. */
export type OnMatch = (pattern: number, start: number, end: number) => void;

export class MultiMatcher {
  /** The patterns as folded, in the order given. */
  readonly patterns: string[];
  private readonly wholeWord: boolean;
  private readonly asciiCol = new Int32Array(128);
  private readonly otherCol = new Map<number, number>();
  private readonly cols: number;
  private readonly delta: Int32Array;
  /** CSR lists of the patterns ending at each state, own and inherited through suffix links. */
  private readonly outStart: Int32Array;
  private readonly outList: Int32Array;
  private readonly lens: Int32Array;
  private readonly ring: Int32Array;
  /** Per ring slot, its letter's place in a ligature's expansion (0 for an ordinary character). */
  private readonly part: Uint8Array;
  private readonly ringMask: number;

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
    this.delta = delta;
    this.outStart = new Int32Array(states + 1);
    for (let s = 0; s < states; s++) this.outStart[s + 1] = this.outStart[s]! + out[s]!.length;
    this.outList = Int32Array.from(out.flat());

    // Original offsets of the last few folded characters, to recover a match's start (folding drops marks).
    const longest = Math.max(1, ...this.lens);
    const size = 1 << Math.ceil(Math.log2(longest + 1));
    this.ring = new Int32Array(size);
    this.part = new Uint8Array(size);
    this.ringMask = size - 1;
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
          expanded = foldString(String.fromCharCode(c));
          if (expanded.length === 0) continue;
          col = this.column(expanded.charCodeAt(0));
        } else col = this.column(f);
      }
      for (let u = 0; ;) {
        ring[k & ringMask] = i;
        part[k & ringMask] = u;
        k++;
        s = delta[s * cols + col]!;
        const from = outStart[s]!;
        const to = outStart[s + 1]!;
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
