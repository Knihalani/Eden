/**
 * Where a gitleaks rule's matches can start, read from its regex: every match holds one of a few literals (the
 * rule's own keyword alternation, `ghp_`, `ATATT3`…) within a bounded distance of its start, and the characters
 * before that literal come from a known class. So a match can only start a little before an occurrence of one of the
 * literals, and the gate tries the rule's JavaScript regex there alone (sticky, one start at a time) rather than at
 * every position of the text. Most of the gate's time went to the keyword-assignment rules
 * (`[\w.-]{0,50}?(?:KEYWORD)…`) trying their lazy prefix at every position of a text that merely holds the keyword
 * somewhere (`generic-api-key` on a 16 KB mail: about half of the whole gate).
 *
 * Exact by construction: a match found by a scan from position L starts at the least p ≥ L where the regex matches.
 * Every such p is a candidate (the literal the match holds is an occurrence the prefilter reports, case folded, and
 * the characters between p and it are in the prefix class), so trying the candidates ≥ L in order with the same regex
 * made sticky finds the same match. Lookbehind and `\b` still see the text before p, as a sticky match does.
 */
import { parseRegex, type Ranges, type RegexNode } from "./automaton";

/** One way a match can begin: up to `maxPrefix` characters of `prefix` (code units), then one of `literals`. */
export interface Anchor {
  /** Lower-case ASCII literals, each at least MIN_LITERAL characters. */
  literals: string[];
  maxPrefix: number;
  /** Per ASCII code unit, 1 when it may sit in the prefix; `wide` says whether any non-ASCII code unit may. */
  prefix: Uint8Array;
  wide: boolean;
}

/**
 * The anchors of one of the gate's own JavaScript regexes. Lookarounds are dropped first: they are zero-width, so
 * every match of the regex is a match of what is left, with the same span, and that one's anchors hold for both.
 * Undefined when what is left is outside the parser's subset or has no anchor.
 */
export function anchorsOfRegex(regex: RegExp): Anchor[] | undefined {
  const src = regex.source;
  let source = "";
  /** Open groups inside the lookaround being dropped (0: none being dropped). */
  let depth = 0;
  let inClass = false;
  for (let at = 0; at < src.length; at++) {
    const char = src[at]!;
    const kept = depth === 0;
    if (char === "\\") {
      // `source` spells characters outside ASCII `\uXXXX`, which RE2 spells `\x{XXXX}`.
      const unicode = /^u[0-9A-Fa-f]{4}/.test(src.slice(at + 1, at + 6));
      if (kept) source += unicode ? `\\x{${src.slice(at + 2, at + 6)}}` : char + (src[at + 1] ?? "");
      at += unicode ? 5 : 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
    } else if (kept && /^\(\?<?[=!]/.test(src.slice(at, at + 4))) {
      depth = 1;
      at += src[at + 2] === "<" ? 3 : 2;
      continue;
    } else if (!kept && char === "(") {
      depth++;
    } else if (!kept && char === ")") {
      depth--;
      continue;
    }
    if (kept) source += char;
  }
  return anchorsOf((regex.flags.includes("i") ? "(?i)" : "") + source);
}

/** A shorter literal occurs too often to be worth anchoring on. */
const MIN_LITERAL = 2;

/**
 * The anchors of a gitleaks regex, one or more per top-level alternative, or undefined when some alternative has no
 * bounded prefix before a literal (the rule then runs as it did, a scan of the whole text).
 */
export function anchorsOf(goPattern: string): Anchor[] | undefined {
  let anchors = ANCHORS.get(goPattern);
  if (anchors === undefined) {
    anchors = analyse(goPattern) ?? null;
    ANCHORS.set(goPattern, anchors);
  }
  return anchors ?? undefined;
}

/** Each pattern's anchors (null: none), so rule sets built again (tests, benchmarks) parse nothing again. */
const ANCHORS = new Map<string, Anchor[] | null>();

function analyse(goPattern: string): Anchor[] | undefined {
  let root: RegexNode;
  try {
    root = parseRegex(goPattern);
  } catch {
    return undefined;
  }
  const branches = root.t === "alt" ? root.xs : [root];
  const out: Anchor[] = [];
  for (const branch of branches) {
    const anchor = anchorOfBranch(flatten(branch));
    if (!anchor) return undefined;
    out.push(anchor);
  }
  return out;
}

/** A concatenation with its nested concatenations spliced in, so a group's parts sit at the top. */
function flatten(node: RegexNode): RegexNode[] {
  if (node.t !== "cat") return [node];
  return node.xs.flatMap(flatten);
}

/**
 * The ASCII letter or character a set stands for, folded to lower case, when its ASCII members are one character or
 * one letter in both cases; undefined otherwise. The only members outside ASCII allowed are U+017F beside `s` and
 * U+212A beside `k` (what `(?i)` adds): the prefilter folds them to `s` and `k`, so the literal's occurrences still
 * cover them (and JavaScript's engine, without the `u` flag, does not match them anyway).
 */
function charOf(node: RegexNode): number | undefined {
  if (node.t !== "set") return undefined;
  const ascii: number[] = [];
  const other: number[] = [];
  const r = node.ranges;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i + 1]! - r[i]! > 4) return undefined;
    for (let cp = r[i]!; cp <= r[i + 1]!; cp++) (cp < 128 ? ascii : other).push(cp);
  }
  let c: number | undefined;
  if (ascii.length === 1) c = lower(ascii[0]!);
  else if (ascii.length === 2 && (ascii[0]! | 0x20) === (ascii[1]! | 0x20) && isLetter(ascii[0]!)) c = lower(ascii[0]!);
  if (c === undefined) return undefined;
  // Any other member must fold to the same letter in the prefilter, or an occurrence spelled with it would be missed.
  for (const cp of other) if (!((cp === LONG_S && c === 115) || (cp === KELVIN && c === 107))) return undefined;
  return c;
}

const LONG_S = 0x17f;
const KELVIN = 0x212a;

const isLetter = (c: number) => (c | 0x20) >= 97 && (c | 0x20) <= 122;
const lower = (c: number) => (isLetter(c) ? c | 0x20 : c);

/** The literal a sequence of parts starts with (each part one character); empty when it starts with none. */
function leadingLiteral(parts: RegexNode[]): string {
  const codes: number[] = [];
  for (const part of parts) {
    const c = charOf(part);
    if (c === undefined) break;
    codes.push(c);
  }
  // One flat string, not a rope of one node a character: the anchors live as long as the gate.
  return String.fromCharCode(...codes);
}

/**
 * The literals one of which every text matching `parts` starts with: its leading literal, or, when it starts with an
 * alternation, those of each branch (nested alternations included). Undefined when one is shorter than MIN_LITERAL.
 */
function leadingLiterals(parts: RegexNode[]): string[] | undefined {
  const first = parts[0];
  if (first?.t === "alt") {
    const out: string[] = [];
    for (const branch of first.xs) {
      const literals = leadingLiterals(flatten(branch));
      if (!literals) return undefined;
      out.push(...literals);
    }
    return out;
  }
  const text = leadingLiteral(parts);
  return text.length >= MIN_LITERAL ? [text] : undefined;
}

/** Prefix classes by content: most rules share `[\w.-]`, so they share one table. */
const PREFIXES = new Map<string, Uint8Array>();
const interned = (prefix: Uint8Array): Uint8Array => {
  const key = prefix.join("");
  const known = PREFIXES.get(key);
  if (known) return known;
  PREFIXES.set(key, prefix);
  return prefix;
};

function anchorOfBranch(parts: RegexNode[]): Anchor | undefined {
  const prefix = new Uint8Array(128);
  let wide = false;
  let maxPrefix = 0;
  /** Adds a set to the prefix class; returns how many code units one of its characters takes at most. */
  const addSet = (ranges: Ranges): number => {
    for (let i = 0; i < ranges.length; i += 2) {
      for (let cp = ranges[i]!; cp <= Math.min(ranges[i + 1]!, 127); cp++) prefix[cp] = 1;
      if (ranges[i + 1]! > 127) wide = true;
    }
    // JavaScript (no `u` flag) reads code units: a class matches one, but a literal outside the BMP is two, and a
    // quantifier on it repeats its second. Two a repetition bounds both, as the parse cannot tell them apart.
    return ranges[ranges.length - 1]! > 0xffff ? 2 : 1;
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.t === "assert" || part.t === "empty") continue;
    // A literal, or an alternation whose every branch starts with one: those literals.
    const literals = leadingLiterals(parts.slice(i));
    if (literals) return { literals: [...new Set(literals)], maxPrefix, prefix: interned(prefix), wide };
    if (part.t === "alt") return undefined;
    // Otherwise the part must be of bounded length over a known class, and joins the prefix.
    if (part.t === "set") {
      maxPrefix += addSet(part.ranges);
    } else if (part.t === "rep" && part.x.t === "set" && part.max >= 0) {
      maxPrefix += addSet(part.x.ranges) * part.max;
    } else return undefined;
  }
  return undefined;
}

/**
 * Where the gate's literals occur in one text: per literal id, its starts in increasing order, as linked lists in
 * typed arrays reused from text to text (the gate is synchronous, so one instance per gate serves every call).
 */
export class Occurrences {
  /** Per literal id, the first and last entry of its list (-1: none). */
  head: Int32Array;
  private tail: Int32Array;
  /**
   * Per literal id, its occurrences in the text, kept or not. Past `cap` (`denseLimit` of the text) a literal's
   * occurrences are counted and no longer kept: every rule anchored on it would have more candidates than that, so it
   * scans the text instead (`anchoredMatches` checks the counts first). This bounds the lists' memory and the work
   * spent on a text dense in one literal before it falls back.
   */
  count: Int32Array;
  private cap = Number.MAX_SAFE_INTEGER; // until the first `clear` names a length
  next = new Int32Array(64);
  start = new Int32Array(64);
  size = 0;

  constructor(literals: number) {
    this.head = new Int32Array(literals).fill(-1);
    this.tail = new Int32Array(literals).fill(-1);
    this.count = new Int32Array(literals);
  }

  /** Empties the lists for a text of `length` code units. */
  clear(length: number): void {
    this.cap = denseLimit(length);
    if (this.size === 0 && !this.counted) return;
    this.counted = false;
    this.head.fill(-1);
    this.tail.fill(-1);
    this.count.fill(0);
    this.size = 0;
    // A text dense in literals (a megabyte of `key=`) grew the lists; the next text starts small again, so a gate
    // does not keep megabytes for the rest of the process.
    if (this.start.length > SCRATCH_KEPT) {
      this.next = new Int32Array(64);
      this.start = new Int32Array(64);
    }
  }

  /** Whether any occurrence was counted since the last `clear`. */
  private counted = false;

  add(literal: number, start: number): void {
    this.counted = true;
    if (++this.count[literal]! > this.cap) return;
    if (this.size === this.start.length) {
      const next = new Int32Array(this.size * 2);
      next.set(this.next);
      this.next = next;
      const starts = new Int32Array(this.size * 2);
      starts.set(this.start);
      this.start = starts;
    }
    const at = this.size++;
    this.start[at] = start;
    this.next[at] = -1;
    if (this.tail[literal]! < 0) this.head[literal] = at;
    else this.next[this.tail[literal]!] = at;
    this.tail[literal] = at;
  }
}

/** Scratch longer than this (entries) is let go after the text that grew it. */
const SCRATCH_KEPT = 16_384;

/**
 * Where to try a rule: per interval, its first and last candidate start (scratch shared by every rule: the sweep
 * below never runs inside another, as `onMatch` only reads the match).
 */
let lows = new Int32Array(256);
let highs = new Int32Array(256);
let order = new Int32Array(256);

/**
 * Past this share of the text in candidate starts, sticky tries cost more than the engine's own scan: a sticky try
 * costs about 20 scanned positions (a literal every 10 characters ran 2.9x slower than the scan at 1/8, 1.7x at 1/32
 * before the occurrence counts, review of 2026-11-14). The rule then scans the whole text, as before. Either way the
 * result is the same; this bounds the cost on crafted input.
 */
const DENSE = 1 / 32;

/** The most candidate starts a rule tries in a text of `length` code units before it scans instead. */
export const denseLimit = (length: number): number => Math.floor(length * DENSE) + 64;

/**
 * Calls `onMatch` with every match of `sticky`'s regex in `text`, leftmost-first and non-overlapping as `matchAll`
 * with the regex made global reports them, in order, found by trying `sticky` (the regex, sticky) only where
 * `anchors` say a match can start. `ids[a][l]` is the id in `found` of anchor a's literal l. Returns false, having
 * called nothing, when the candidates are dense: the caller then scans the whole text.
 */
export function anchoredMatches(
  text: string,
  sticky: RegExp,
  anchors: Anchor[],
  ids: number[][],
  found: Occurrences,
  onMatch: (match: RegExpExecArray) => void,
): boolean {
  let n = 0;
  let total = 0;
  const limit = denseLimit(text.length);
  // Each occurrence is at least one candidate: past the limit in occurrences alone, scan without walking any.
  for (const literals of ids) for (const id of literals) total += found.count[id]!;
  if (total > limit) return false;
  total = 0;
  for (let a = 0; a < anchors.length; a++) {
    const anchor = anchors[a]!;
    const prefix = anchor.prefix;
    const wide = anchor.wide;
    const max = anchor.maxPrefix;
    for (const id of ids[a]!) {
      for (let e = found.head[id]!; e >= 0; e = found.next[e]!) {
        const q = found.start[e]!;
        let lo = q;
        const floor = q - max;
        while (lo > 0 && lo > floor) {
          const c = text.charCodeAt(lo - 1);
          if (c < 128 ? prefix[c] === 0 : !wide) break;
          lo--;
        }
        total += q - lo + 1;
        if (total > limit) return release(false);
        if (n === lows.length) {
          lows = grow(lows);
          highs = grow(highs);
          order = grow(order);
        }
        lows[n] = lo;
        highs[n] = q;
        order[n] = n;
        n++;
      }
    }
  }
  if (n === 0) return release(true);
  const byLow = order.subarray(0, n).sort((x, y) => lows[x]! - lows[y]! || x - y);
  let tried = 0;
  for (let k = 0; k < n; k++) {
    const i = byLow[k]!;
    let p = Math.max(lows[i]!, tried);
    const q = highs[i]!;
    while (p <= q) {
      sticky.lastIndex = p;
      const m = sticky.exec(text);
      if (m === null) {
        p++;
        continue;
      }
      onMatch(m);
      // On from the match's end, or one further after an empty match, as `matchAll` goes on.
      const end = p + m[0].length;
      p = end > p ? end : p + 1;
    }
    if (p > tried) tried = p;
  }
  return release(true);
}

/** Lets go of scratch a dense text grew (see SCRATCH_KEPT), and returns `result`. */
function release(result: boolean): boolean {
  if (lows.length > SCRATCH_KEPT) {
    lows = new Int32Array(256);
    highs = new Int32Array(256);
    order = new Int32Array(256);
  }
  return result;
}

function grow(array: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> {
  const next = new Int32Array(array.length * 2);
  next.set(array);
  return next;
}

/**
 * A regex tried only where its anchors allow, given a text's occurrences of its literals (`words`); without them, or
 * when candidates are dense, scanned as `matchAll` scans it. Either way `each` sees the same matches.
 */
export class AnchoredRegex {
  /** The anchors' literals, distinct: the words whose occurrences `each` wants. */
  readonly words: string[];
  private sticky: RegExp | undefined;
  private idsFor: Int32Array | undefined;
  private mapped: number[][] = [];

  constructor(
    private readonly source: RegExp,
    private readonly anchors: Anchor[],
  ) {
    this.words = [...new Set(anchors.flatMap((anchor) => anchor.literals))];
  }

  /**
   * Calls `onMatch` with each match `matchAll` would report for `source` made global, in order; `ids[i]` is the id in
   * `found` of `words[i]`. Returns false, having called nothing, without occurrences or when they are dense: the
   * caller then scans the text itself.
   */
  each(
    text: string,
    found: Occurrences | undefined,
    ids: Int32Array | undefined,
    onMatch: (match: RegExpExecArray) => void,
  ): boolean {
    if (!found || !ids) return false;
    if (ids !== this.idsFor) {
      this.mapped = this.anchors.map((anchor) => anchor.literals.map((literal) => ids[this.words.indexOf(literal)]!));
      this.idsFor = ids;
    }
    return anchoredMatches(text, this.sticky ?? this.compile(), this.anchors, this.mapped, found, onMatch);
  }

  /** Compiles the sticky regex and runs it once, so the first text does not pay for either (`warmGate`). */
  warm(): void {
    this.compile().exec("");
  }

  private compile(): RegExp {
    this.sticky ??= new RegExp(this.source.source, this.source.flags.replace("g", "") + "y");
    this.sticky.lastIndex = 0;
    return this.sticky;
  }
}
