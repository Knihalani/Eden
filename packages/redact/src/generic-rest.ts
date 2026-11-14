/**
 * D1850: generic-api-key's REST (the regex after its lazy prefix, `LazyPrefixRegex` in anchor.ts) read by hand. On
 * crafted input (`key=` a megabyte long, one line of findings) JavaScript's engine spent 0.2 µs a character in its
 * secret part, backtracking `[\w.=-]{10,150}` from 150 down at every operator. This reads the same regex, from the
 * same position, to the same end, as the engine does (sticky, case folded for ASCII only, no `u` flag):
 *
 *   KW  (?:access|auth|(?-i:[Aa]pi|API)|credential|creds|key|passw(?:or)?d|secret|token)
 *   W   (?:[ \t\w.-]{0,20})        S  [\s'"]{0,3}
 *   OP  (?:=|>|:{1,3}=|\|\||:|=>|\?=|,)
 *   B   [\x60'"\s=]{0,5}
 *   SEC ([\w.=-]{10,150}|[a-z0-9][a-z0-9+/]{11,}={0,3})
 *   END (?:[\x60'"\s;]|\\[nr]|$)
 *
 * Why it is the engine's answer, in its backtracking order:
 * - KW: at one position at most one alternative matches (none is a prefix of another that also matches there).
 * - W then S: no operator character is in either, so OP starts at p, the first character after KW in neither; the
 *   ways W and S split `[after KW, p)` all reach that p, and one exists when W can end where S can take the rest
 *   (scanners.ts argues the same for its five rules). Past 23 characters, no split.
 * - OP's alternatives are tried in their order at p, `:{1,3}=` with three colons first; for each, B and SEC from its
 *   end, B longest first.
 * - SEC's first branch: END's characters are none of `[\w.=-]`, so a length short of the run of those characters
 *   leaves a run character where END must be: only the whole run can end it, and only when it is 10 to 150 long.
 * - SEC's second: likewise only the whole run of `[A-Za-z0-9+/]` after the first character (11 or more), then every
 *   `=` after it (3 or fewer: with more, an `=` sits where END must be), then END.
 * So each candidate is decided by the length of a run, and each run is read once (`Runs`); generic-rest.test.ts checks
 * every position of seeded texts against the regex itself.
 */

/** The exact regex this reads (`LazyPrefixRegex`'s REST of the vendored generic-api-key rule). */
export const GENERIC_REST_SOURCE = String.raw`(?:access|auth|(?-i:[Aa]pi|API)|credential|creds|key|passw(?:or)?d|secret|token)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([\w.=-]{10,150}|[a-z0-9][a-z0-9+/]{11,}={0,3})(?:[\x60'"\s;]|\\[nr]|$)`;

/** JavaScript's `\s` on one code unit. */
const isSpace = (c: number): boolean =>
  c <= 32
    ? c === 32 || (c >= 9 && c <= 13)
    : c >= 0xa0 &&
      (c === 0xa0 ||
        c === 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) ||
        c === 0x2028 ||
        c === 0x2029 ||
        c === 0x202f ||
        c === 0x205f ||
        c === 0x3000 ||
        c === 0xfeff);
const isWord = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122);
const isAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** W: `[ \t\w.-]`. */
const inW = (c: number) => c === 32 || c === 9 || isWord(c) || c === 46 || c === 45;
/** S: `[\s'"]`. */
const inS = (c: number) => c === 39 || c === 34 || isSpace(c);
/** B: `[\x60'"\s=]`. */
const inB = (c: number) => c === 96 || c === 39 || c === 34 || c === 61 || isSpace(c);
/** SEC's first branch: `[\w.=-]`. */
const inA1 = (c: number) => isWord(c) || c === 46 || c === 61 || c === 45;
/** SEC's second branch after its first character: `[a-z0-9+/]` folded. */
const inA2 = (c: number) => isAlnum(c) || c === 43 || c === 47;
const lower = (c: number) => (c >= 65 && c <= 90 ? c + 32 : c);

/** The length of KW at `k`, or -1: by first letter, folded for ASCII only. */
function keywordAt(text: string, k: number): number {
  const c0 = text.charCodeAt(k);
  // `| 32` maps only `A` and `a` to 97, and likewise for the other letters below.
  switch (c0 | 32) {
    case 97:
      if (text.charCodeAt(k + 1) === 112 && text.charCodeAt(k + 2) === 105) return 3; // [Aa]pi
      if (c0 === 65 && text.charCodeAt(k + 1) === 80 && text.charCodeAt(k + 2) === 73) return 3; // API
      return wordAt(text, k, "access") ? 6 : wordAt(text, k, "auth") ? 4 : -1;
    case 99:
      return wordAt(text, k, "credential") ? 10 : wordAt(text, k, "creds") ? 5 : -1;
    case 107:
      return wordAt(text, k, "key") ? 3 : -1;
    case 112:
      return wordAt(text, k, "passwd") ? 6 : wordAt(text, k, "password") ? 8 : -1;
    case 115:
      return wordAt(text, k, "secret") ? 6 : -1;
    case 116:
      return wordAt(text, k, "token") ? 5 : -1;
    default:
      return -1;
  }
}

/** Whether `word` (lower case) is at `k`, ASCII case folded. */
function wordAt(text: string, k: number, word: string): boolean {
  if (k + word.length > text.length) return false;
  for (let i = 0; i < word.length; i++) if (lower(text.charCodeAt(k + i)) !== word.charCodeAt(i)) return false;
  return true;
}

/** END at `at`: where the match ends after it, or -1. */
function endAt(text: string, at: number): number {
  if (at === text.length) return at;
  const c = text.charCodeAt(at);
  if (c === 96 || c === 39 || c === 34 || c === 59 || isSpace(c)) return at + 1;
  if (c === 92) {
    const n = text.charCodeAt(at + 1);
    if (n === 110 || n === 114 || n === 78 || n === 82) return at + 2; // `\\[nr]` under the `i` flag
  }
  return -1;
}

/**
 * Per text: the last run of W-or-S characters read (`w`), and of SEC's first-branch and second-branch characters
 * (`a1`, `a2`), each as [from, to) with `to` its end. A run is read once to its end and every later question
 * inside it is answered from there: in `key=key=…` each operator's secret would otherwise read 151 characters.
 */
export interface Runs {
  from: number;
  to: number;
  a1From: number;
  a1To: number;
  a2From: number;
  a2To: number;
}

/** A fresh cache, for one text. */
export const freshRuns = (): Runs => ({ from: 0, to: -1, a1From: 0, a1To: -1, a2From: 0, a2To: -1 });

/** SEC then END from `s`: where the match ends, or -1. */
function secretFrom(text: string, s: number, runs: Runs): number {
  const n = text.length;
  // First branch: the whole run of [\w.=-], 10 to 150 long.
  if (s < runs.a1From || s >= runs.a1To) {
    runs.a1From = s;
    runs.a1To = s;
    while (runs.a1To < n && inA1(text.charCodeAt(runs.a1To))) runs.a1To++;
  }
  const r = runs.a1To;
  if (r - s >= 10 && r - s <= 150) {
    const end = endAt(text, r);
    if (end >= 0) return end;
  }
  // Second: one [A-Za-z0-9], the whole run of [A-Za-z0-9+/] (11 or more), every = after it (3 or fewer), END.
  if (s >= n || !isAlnum(text.charCodeAt(s))) return -1;
  if (s + 1 < runs.a2From || s + 1 >= runs.a2To) {
    runs.a2From = s + 1;
    runs.a2To = s + 1;
    while (runs.a2To < n && inA2(text.charCodeAt(runs.a2To))) runs.a2To++;
  }
  const q = runs.a2To;
  if (q - (s + 1) < 11) return -1;
  let e = q;
  while (e < n && e - q <= 3 && text.charCodeAt(e) === 61) e++;
  if (e - q > 3) return -1;
  return endAt(text, e);
}

/** B (longest first), SEC and END from `q`: where the match ends, or -1. */
function tailFrom(text: string, q: number, runs: Runs): number {
  let b = 0;
  while (b < 5 && q + b < text.length && inB(text.charCodeAt(q + b))) b++;
  for (; b >= 0; b--) {
    const end = secretFrom(text, q + b, runs);
    if (end >= 0) return end;
  }
  return -1;
}

/** OP's alternatives in order at `p`, each with its tail: where the match ends, or -1. */
function operatorAt(text: string, p: number, runs: Runs): number {
  const c = text.charCodeAt(p);
  const next = text.charCodeAt(p + 1);
  let end = -1;
  if (c === 61) end = tailFrom(text, p + 1, runs); // =
  if (end < 0 && c === 62) end = tailFrom(text, p + 1, runs); // >
  if (end < 0 && c === 58) {
    // :{1,3}= with the most colons first
    let colons = 0;
    while (colons < 3 && text.charCodeAt(p + colons) === 58) colons++;
    for (let k = colons; k >= 1 && end < 0; k--)
      if (text.charCodeAt(p + k) === 61) end = tailFrom(text, p + k + 1, runs);
  }
  if (end < 0 && c === 124 && next === 124) end = tailFrom(text, p + 2, runs); // ||
  if (end < 0 && c === 58) end = tailFrom(text, p + 1, runs); // :
  if (end < 0 && c === 61 && next === 62) end = tailFrom(text, p + 2, runs); // =>
  if (end < 0 && c === 63 && next === 61) end = tailFrom(text, p + 2, runs); // ?=
  if (end < 0 && c === 44) end = tailFrom(text, p + 1, runs); // ,
  return end;
}

/**
 * generic-api-key's REST matched from `k` (sticky): the end of the match, or -1 when REST does not match there.
 * `runs` (one per text, `freshRuns`) caches the runs read, so keywords inside one long run (`keykeykey…`) find their
 * operator position, and secrets inside one their end, without reading the run again.
 */
export function genericRest(text: string, k: number, runs: Runs): number {
  const kw = keywordAt(text, k);
  if (kw < 0) return -1;
  const after = k + kw;
  if (after < runs.from || after > runs.to) {
    runs.from = after;
    runs.to = after;
    while (runs.to < text.length && (inW(text.charCodeAt(runs.to)) || inS(text.charCodeAt(runs.to)))) runs.to++;
  }
  const p = runs.to;
  if (p - after > 23 || p >= text.length) return -1;
  // W can end anywhere from `after` to the first character W does not take (and 20 at most); S must take the rest,
  // at most 3, all S characters.
  let firstNotW = p;
  let lastNotS = after - 1;
  for (let i = after; i < p; i++) {
    const c = text.charCodeAt(i);
    if (!inW(c) && firstNotW === p) firstNotW = i;
    if (!inS(c)) lastNotS = i;
  }
  const lowest = Math.max(p - 3, lastNotS + 1, after);
  const highest = Math.min(after + 20, firstNotW);
  return lowest <= highest ? operatorAt(text, p, runs) : -1;
}
