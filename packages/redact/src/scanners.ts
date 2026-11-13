/**
 * Hand-written matchers for the seven gitleaks rules whose regexes backtrack in JavaScript (D24, D1705). Each one
 * reports what RE2 reports for its rule's regex (as re2Source rewrites it): the same leftmost-first matches, the same
 * group spans. They are exact by construction, argued below from RE2's match order, and checked against re2js
 * (`differential.ts`). Each is linear in the text: every position is examined a bounded number of times, with memos
 * where two keyword or option positions could share work.
 *
 * Every scanner names the exact regex it implements; `secrets.ts` refuses to build the gate when the vendored rule's
 * regex differs, so a gitleaks update that changes one fails loudly instead of running the old matcher.
 */
import type { Pattern } from "./secrets";

type Span = [number, number];

/** JavaScript's `\s` (WhiteSpace and LineTerminator), the set re2Source gave RE2. */
export function isJsSpace(c: number): boolean {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  if (c < 0xa0) return false;
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** RE2's `\w` and word boundary: ASCII only. */
const isWord = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122);
const isAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** The two characters outside ASCII that `(?i)` folds onto ASCII letters: U+017F (s) and U+212A (k). */
const LONG_S = 0x17f;
const KELVIN = 0x212a;
const isFoldExtra = (c: number) => c === LONG_S || c === KELVIN;
/** `[A-Za-z]` under `(?i)`. */
const isFoldedLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isFoldExtra(c);
/** A character folded to lower-case ASCII, as `(?i)` compares it to a literal; others unchanged. */
const foldLower = (c: number) => (c >= 65 && c <= 90 ? c + 32 : c === LONG_S ? 115 : c === KELVIN ? 107 : c);

/** Whether `text` at `at` reads `word` (lower-case ASCII) under `(?i)`. */
function foldedAt(text: string, at: number, word: string): boolean {
  if (at + word.length > text.length) return false;
  for (let i = 0; i < word.length; i++) if (foldLower(text.charCodeAt(at + i)) !== word.charCodeAt(i)) return false;
  return true;
}

/** Whether `text` holds `word` at `at`: `startsWith` with an offset, which JavaScriptCore runs far slower. */
function wordAt(text: string, at: number, word: string): boolean {
  if (at + word.length > text.length) return false;
  for (let i = 0; i < word.length; i++) if (text.charCodeAt(at + i) !== word.charCodeAt(i)) return false;
  return true;
}

/** Whether `[from, to)` holds at least `n` code points (a surrogate pair is one, a lone surrogate one). */
function atLeastCodePoints(text: string, from: number, to: number, n: number): boolean {
  let count = 0;
  for (let i = from; i < to && count < n; count++) {
    const c = text.charCodeAt(i);
    const low = i + 1 < to ? text.charCodeAt(i + 1) : 0;
    i += c >= 0xd800 && c <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
  }
  return count >= n;
}

/** The length of the run of `is` characters at `at`, stopping at `cap` if given. */
function runOf(text: string, at: number, is: (c: number) => boolean, cap = Infinity): number {
  let end = at;
  while (end < text.length && end - at < cap && is(text.charCodeAt(end))) end++;
  return end - at;
}

/** A match: its span and its groups' spans (index 0 unused, `undefined` for a group that took no part). */
interface Found {
  start: number;
  end: number;
  groups: (Span | undefined)[];
}

/** A Pattern from a scan that finds every match (or only the first), leftmost-first and non-overlapping. */
function patternOf(scan: (text: string, first: boolean) => Found[]): Pattern {
  return {
    test: (text) => scan(text, true).length > 0,
    matches: (text) => scan(text, false).map((found): Span => [found.start, found.end]),
    groups(text) {
      const found = scan(text, true)[0];
      return found ? [[found.start, found.end], ...found.groups.slice(1)] : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The keyword-assignment rules: `[\w.-]{0,50}?(?i:[\w.-]{0,50}?KW(?:[ \t\w.-]{0,20})[\s'"]{0,3})OP[\x60'"\s=]{0,5}
// (SECRET)(?:[\x60'"\s;]|\\[nr]|$)`, with OP = `(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)`.
//
// RE2 returns the leftmost match, and from that start the first in backtracking order. Split the regex at the
// keyword position k. What follows k (the suffix) depends on k alone, so call its first match from k suffix(k).
// Before k, the two lazy runs (L1 = `[\w.-]{0,50}?`, ASCII; L2 = the same class under (?i), which adds U+017F and
// U+212A) try lengths (0,0), (0,1) … (0,50), (1,0) … in turn, so from a start s the keyword positions are tried in
// increasing order, each once: the first k with a suffix match wins. A start s can reach k exactly when k − s ≤ 100,
// `[s, k)` is all folded-class characters, and no U+017F or U+212A lies in `[s, k − 50)` (those only L2 takes, and
// L2 is the last 50 at most). The least such s is start(k), and every s from start(k) to k reaches k too. So the
// match starts at s* = min over k (with a suffix match) of start(k), and its keyword is the least k with start(k) = s*.
// start(k) ≥ k − 100, so the search for s* stops at the first k past s* + 100.
// ---------------------------------------------------------------------------------------------------------------

// The classes these rules test, one bit each, looked up in a table for ASCII (the hot loops read every character).
const RUN = 1; // `[\w.-]` (L1)
const RUN_FOLDED = 2; // `[\w.-]` under (?i) (L2)
const AFTER_KEYWORD = 4; // `[ \t\w.-]` under (?i)
const QUOTE_SPACE = 8; // `[\s'"]`
const BEFORE_SECRET = 16; // `[\x60'"\s=]`
const AFTER_SECRET = 32; // `[\x60'"\s;]`
const ASCII_BITS = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const run = isWord(c) || c === 46 || c === 45;
  const space = isJsSpace(c);
  ASCII_BITS[c] =
    (run ? RUN | RUN_FOLDED | AFTER_KEYWORD : 0) |
    (c === 32 || c === 9 ? AFTER_KEYWORD : 0) |
    (c === 39 || c === 34 || space ? QUOTE_SPACE : 0) |
    (c === 96 || c === 39 || c === 34 || c === 61 || space ? BEFORE_SECRET : 0) |
    (c === 96 || c === 39 || c === 34 || c === 59 || space ? AFTER_SECRET : 0);
}
const bitsOf = (c: number): number =>
  c < 128
    ? ASCII_BITS[c]!
    : isFoldExtra(c)
      ? RUN_FOLDED | AFTER_KEYWORD
      : isJsSpace(c)
        ? QUOTE_SPACE | BEFORE_SECRET | AFTER_SECRET
        : 0;
const isRunAscii = (c: number) => (bitsOf(c) & RUN) !== 0;
const isRunFolded = (c: number) => (bitsOf(c) & RUN_FOLDED) !== 0;
const isAfterKeyword = (c: number) => (bitsOf(c) & AFTER_KEYWORD) !== 0;
const isQuoteOrSpace = (c: number) => (bitsOf(c) & QUOTE_SPACE) !== 0;
const isBeforeSecret = (c: number) => (bitsOf(c) & BEFORE_SECRET) !== 0;
const isAfterSecret = (c: number) => (bitsOf(c) & AFTER_SECRET) !== 0;

interface AssignmentRule {
  id: string;
  regex: string;
  /** Finds each keyword occurrence's end (a literal alternation: no backtracking). */
  keyword: RegExp;
  /** The lengths a keyword can have, longest first. */
  keywordLengths: number[];
  /** The secret group's length when it matches at `at`, else -1 (each rule's secret has a fixed length). */
  secret(text: string, at: number): number;
}

const fixed =
  (length: number, is: (c: number) => boolean, prefix = "") =>
  (text: string, at: number) => {
    if (at + length > text.length || !wordAt(text, at, prefix)) return -1;
    for (let i = at + prefix.length; i < at + length; i++) if (!is(text.charCodeAt(i))) return -1;
    return length;
  };
/** `[\w=\-]`. */
const isOktaChar = (c: number) => isWord(c) || c === 61 || c === 45;
const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 97 && c <= 102);
const isLowerAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 97 && c <= 122);

const ASSIGNMENT_RULES: AssignmentRule[] = [
  {
    id: "cisco-meraki-api-key",
    regex: String.raw`[\w.-]{0,50}?(?i:[\w.-]{0,50}?(?:(?-i:[Mm]eraki|MERAKI))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-f]{40})(?:[\x60'"\s;]|\\[nr]|$)`,
    keyword: /[Mm]eraki|MERAKI/g,
    keywordLengths: [6],
    secret: fixed(40, isHex),
  },
  {
    id: "cohere-api-token",
    regex: String.raw`[\w.-]{0,50}?(?i:[\w.-]{0,50}?(?:cohere|CO_API_KEY)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-zA-Z0-9]{40})(?:[\x60'"\s;]|\\[nr]|$)`,
    // `iu`: JavaScript then folds by Unicode simple case folding, as RE2's (?i) does (U+212A matches `k`).
    keyword: /cohere|co_api_key/giu,
    keywordLengths: [10, 6],
    secret: fixed(40, isAlnum),
  },
  {
    id: "okta-access-token",
    regex: String.raw`[\w.-]{0,50}?(?i:[\w.-]{0,50}?(?:(?-i:[Oo]kta|OKTA))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(00[\w=\-]{40})(?:[\x60'"\s;]|\\[nr]|$)`,
    keyword: /[Oo]kta|OKTA/g,
    keywordLengths: [4],
    secret: fixed(42, isOktaChar, "00"),
  },
  {
    id: "privateai-api-token",
    regex: String.raw`[\w.-]{0,50}?(?i:[\w.-]{0,50}?(?:private[_-]?ai)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:[\x60'"\s;]|\\[nr]|$)`,
    keyword: /private[_-]?ai/giu,
    keywordLengths: [10, 9],
    secret: fixed(32, isLowerAlnum),
  },
  {
    id: "sumologic-access-id",
    regex: String.raw`[\w.-]{0,50}?(?i:[\w.-]{0,50}?(?:(?-i:[Ss]umo|SUMO))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(su[a-zA-Z0-9]{12})(?:[\x60'"\s;]|\\[nr]|$)`,
    keyword: /[Ss]umo|SUMO/g,
    keywordLengths: [4],
    secret: fixed(14, isAlnum, "su"),
  },
];

const NONE = -1;

/**
 * The length of the keyword occurrence `finder` found ending at `end`: the length at which the same regex, anchored
 * (`sticky`), matches through `end`. One of them does, as the finder's match is one of them.
 */
function keywordEndingAt(rule: AssignmentRule, sticky: RegExp, text: string, end: number): number {
  for (const length of rule.keywordLengths) {
    sticky.lastIndex = end - length;
    if (sticky.test(text) && sticky.lastIndex === end) return length;
  }
  return rule.keywordLengths[rule.keywordLengths.length - 1]!;
}

function assignmentPattern(rule: AssignmentRule): Pattern {
  return patternOf((text, first) => {
    const length = text.length;
    /** Where a match ends when the secret starts at `at` (the secret and `(?:[\x60'"\s;]|\\[nr]|$)`), or NONE. */
    const secretEnd = (at: number): number => {
      const secret = rule.secret(text, at);
      if (secret < 0) return NONE;
      const after = at + secret;
      if (after === length) return after;
      const c = text.charCodeAt(after);
      if (isAfterSecret(c)) return after + 1;
      if (c === 92 /* \ */) {
        const next = text.charCodeAt(after + 1);
        if (next === 110 || next === 114) return after + 2;
      }
      return NONE;
    };
    /** `[\x60'"\s=]{0,5}` (greedy) then the secret: the secret's start, or NONE. */
    const beforeSecret = (at: number): number => {
      for (let n = runOf(text, at, isBeforeSecret, 5); n >= 0; n--) if (secretEnd(at + n) !== NONE) return at + n;
      return NONE;
    };
    /**
     * Memo of `operator` by position, as found + 2 (0: not yet worked out). Several keywords can reach one operator,
     * and a keyword is looked at again when a match ends within 100 characters of it; with the memo each operator
     * position costs one evaluation.
     */
    let operators: Int32Array | undefined;
    /** OP's alternatives in order, then the rest: the secret's start, or NONE. */
    const operator = (at: number): number => {
      const c = text.charCodeAt(at);
      if (c !== 61 && c !== 62 && c !== 58 && c !== 124 && c !== 63 && c !== 44) return NONE;
      operators ??= new Int32Array(length + 1);
      if (operators[at] !== 0) return operators[at]! - 2;
      const next = text.charCodeAt(at + 1);
      let found = NONE;
      if (c === 61 /* = */ || c === 62 /* > */) found = beforeSecret(at + 1);
      if (found === NONE && c === 58 /* : */) {
        // `:{1,3}=`, greedy: three colons first.
        for (let n = runOf(text, at, (x) => x === 58, 3); n >= 1 && found === NONE; n--) {
          if (text.charCodeAt(at + n) === 61) found = beforeSecret(at + n + 1);
        }
      }
      if (found === NONE && c === 124 && next === 124) found = beforeSecret(at + 2); // ||
      if (found === NONE && c === 58) found = beforeSecret(at + 1); // :
      if (found === NONE && c === 61 && next === 62) found = beforeSecret(at + 2); // =>
      if (found === NONE && c === 63 && next === 61) found = beforeSecret(at + 2); // ?=
      if (found === NONE && c === 44) found = beforeSecret(at + 1); // ,
      operators[at] = found + 2;
      return found;
    };
    /**
     * From the keyword at `k`: `[ \t\w.-]{0,20}` and `[\s'"]{0,3}` (W and S), then OP: the secret's start. No
     * operator character is in W or S, so OP can only start at p, the first character past the keyword in neither;
     * every way W and S split `[after, p)` reaches that same p, so their backtracking order does not matter. A split
     * exists when W can end somewhere in [max(p − 3, last non-S + 1), min(after + 20, first non-W)]. The run of W
     * and S characters that p ends is kept (`runFrom`, `runTo`), so keywords inside one long run (`okta0okta0…`)
     * find their p without reading it again.
     */
    let runFrom = 0;
    let runTo = -1;
    const suffix = (k: number, keyword: number): number => {
      const after = k + keyword;
      if (after < runFrom || after > runTo) {
        runFrom = after;
        runTo = after;
        while (runTo < length && (bitsOf(text.charCodeAt(runTo)) & (AFTER_KEYWORD | QUOTE_SPACE)) !== 0) runTo++;
      }
      const p = runTo;
      if (p - after > 23) return NONE;
      let firstNotW = NONE;
      let lastNotS = NONE;
      for (let i = after; i < p; i++) {
        const bits = bitsOf(text.charCodeAt(i));
        if ((bits & AFTER_KEYWORD) === 0 && firstNotW === NONE) firstNotW = i;
        if ((bits & QUOTE_SPACE) === 0) lastNotS = i;
      }
      const lowest = Math.max(p - 3, lastNotS + 1, after);
      const highest = Math.min(after + 20, firstNotW === NONE ? p : firstNotW);
      return lowest <= highest ? operator(p) : NONE;
    };
    /** start(k): the least start at or after `from` whose lazy runs reach the keyword at `k`. */
    const startFor = (k: number, from: number): number => {
      const floor = Math.max(from, k - 100);
      for (let j = k - 1; j >= floor; j--) {
        const c = text.charCodeAt(j);
        if ((bitsOf(c) & RUN_FOLDED) === 0 || (j < k - 50 && isFoldExtra(c))) return j + 1;
      }
      return floor;
    };

    // Keyword occurrences in order (none overlaps another: no keyword has a proper prefix that is its suffix), found
    // with `test` and `lastIndex` rather than `exec`, which allocates a match per occurrence. After a match the
    // search restarts at its end, so the keywords within 100 characters past its start are found again: a bounded
    // number per match.
    const finder = new RegExp(rule.keyword);
    const sticky = rule.keywordLengths.length > 1 ? new RegExp(rule.keyword.source, `${rule.keyword.flags}y`) : finder;
    const out: Found[] = [];
    let from = 0;
    for (;;) {
      let bestStart = NONE;
      let bestSecret = NONE;
      finder.lastIndex = from;
      while (finder.test(text)) {
        const end = finder.lastIndex;
        const keyword =
          rule.keywordLengths.length === 1 ? rule.keywordLengths[0]! : keywordEndingAt(rule, sticky, text, end);
        const k = end - keyword;
        if (bestStart !== NONE && k - 100 >= bestStart) break;
        const secret = suffix(k, keyword);
        // Inside a run of W and S characters longer than 23, every keyword whose end lies over 23 before the run's
        // end has no suffix (`okta0okta0…`): the search jumps to the first that may.
        if (runTo - (k + keyword) > 23) finder.lastIndex = Math.max(end, runTo - 23 - rule.keywordLengths[0]!);
        if (secret === NONE) continue;
        const start = startFor(k, from);
        if (bestStart === NONE || start < bestStart) {
          bestStart = start;
          bestSecret = secret;
        }
      }
      if (bestStart === NONE) break;
      const end = secretEnd(bestSecret);
      out.push({
        start: bestStart,
        end,
        groups: [undefined, [bestSecret, bestSecret + rule.secret(text, bestSecret)]],
      });
      if (first) break;
      from = end;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The curl rules: `\bcurl\b(?:.*?|.*?(?:[\r\n]{1,2}.*?){1,5})[ \t\n\r](?:-H|--header)…` (lazy) and
// `\bcurl\b(?:.*|.*(?:[\r\n]{1,2}.*){1,5})[ \t\n\r](?:-u|--user)…` (greedy).
//
// A match starts at a `curl`, so the leftmost match is the first `curl` with any match. After it, the regex is a
// path to an option position q (a `[ \t\n\r]` before `-H`/`-u`), then the rest R(q), which depends on q alone (and
// is worked out by hand below, deterministically, in RE2's order). The path's order: first alternative, q on the
// curl's own line (`.` stops at `\n`, `\r`, U+2028, U+2029), up to and including its line break, last first
// (greedy) or first first (lazy); then the second, through 1–5 more lines: each line break of one or two `\r`/`\n`
// (two first), then `.*` over the next line, and at that line's end one more line before stopping (greedy {1,5}).
// Line j's positions are tried in the same order as the first line's. So the first q in that order with R(q)
// succeeding gives the match. Option positions with a failing R are skipped with memos (nextOk/prevOk), so many
// `curl`s on one line cost one pass over its options, and the multi-line walk from a line break is memoized by
// break and depth.
// ---------------------------------------------------------------------------------------------------------------

const isLineBreak = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const isCrLf = (c: number) => c === 10 || c === 13;
const isSpaceTab = (c: number) => c === 32 || c === 9;
const isOptionSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

interface Rest {
  end: number;
  groups: (Span | undefined)[];
}

interface CurlRule {
  id: string;
  regex: string;
  /** Whether the path before the option is lazy (`.*?`) rather than greedy (`.*`). */
  lazy: boolean;
  options: [string, string];
  groupCount: number;
  /** R(q) from the option's first character `at` (just past the `[ \t\n\r]`), or null. */
  rest(text: string, at: number): Rest | null;
}

/** After `-u`/`-H` (at `at`): `(?:=|[ \t]{0,5})`. Where the value starts, or NONE when no value can follow. */
function valueStart(text: string, at: number, startsValue: (c: number) => boolean): number {
  // `=`; when no value can follow it, the spaces alternative takes none and sees the `=`, which starts no value.
  if (text.charCodeAt(at) === 61) return startsValue(text.charCodeAt(at + 1)) ? at + 1 : NONE;
  const spaces = runOf(text, at, isSpaceTab);
  // More than 5 spaces leave a space where the value must start, at every count the repeat can take.
  if (spaces > 5) return NONE;
  return startsValue(text.charCodeAt(at + spaces)) ? at + spaces : NONE;
}

// curl-auth-user's value: `("(:[^"]{3,}|[^:"]{3,}:|[^:"]{3,}:[^"]{3,})"|'([^:']{3,}:[^']{3,})'|((?:"[^"]{3,}"|
// '[^']{3,}'|[\w$@.-]+):(?:"[^"]{3,}"|'[^']{3,}'|[\w${}@.-]+)))(?:\s|\z)`. Each `[^"]{3,}` ends only at the next
// quote and each `[\w$@.-]+` only at its run's end (what follows cannot be in the class), so every alternative has
// one way to match; they are tried in order. `{3,}` counts code points.
const isUserChar = (c: number) => isWord(c) || c === 36 || c === 64 || c === 46 || c === 45;
const isPasswordChar = (c: number) => isUserChar(c) || c === 123 || c === 125;
const QUOTE = 34;
const APOSTROPHE = 39;

/** The first `:` in `[from, to)`, or NONE (a search bounded by the quote, so options never rescan the text). */
function colonIn(text: string, from: number, to: number): number {
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 58) return i;
  return NONE;
}

/** `(?:\s|\z)` at `at`: where the match ends, or NONE. */
function spaceOrEnd(text: string, at: number): number {
  if (at < text.length && isJsSpace(text.charCodeAt(at))) return at + 1;
  return at === text.length ? at : NONE;
}

/** `"[^"]{3,}"` or `'[^']{3,}'` from the opening quote at `at`: the index after the closing quote, or NONE. */
function quoted(text: string, at: number): number {
  const close = text.indexOf(text[at]!, at + 1);
  return close >= 0 && atLeastCodePoints(text, at + 1, close, 3) ? close + 1 : NONE;
}

function userRest(text: string, at: number): Rest | null {
  let option: number;
  if (wordAt(text, at, "-u")) option = at + 2;
  else if (wordAt(text, at, "--user")) option = at + 6;
  else return null;
  const start = valueStart(text, option, (c) => c === QUOTE || c === APOSTROPHE || isUserChar(c));
  if (start === NONE) return null;
  const open = text.charCodeAt(start);
  if (open === QUOTE) {
    // `"(:[^"]{3,}|[^:"]{3,}:|[^:"]{3,}:[^"]{3,})"`: all three end at the next quote.
    const close = text.indexOf('"', start + 1);
    if (close >= 0) {
      const inner = start + 1;
      const colon = colonIn(text, inner, close);
      const valid =
        (text.charCodeAt(inner) === 58 && atLeastCodePoints(text, inner + 1, close, 3)) ||
        (colon !== NONE &&
          atLeastCodePoints(text, inner, colon, 3) &&
          (colon === close - 1 || atLeastCodePoints(text, colon + 1, close, 3)));
      const end = valid ? spaceOrEnd(text, close + 1) : NONE;
      if (end !== NONE) return { end, groups: [undefined, [start, close + 1], [inner, close], undefined, undefined] };
    }
  } else if (open === APOSTROPHE) {
    // `'([^:']{3,}:[^']{3,})'`.
    const close = text.indexOf("'", start + 1);
    if (close >= 0) {
      const inner = start + 1;
      const colon = colonIn(text, inner, close);
      const valid =
        colon !== NONE && atLeastCodePoints(text, inner, colon, 3) && atLeastCodePoints(text, colon + 1, close, 3);
      const end = valid ? spaceOrEnd(text, close + 1) : NONE;
      if (end !== NONE) return { end, groups: [undefined, [start, close + 1], undefined, [inner, close], undefined] };
    }
  }
  // `(?:"[^"]{3,}"|'[^']{3,}'|[\w$@.-]+):(?:"[^"]{3,}"|'[^']{3,}'|[\w${}@.-]+)`.
  const userEnd = open === QUOTE || open === APOSTROPHE ? quoted(text, start) : start + runOf(text, start, isUserChar);
  if (userEnd === NONE || userEnd === start || text.charCodeAt(userEnd) !== 58) return null;
  const password = userEnd + 1;
  const first = text.charCodeAt(password);
  const passwordEnd =
    first === QUOTE || first === APOSTROPHE ? quoted(text, password) : password + runOf(text, password, isPasswordChar);
  if (passwordEnd === NONE || passwordEnd === password) return null;
  const end = spaceOrEnd(text, passwordEnd);
  if (end === NONE) return null;
  return { end, groups: [undefined, [start, passwordEnd], undefined, undefined, [start, passwordEnd]] };
}

// curl-auth-header's value: `(?:"(?i)(?:A)"|'(?i)(?:A)')(?:\B|\s|\z)` with A =
// `Authorization:[ \t]{0,5}(?:Basic[ \t](B64)|(?:Bearer|(?:Api-)?Token)[ \t](TOKEN)|(TOKEN))` then
// `|(?:(?:X-(?:[a-z]+-)?)?(?:Api-?)?(?:Key|Token)):[ \t]{0,5}(TOKEN)`, B64 = `[a-z0-9+/]{8,}={0,3}` and
// TOKEN = `[\w=~@.+/-]{8,}`, all under (?i). Groups 1–4 in the double-quoted branch, 5–8 in the single-quoted one.
// Every run is maximal (what follows cannot be in its class), so each alternative has one way to match; they are
// tried in order. After the closing quote (a non-word character) `\B` holds unless a word character follows, and
// `\s` and `\z` cannot hold where `\B` does not, so the match ends just past the quote or not at all.
/** `[a-z0-9+/]` under (?i). */
const isBase64 = (c: number) => isFoldedLetter(c) || (c >= 48 && c <= 57) || c === 43 || c === 47;
/** `[\w=~@.+/-]` under (?i). */
const isToken = (c: number) =>
  isWord(c) || isFoldExtra(c) || c === 61 || c === 126 || c === 64 || c === 46 || c === 43 || c === 47 || c === 45;

/** A TOKEN run of 8 or more at `at` closed by `quote`: the closing quote's index, or NONE. */
function tokenThenQuote(text: string, at: number, quote: number): number {
  const run = runOf(text, at, isToken);
  return run >= 8 && text.charCodeAt(at + run) === quote ? at + run : NONE;
}

/**
 * Whether the header name `[from, to)` (letters, under (?i), and `-`) reads
 * `(?:X-(?:[a-z]+-)?)?(?:Api-?)?(?:Key|Token)` in full: `key` or `token` last; before it, optionally `api` or `api-`;
 * before that nothing, `x-`, or `x-`, letters and `-`. Every way of reading it is tried.
 */
function isKeyHeader(text: string, from: number, to: number): boolean {
  for (const word of ["key", "token"]) {
    const end = to - word.length;
    if (end < from || !foldedAt(text, end, word)) continue;
    const heads = [end];
    if (end - 3 >= from && foldedAt(text, end - 3, "api")) heads.push(end - 3);
    if (end - 4 >= from && foldedAt(text, end - 4, "api-")) heads.push(end - 4);
    for (const head of heads) {
      if (head === from) return true;
      if (head - from < 2 || !foldedAt(text, from, "x-")) continue;
      if (head - from === 2) return true;
      // `x-`, one or more letters, `-`.
      if (head - from >= 4 && text.charCodeAt(head - 1) === 45) {
        let letters = true;
        for (let i = from + 2; i < head - 1 && letters; i++) letters = isFoldedLetter(text.charCodeAt(i));
        if (letters) return true;
      }
    }
  }
  return false;
}

function headerRest(text: string, at: number): Rest | null {
  let option: number;
  if (wordAt(text, at, "-H")) option = at + 2;
  else if (wordAt(text, at, "--header")) option = at + 8;
  else return null;
  const open = valueStart(text, option, (c) => c === QUOTE || c === APOSTROPHE);
  if (open === NONE) return null;
  const quote = text.charCodeAt(open);
  const base = quote === QUOTE ? 0 : 4; // groups 1–4 or 5–8
  const inner = open + 1;
  const done = (close: number, group: number, from: number): Rest | null => {
    const after = close + 1;
    if (after < text.length && isWord(text.charCodeAt(after))) return null;
    const groups: (Span | undefined)[] = new Array(9).fill(undefined);
    groups[base + group] = [from, close];
    return { end: after, groups };
  };
  if (foldedAt(text, inner, "authorization:")) {
    const spaces = runOf(text, inner + 14, isSpaceTab);
    const value = inner + 14 + spaces;
    if (spaces <= 5) {
      // Basic[ \t](B64): the run, then at most three `=`, then the quote.
      if (foldedAt(text, value, "basic") && isSpaceTab(text.charCodeAt(value + 5))) {
        const from = value + 6;
        const run = runOf(text, from, isBase64);
        const pads = runOf(text, from + run, (c) => c === 61);
        if (run >= 8 && pads <= 3 && text.charCodeAt(from + run + pads) === quote) {
          const found = done(from + run + pads, 1, from);
          if (found) return found;
        }
      }
      // (?:Bearer|(?:Api-)?Token)[ \t](TOKEN): at most one of the three words starts here.
      const word = foldedAt(text, value, "bearer")
        ? 6
        : foldedAt(text, value, "api-token")
          ? 9
          : foldedAt(text, value, "token")
            ? 5
            : 0;
      if (word > 0 && isSpaceTab(text.charCodeAt(value + word))) {
        const close = tokenThenQuote(text, value + word + 1, quote);
        if (close !== NONE) {
          const found = done(close, 2, value + word + 1);
          if (found) return found;
        }
      }
      const close = tokenThenQuote(text, value, quote);
      if (close !== NONE) {
        const found = done(close, 3, value);
        if (found) return found;
      }
    }
  }
  // The key-header alternative: the name is the run of letters and `-` up to a `:` (it holds neither `:` nor
  // anything else, so it is that whole run or nothing).
  const nameEnd = inner + runOf(text, inner, (c) => isFoldedLetter(c) || c === 45);
  if (text.charCodeAt(nameEnd) !== 58) return null;
  if (!isKeyHeader(text, inner, nameEnd)) return null;
  const spaces = runOf(text, nameEnd + 1, isSpaceTab);
  if (spaces > 5) return null;
  const from = nameEnd + 1 + spaces;
  const close = tokenThenQuote(text, from, quote);
  return close === NONE ? null : done(close, 4, from);
}

const CURL_RULES: CurlRule[] = [
  {
    id: "curl-auth-header",
    regex: String.raw`\bcurl\b(?:.*?|.*?(?:[\r\n]{1,2}.*?){1,5})[ \t\n\r](?:-H|--header)(?:=|[ \t]{0,5})(?:"(?i)(?:Authorization:[ \t]{0,5}(?:Basic[ \t]([a-z0-9+/]{8,}={0,3})|(?:Bearer|(?:Api-)?Token)[ \t]([\w=~@.+/-]{8,})|([\w=~@.+/-]{8,}))|(?:(?:X-(?:[a-z]+-)?)?(?:Api-?)?(?:Key|Token)):[ \t]{0,5}([\w=~@.+/-]{8,}))"|'(?i)(?:Authorization:[ \t]{0,5}(?:Basic[ \t]([a-z0-9+/]{8,}={0,3})|(?:Bearer|(?:Api-)?Token)[ \t]([\w=~@.+/-]{8,})|([\w=~@.+/-]{8,}))|(?:(?:X-(?:[a-z]+-)?)?(?:Api-?)?(?:Key|Token)):[ \t]{0,5}([\w=~@.+/-]{8,}))')(?:\B|\s|\z)`,
    lazy: true,
    options: ["-H", "--header"],
    groupCount: 8,
    rest: headerRest,
  },
  {
    id: "curl-auth-user",
    regex: String.raw`\bcurl\b(?:.*|.*(?:[\r\n]{1,2}.*){1,5})[ \t\n\r](?:-u|--user)(?:=|[ \t]{0,5})("(:[^"]{3,}|[^:"]{3,}:|[^:"]{3,}:[^"]{3,})"|'([^:']{3,}:[^']{3,})'|((?:"[^"]{3,}"|'[^']{3,}'|[\w$@.-]+):(?:"[^"]{3,}"|'[^']{3,}'|[\w${"$"}{}@.-]+)))(?:\s|\z)`,
    lazy: false,
    options: ["-u", "--user"],
    groupCount: 4,
    rest: userRest,
  },
];

/** The deepest line the second alternative reaches: `{1,5}`. */
const MAX_LINES = 5;

function curlPattern(rule: CurlRule): Pattern {
  return patternOf((text, first) => {
    const length = text.length;
    if (text.indexOf("curl") < 0) return [];
    // Option positions: a `[ \t\n\r]` followed by either option, in order.
    const options: number[] = [];
    for (let dash = text.indexOf("-", 1); dash >= 0; dash = text.indexOf("-", dash + 1)) {
      if (!isOptionSpace(text.charCodeAt(dash - 1))) continue;
      if (wordAt(text, dash, rule.options[0]) || wordAt(text, dash, rule.options[1])) options.push(dash - 1);
    }
    if (options.length === 0) return [];
    const count = options.length;
    const rests: (Rest | null | undefined)[] = new Array(count);
    const restAt = (i: number): Rest | null => (rests[i] ??= rule.rest(text, options[i]! + 1));
    // nextOk[i]: the first option at or after i whose rest matches (count: none); prevOk the last at or before (-1).
    const UNKNOWN = -2;
    const nextOk = new Int32Array(count).fill(UNKNOWN);
    const prevOk = new Int32Array(count).fill(UNKNOWN);
    // Each walks to the first known or matching option, then points every option it passed there.
    const firstOk = (i: number): number => {
      let stop = i;
      while (stop < count && nextOk[stop] === UNKNOWN && !restAt(stop)) stop++;
      const found = stop === count ? count : nextOk[stop] === UNKNOWN ? stop : nextOk[stop]!;
      for (let w = i; w <= stop && w < count; w++) nextOk[w] = found;
      return found;
    };
    const lastOk = (i: number): number => {
      let stop = i;
      while (stop >= 0 && prevOk[stop] === UNKNOWN && !restAt(stop)) stop--;
      const found = stop < 0 ? -1 : prevOk[stop] === UNKNOWN ? stop : prevOk[stop]!;
      for (let w = i; w >= stop && w >= 0; w--) prevOk[w] = found;
      return found;
    };
    /** The index of the first option at or after `position`. */
    const lowerBound = (position: number): number => {
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (options[mid]! < position) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    /** The first (lazy) or last (greedy) option in `[lo, hi]` whose rest matches, or NONE. */
    const pick = (lo: number, hi: number): number => {
      if (hi < lo) return NONE;
      if (rule.lazy) {
        const j = firstOk(lowerBound(lo));
        return j < count && options[j]! <= hi ? options[j]! : NONE;
      }
      const i = lowerBound(hi + 1) - 1;
      if (i < 0) return NONE;
      const j = lastOk(i);
      return j >= 0 && options[j]! >= lo ? options[j]! : NONE;
    };
    /** The line break that ends the line holding `at` (a `.` stops there), or the text's length. */
    let knownFrom = 0;
    let knownEnd = -1;
    const lineEnd = (at: number): number => {
      if (at >= knownFrom && at <= knownEnd) return knownEnd;
      let end = at;
      while (end < length && !isLineBreak(text.charCodeAt(end))) end++;
      knownFrom = at;
      knownEnd = end;
      return end;
    };
    /** Memo of `walk` by line break and depth, as found + 2 (0: not yet worked out). */
    let walks: Int32Array | undefined;
    /** The option the second alternative reaches from the line break at `at`, through line `depth`, or NONE. */
    const walk = (at: number, depth: number): number => {
      // Every option it could reach lies after `at`: none whose rest matches, nothing to walk.
      if (firstOk(lowerBound(at)) >= count) return NONE;
      walks ??= new Int32Array(length * MAX_LINES);
      const key = at * MAX_LINES + depth - 1;
      if (walks[key] !== 0) return walks[key]! - 2;
      let found = NONE;
      // `[\r\n]{1,2}`: two first.
      for (const breakLength of isCrLf(text.charCodeAt(at + 1)) ? [2, 1] : [1]) {
        const lineStart = at + breakLength;
        const end = lineEnd(lineStart);
        const deeper = depth < MAX_LINES && end < length && isCrLf(text.charCodeAt(end));
        if (rule.lazy) {
          found = pick(lineStart, end - 1);
          if (found === NONE && deeper) found = walk(end, depth + 1);
          if (found === NONE) found = pick(end, end);
        } else {
          if (deeper) found = walk(end, depth + 1);
          if (found === NONE) found = pick(lineStart, end);
        }
        if (found !== NONE) break;
      }
      walks[key] = found + 2;
      return found;
    };

    const out: Found[] = [];
    let from = 0;
    for (let curl = text.indexOf("curl"); curl >= 0; curl = text.indexOf("curl", curl + 1)) {
      if (curl < from) continue;
      if (curl > 0 && isWord(text.charCodeAt(curl - 1))) continue;
      if (curl + 4 < length && isWord(text.charCodeAt(curl + 4))) continue;
      const after = curl + 4;
      const end = lineEnd(after);
      let q = pick(after, end);
      if (q === NONE && end < length && isCrLf(text.charCodeAt(end))) q = walk(end, 1);
      if (q === NONE) continue;
      const rest = restAt(lowerBound(q))!;
      const groups = rest.groups.slice(0, rule.groupCount + 1);
      out.push({ start: curl, end: rest.end, groups });
      if (first) break;
      from = rest.end;
    }
    return out;
  });
}

/** A hand-written matcher with the exact gitleaks regex it stands for. */
export interface Scanner {
  regex: string;
  pattern: Pattern;
}

/** The seven rules that backtrack in JavaScript, each on its own linear matcher. */
export const SCANNERS: ReadonlyMap<string, Scanner> = new Map([
  ...ASSIGNMENT_RULES.map((rule): [string, Scanner] => [
    rule.id,
    { regex: rule.regex, pattern: assignmentPattern(rule) },
  ]),
  ...CURL_RULES.map((rule): [string, Scanner] => [rule.id, { regex: rule.regex, pattern: curlPattern(rule) }]),
]);

/**
 * Every character class the scanners test, by the RE2 class it stands for (as re2Source rewrites it). For
 * own-matchers.test.ts, which checks each against re2js on every BMP code point and some astral ones.
 */
export const SCANNER_CLASSES: Record<string, (c: number) => boolean> = {
  [String.raw`\w`]: isWord,
  [String.raw`\s`]: isJsSpace,
  ".": (c) => !isLineBreak(c),
  [String.raw`[\r\n]`]: isCrLf,
  [String.raw`[ \t]`]: isSpaceTab,
  [String.raw`[ \t\n\r]`]: isOptionSpace,
  [String.raw`[\w.-]`]: isRunAscii,
  [String.raw`(?i:[\w.-])`]: isRunFolded,
  [String.raw`(?i:[ \t\w.-])`]: isAfterKeyword,
  [String.raw`[\s'"]`]: isQuoteOrSpace,
  [String.raw`[\x60'"\s=]`]: isBeforeSecret,
  [String.raw`[\x60'"\s;]`]: isAfterSecret,
  "[0-9a-f]": isHex,
  "[a-zA-Z0-9]": isAlnum,
  "[a-z0-9]": isLowerAlnum,
  [String.raw`[\w=\-]`]: isOktaChar,
  "(?i:[a-z])": isFoldedLetter,
  "(?i:[a-z0-9+/])": isBase64,
  [String.raw`(?i:[\w=~@.+/-])`]: isToken,
  [String.raw`[\w$@.-]`]: isUserChar,
  [String.raw`[\w$${"{"}}@.-]`]: isPasswordChar,
};
