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
import { parseRegex, type Ranges, type RegexNode } from "./automaton.ts";
import { freshRuns, GENERIC_REST_SOURCE, genericRest } from "./generic-rest.ts";

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
  return anchorsOf(goPatternOfRegex(regex));
}

/** One of the gate's JavaScript regexes in Go's syntax, its lookarounds dropped: what `anchorsOfRegex` analyses. */
export function goPatternOfRegex(regex: RegExp): string {
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
  return (regex.flags.includes("i") ? "(?i)" : "") + source;
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
    const known = tables?.anchors[goPattern];
    anchors = known !== undefined ? known && known.map(anchorFromData) : (analyse(goPattern) ?? null);
    ANCHORS.set(goPattern, anchors);
  }
  return anchors ?? undefined;
}

/** Each pattern's anchors (null: none), so rule sets built again (tests, benchmarks) parse nothing again. */
const ANCHORS = new Map<string, Anchor[] | null>();

/** An anchor as `rules.generated.json` stores it: the prefix class as 32 hex digits (bit c for code unit c). */
export interface AnchorData {
  literals: string[];
  maxPrefix: number;
  prefix: string;
  wide: boolean;
}

/** A lazy-prefix regex (`lazyPrefixOf`) as `rules.generated.json` stores it. */
export interface LazyData {
  rest: string;
  other: string | null;
  flags: string;
  max: number;
  words: string[];
}

/**
 * The analyses of every regex the gate ships, worked out ahead (`generate.ts` writes them into
 * `rules.generated.json`, and `generated.test.ts` fails when they differ from what the code below works out now):
 * per pattern, its anchors (null: none) and, for a lazy-prefix candidate, its form (null: not one). Parsing every
 * rule's regex at the first call cost about 20-40 ms.
 */
export interface Analyses {
  anchors: Record<string, AnchorData[] | null>;
  lazy: Record<string, LazyData | null>;
}
let tables: Analyses | undefined;

/** Makes `anchorsOf` and `lazyPrefixOf` read a pattern's analysis from `analyses` when it holds one. */
export function useAnalyses(analyses: Analyses): void {
  tables = analyses;
}

/** The anchors of a pattern, worked out now (never from the tables): what `generate.ts` stores. */
export function analyseAnchors(goPattern: string): AnchorData[] | null {
  return analyse(goPattern)?.map(anchorToData) ?? null;
}

function anchorToData(anchor: Anchor): AnchorData {
  let prefix = "";
  for (let c = 0; c < 128; c += 4) {
    prefix += (
      anchor.prefix[c]! |
      (anchor.prefix[c + 1]! << 1) |
      (anchor.prefix[c + 2]! << 2) |
      (anchor.prefix[c + 3]! << 3)
    ).toString(16);
  }
  return { literals: anchor.literals, maxPrefix: anchor.maxPrefix, prefix, wide: anchor.wide };
}

function anchorFromData(data: AnchorData): Anchor {
  const prefix = new Uint8Array(128);
  for (let c = 0; c < 128; c++) prefix[c] = (parseInt(data.prefix[c >> 2]!, 16) >> (c & 3)) & 1;
  return { literals: data.literals, maxPrefix: data.maxPrefix, prefix: interned(prefix), wide: data.wide };
}

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
  /**
   * The most code units a node can match, its characters joining the prefix class; undefined when unbounded. A
   * group, an alternation or a repetition of either counts as its longest way through (`(?:https?://)?` is at most 8
   * characters from `[htps:/]`, `(?:^|[\s=:])` at most one), so every match's characters before the literal are
   * still in the class and at most `maxPrefix` of them.
   */
  const bounded = (node: RegexNode): number | undefined => {
    switch (node.t) {
      case "set":
        return addSet(node.ranges);
      case "assert":
      case "empty":
        return 0;
      case "rep": {
        const one = node.max < 0 ? undefined : bounded(node.x);
        return one === undefined ? undefined : one * node.max;
      }
      case "cat":
      case "alt": {
        let total = 0;
        for (const x of node.xs) {
          const n = bounded(x);
          if (n === undefined) return undefined;
          total = node.t === "cat" ? total + n : Math.max(total, n);
        }
        return total;
      }
    }
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.t === "assert" || part.t === "empty") continue;
    // A literal, or an alternation whose every branch starts with one: those literals.
    const literals = leadingLiterals(parts.slice(i));
    if (literals) return { literals: [...new Set(literals)], maxPrefix, prefix: interned(prefix), wide };
    // Otherwise the part must be of bounded length over a known class, and joins the prefix.
    const n = bounded(part);
    if (n === undefined) return undefined;
    maxPrefix += n;
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
   * Per literal id, its occurrences in the text, up to `cap` + 1. Past `cap` (`denseLimit` of the text) a literal's
   * occurrences are no longer kept, nor counted: every rule anchored on it would have more candidates than that, so it
   * scans the text instead (`anchoredMatches` checks the counts first), and the literal leaves `keep` until the next
   * text, so the matcher stops reporting it. This bounds the lists' memory and the work spent on a text dense in one
   * literal before it falls back.
   */
  count: Int32Array;
  /**
   * The `keep` argument of `MultiMatcher.scan`: per literal id, 1 while its occurrences are wanted (the literals some
   * rule anchors on, less those past `cap` in this text).
   */
  readonly keep: Uint8Array;
  private readonly wanted: Uint8Array;
  /** The literals taken out of `keep` in this text, to put back. */
  private full: number[] = [];
  private cap = Number.MAX_SAFE_INTEGER; // until the first `clear` names a length
  /**
   * D1850: per literal id, 1 when only lazy-prefix rules anchor on it. Those find a literal's occurrences themselves
   * once its list is incomplete, by a scan of every character, so for them a listed occurrence stays the cheaper way
   * to a denser text than for a sticky try: their lists stop at 1/32 of the text (`capLazy`), the others' at the dense
   * limit (1/128). At 1/128 a megabyte of `${"a".repeat(49)}key ` took 28 ms of CPU against 15 ms at 1/32.
   */
  lazyOnly: Uint8Array;
  private capLazy = Number.MAX_SAFE_INTEGER;
  next = new Int32Array(64);
  start = new Int32Array(64);
  size = 0;

  /** For `literals` ids, of which `keep` (default: all) are the ones whose occurrences are wanted. */
  constructor(literals: number, keep?: Uint8Array) {
    this.head = new Int32Array(literals).fill(-1);
    this.tail = new Int32Array(literals).fill(-1);
    this.count = new Int32Array(literals);
    this.wanted = keep ? Uint8Array.from(keep) : new Uint8Array(literals).fill(1);
    this.keep = Uint8Array.from(this.wanted);
    this.lazyOnly = new Uint8Array(literals);
  }

  /** Empties the lists for a text of `length` code units. */
  clear(length: number): void {
    this.cap = denseLimit(length);
    this.capLazy = Math.floor(length / 32) + 64;
    if (this.size === 0 && !this.counted) return;
    this.counted = false;
    this.head.fill(-1);
    this.tail.fill(-1);
    this.count.fill(0);
    this.size = 0;
    for (const literal of this.full) this.keep[literal] = this.wanted[literal]!;
    this.full.length = 0;
    // A text dense in literals (a megabyte of `key=`) grew the lists; the next text starts small again, so a gate
    // does not keep megabytes for the rest of the process.
    if (this.start.length > SCRATCH_KEPT) {
      this.next = new Int32Array(64);
      this.start = new Int32Array(64);
    }
  }

  /** Whether any occurrence was counted since the last `clear`. */
  private counted = false;

  /** Whether every occurrence of `literal` is in its list (none was only counted). */
  complete(literal: number): boolean {
    return this.count[literal]! <= (this.lazyOnly[literal] === 1 ? this.capLazy : this.cap);
  }

  add(literal: number, start: number): void {
    this.counted = true;
    if (++this.count[literal]! > (this.lazyOnly[literal] === 1 ? this.capLazy : this.cap)) {
      this.keep[literal] = 0;
      this.full.push(literal);
      return;
    }
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

/**
 * Scratch longer than this (entries) is let go after the text that grew it. D1850: 131,072, not 16,384: a megabyte
 * dense in one literal regrew the lists from 64 entries on every call; the lists kept are at most 1 MB.
 */
const SCRATCH_KEPT = 1 << 17;

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
 * result is the same; this bounds the cost on crafted input. D1850: 1/128, not 1/32: keeping 32,000 occurrences a
 * megabyte of `sk-` cost more than its rules' scans saved, and a literal every 64 characters ran as fast either way.
 */
const DENSE = 1 / 128;

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

  private readonly source: RegExp;
  private readonly anchors: Anchor[];

  constructor(source: RegExp, anchors: Anchor[]) {
    this.source = source;
    this.anchors = anchors;
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

/**
 * The keyword-assignment rules (96 of gitleaks'), `(?i)[\w.-]{0,50}?REST` where every match of REST starts with one
 * of a few literals (the rule's keywords): the lazy prefix is the engine's cost. From each start the engine tries
 * the prefix's 0 to 50 characters in turn and REST after each, so a text dense in keywords (`tokentoken…`, 1 µs a
 * character) or in prefix characters before them cost it about 50 REST attempts a position, and the anchored tries
 * could not help: every position near a keyword is a candidate start.
 *
 * So the prefix is read by hand and REST alone runs, sticky, once at each keyword occurrence k. From a start s the
 * engine tries k = s, s + 1, … while `[s, k)` is prefix characters and k − s ≤ 50, and the first k where REST
 * matches gives the match, `[s, REST's end from k)`; REST's match from k depends on k alone (it reads the text before
 * k only through lookbehind or `\b`, the same text either way). The starts that reach k are an interval, from
 * start(k) (the least s ≥ the scan's position with `[s, k)` all prefix characters and k − s ≤ 50) to k. So the
 * leftmost match starts at s* = the least start(k) over the occurrences k where REST matches, and its k is the least
 * such k with start(k) = s* (from s* every smaller REST match is out of reach, or it would give a smaller start).
 * Matches go on from each one's end, as `matchAll` does. Since start(k) ≥ k − 50, the search for s* stops 50 past
 * the best start so far; an occurrence is looked at again only within that window, its REST result kept.
 *
 * Linear: one sticky REST attempt an occurrence (REST's own work is bounded: a keyword, `[ \t\w.-]{0,20}`,
 * `[\s'"]{0,3}`, an operator, then the secret), a walk of at most 50 characters back from each that matches, and
 * one sort of the prefilter's lists (or one search for the occurrences, as they are needed).
 */
export class LazyPrefixRegex {
  /** REST's literals, distinct: the words whose occurrences `each` wants. */
  readonly words: string[];
  private readonly restSource: string;
  private readonly flags: string;
  private readonly max: number;
  /** Per ASCII code unit, 1 when JavaScript's prefix class takes it; it takes none outside ASCII (anchor tests). */
  private readonly prefix: Uint8Array;
  private rest: RegExp | undefined;
  private finder: ((text: string, from: number) => number) | undefined;
  /** The regex's later top-level branches, joined (atlassian-api-token's `|\b(ATATT3…)`), when it has any. */
  private readonly otherSource: string | undefined;
  private other: RegExp | undefined;

  constructor(
    restSource: string,
    otherSource: string | undefined,
    flags: string,
    max: number,
    prefix: Uint8Array,
    words: string[],
  ) {
    this.restSource = restSource;
    this.otherSource = otherSource;
    this.flags = flags.replace(/[dgy]/g, "");
    this.max = max;
    this.prefix = prefix;
    this.words = words;
  }

  /**
   * Calls `onMatch` with each match `matchAll` would report for the whole regex, in order. `found` holds the text's
   * occurrences of `words` (`ids[i]` the id of `words[i]`); without them, or when a literal's list is incomplete (a
   * text dense in it), the occurrences are found here as the scan needs them, so the scratch holds only a window of
   * them however dense the text (a list of every occurrence of `api` in 16 MB of `apiapi…` held 140 MB at its peak).
   */
  each(
    text: string,
    found: Occurrences | undefined,
    ids: Int32Array | undefined,
    onMatch: (start: number, end: number) => void,
  ): void {
    const listed = found !== undefined && ids !== undefined && allKept(found, ids);
    /** Occurrences in the window, `[i, n)` of `candidates` (and REST's end at each in `ends`). */
    let n = listed ? this.listed(found!, ids!) : 0;
    const other = this.otherSource === undefined ? undefined : (this.other ?? this.compile().other!);
    if (listed && n === 0 && !other) return;
    const rest = this.rest ?? this.compile().rest;
    // REST read by hand, for the one rule that has such a reader (generic-rest.ts), with its run cache for this text.
    const hand = this.restSource === GENERIC_REST_SOURCE ? genericRest : undefined;
    const runs = freshRuns();
    if (ends.length < candidates.length) ends = new Int32Array(candidates.length);
    ends.fill(UNKNOWN, 0, n);
    // Every start of a literal, overlapping ones included (case folded: a superset of where REST can start), one at a
    // time: an empty match before each, so nothing is allocated per occurrence.
    const finder = listed ? undefined : (this.finder ??= this.compileFinder());
    /** Where the next search for an occurrence starts; past the end once every occurrence is in. */
    let scanned = listed ? text.length + 1 : 0;
    const max = this.max;
    const prefix = this.prefix;
    let from = 0;
    let i = 0;
    /**
     * Appends the next occurrence to the window, first moving the window to the front when the scratch is full and
     * its head is spent. Returns how far the entries moved, or -1 when there is no occurrence left.
     */
    const more = (): number => {
      if (scanned > text.length) return -1;
      const k = finder!(text, scanned);
      if (k < 0) {
        scanned = text.length + 1;
        return -1;
      }
      scanned = k + 1;
      let shift = 0;
      if (n === candidates.length) {
        if (i > 0) {
          candidates.copyWithin(0, i, n);
          ends.copyWithin(0, i, n);
          shift = i;
          n -= i;
          i = 0;
        } else {
          candidates = grow(candidates);
          ends = grow(ends);
        }
      }
      candidates[n] = k;
      ends[n] = UNKNOWN;
      n++;
      return shift;
    };
    /** The lazy branch's leftmost match at or after `from` (-1: none at all), valid while `from` ≤ `best`. */
    let best = -1;
    let bestEnd = -1;
    let lazyDone = false;
    /** The other branches' leftmost match at or after `from` (-1: none), valid while `from` ≤ its start. */
    let otherStart = -2;
    let otherEnd = -1;
    for (;;) {
      if (!lazyDone && (best < 0 || from > best)) {
        // Raising `from` up to `best` keeps `best` the least start (no start moves below it), so it is found again
        // only once a match has passed it.
        best = -1;
        while (i < n && candidates[i]! < from) i++;
        for (let j = i; ; j++) {
          if (j === n) {
            const shift = more();
            if (shift < 0) break;
            j -= shift;
          }
          const k = candidates[j]!;
          if (k < from) {
            i = j + 1;
            continue;
          }
          if (best >= 0 && k > best + max) break;
          let end = ends[j]!;
          if (end === UNKNOWN) {
            if (hand) end = hand(text, k, runs);
            else {
              rest.lastIndex = k;
              end = rest.test(text) ? rest.lastIndex : -1;
            }
            ends[j] = end;
          }
          if (end < 0) {
            // Before any match of this round, an occurrence without one is never needed again: the next round
            // starts past the match this one finds, which ends past it.
            if (best < 0) i = j + 1;
            continue;
          }
          let s = k;
          const floor = Math.max(from, k - max);
          while (s > floor) {
            const c = text.charCodeAt(s - 1);
            if (c >= 128 || prefix[c] === 0) break;
            s--;
          }
          if (best < 0 || s < best) {
            best = s;
            bestEnd = end;
          }
        }
        lazyDone = best < 0;
      }
      if (other && otherStart !== -1 && from > otherStart) {
        // A global scan from `from`: the other branches' leftmost match there (they hold no lazy prefix).
        other.lastIndex = from;
        const m = other.exec(text);
        otherStart = m ? m.index : -1;
        otherEnd = m ? m.index + m[0].length : -1;
      }
      // At one start the engine tries the first branch first.
      if (!lazyDone && (otherStart < 0 || best <= otherStart)) {
        onMatch(best, bestEnd);
        // REST holds a literal, so a match is never empty and `from` moves on.
        from = bestEnd;
      } else if (otherStart >= 0) {
        onMatch(otherStart, otherEnd);
        from = otherEnd > otherStart ? otherEnd : otherStart + 1;
      } else break;
    }
    if (candidates.length > SCRATCH_KEPT) {
      candidates = new Int32Array(256);
      ends = new Int32Array(256);
    }
  }

  /**
   * Puts the occurrences the prefilter listed (every one of each literal: at most the dense limit) in `candidates`,
   * increasing and distinct; returns how many.
   */
  private listed(found: Occurrences, ids: Int32Array): number {
    let n = 0;
    let lists = 0;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      if (found.head[id]! >= 0) lists++;
      for (let e = found.head[id]!; e >= 0; e = found.next[e]!) {
        if (n === candidates.length) candidates = grow(candidates);
        candidates[n++] = found.start[e]!;
      }
    }
    if (lists > 1) candidates.subarray(0, n).sort();
    // Two literals can occur at one position (`key` and `keys`): keep each position once.
    let distinct = 0;
    for (let j = 0; j < n; j++) {
      if (j === 0 || candidates[j] !== candidates[j - 1]) candidates[distinct++] = candidates[j]!;
    }
    return distinct;
  }

  /**
   * The next start of a literal at or after `from` (overlapping ones included), ASCII case folded as the regex's `i`
   * folds it (no literal holds a character outside ASCII), or -1. By hand: a lookahead regex for the same cost 50 ms
   * a megabyte of `<add key=` (D1850).
   */
  private compileFinder(): (text: string, from: number) => number {
    const byFirst: string[][] = Array.from({ length: 128 }, () => []);
    for (const word of this.words) byFirst[word.charCodeAt(0)]!.push(word);
    /** Per ASCII code unit, 1 when some literal starts with it, either case. */
    const first = new Uint8Array(128);
    for (const word of this.words) {
      const c = word.charCodeAt(0);
      first[c] = 1;
      if (c >= 97 && c <= 122) first[c - 32] = 1;
    }
    return (text, from) => {
      const n = text.length;
      for (let i = from; i < n; i++) {
        let c = text.charCodeAt(i);
        if (c >= 128 || first[c] === 0) continue;
        if (c >= 65 && c <= 90) c += 32;
        const words = byFirst[c]!;
        next: for (const word of words) {
          if (i + word.length > n) continue;
          for (let j = 1; j < word.length; j++) {
            let d = text.charCodeAt(i + j);
            if (d >= 65 && d <= 90) d += 32;
            if (d !== word.charCodeAt(j)) continue next;
          }
          return i;
        }
      }
      return -1;
    };
  }

  /** Compiles REST (and the other branches) and runs them once, so the first text pays for neither (`warmGate`). */
  warm(): void {
    const { rest, other } = this.compile();
    rest.test("");
    other?.test("");
  }

  private compile(): { rest: RegExp; other: RegExp | undefined } {
    this.rest ??= new RegExp(this.restSource, this.flags + "y");
    if (this.otherSource !== undefined) this.other ??= new RegExp(this.otherSource, this.flags + "g");
    return { rest: this.rest, other: this.other };
  }
}

/**
 * A regex's top-level branches (its text split at each `|` outside a group or class), in Go's syntax or JavaScript's:
 * escapes, classes (a `]` first in one is literal, and Go's `[:name:]` sits inside one) and groups are skipped.
 */
export function topLevelBranches(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    if (char === "\\") {
      at++;
    } else if (char === "[") {
      at++;
      if (source[at] === "^") at++;
      if (source[at] === "]") at++;
      for (; at < source.length && source[at] !== "]"; at++) {
        if (source[at] === "\\") at++;
        else if (source.startsWith("[:", at)) at = source.indexOf(":]", at) + 1;
      }
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
    } else if (char === "|" && depth === 0) {
      out.push(source.slice(from, at));
      from = at + 1;
    }
  }
  out.push(source.slice(from));
  return out;
}

/** Whether `found` kept every occurrence of the literals `ids` names. */
function allKept(found: Occurrences, ids: Int32Array): boolean {
  for (let k = 0; k < ids.length; k++) if (!found.complete(ids[k]!)) return false;
  return true;
}

/** REST's result at each occurrence: not tried yet. */
const UNKNOWN = -2;
/** The lazy-prefix scan's scratch: occurrences, and REST's end at each (-1: no match). */
let candidates = new Int32Array(256);
let ends = new Int32Array(256);

/**
 * The lazy-prefix form of a gitleaks regex: undefined unless the regex's first top-level branch is
 * `[\w.-]{0,N}?REST` (under `(?i)` or not, no other flag) with every match of REST starting with one of its literals.
 * Later branches, if any, run as one regex of their own. `js` makes its JavaScript translation, called only when the
 * analysis is not in the tables.
 */
export function lazyPrefixOf(goPattern: string, js: () => RegExp): LazyPrefixRegex | undefined {
  const known = tables?.lazy[goPattern];
  const data = known !== undefined ? known : analyseLazy(goPattern, js());
  if (!data) return undefined;
  return new LazyPrefixRegex(data.rest, data.other ?? undefined, data.flags, data.max, JS_WORD_DOT_DASH, data.words);
}

/** `lazyPrefixOf`'s analysis, worked out now (never from the tables): what `generate.ts` stores. */
export function analyseLazy(goPattern: string, js: RegExp): LazyData | null {
  const go = /^(\(\?i\))?\[\\w\.-\]\{0,(\d+)\}\?/.exec(goPattern);
  const jsPrefix = /^\[\\w\.-\]\{0,(\d+)\}\?/.exec(js.source);
  if (!go || !jsPrefix || go[2] !== jsPrefix[1] || /[a-z]/.test(js.flags.replace(/[dgiy]/g, ""))) return null;
  const goBranches = topLevelBranches(goPattern.slice((go[1] ?? "").length));
  const jsBranches = topLevelBranches(js.source);
  let root: RegexNode;
  try {
    root = parseRegex(goPattern);
  } catch {
    return null;
  }
  // The two splits must agree with each other and with the parse, or the branches are not what they seem.
  if (goBranches.length !== jsBranches.length || goBranches.length !== (root.t === "alt" ? root.xs.length : 1)) {
    return null;
  }
  const anchors = analyse((go[1] ?? "") + goBranches[0]!.slice(go[0].length - (go[1] ?? "").length));
  if (!anchors || anchors.some((anchor) => anchor.maxPrefix !== 0)) return null;
  return {
    rest: jsBranches[0]!.slice(jsPrefix[0].length),
    other: jsBranches.length > 1 ? jsBranches.slice(1).join("|") : null,
    flags: js.flags.replace(/[dgy]/g, ""),
    max: Number(go[2]),
    words: [...new Set(anchors.flatMap((anchor) => anchor.literals))],
  };
}

/** `[\w.-]` in JavaScript without the `u` flag, case folded or not: ASCII letters, digits, `_`, `.` and `-`. */
const JS_WORD_DOT_DASH = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  if (/[\w.-]/.test(String.fromCharCode(c))) JS_WORD_DOT_DASH[c] = 1;
}
