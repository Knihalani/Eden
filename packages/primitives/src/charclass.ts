/**
 * Per-code-unit tables for the tokenizer, indexed by UTF-16 code unit: branch-light table lookups instead of a Unicode
 * regex per character.
 *
 * - CLASS: whether a code unit starts or continues a term.
 * - FOLD: the code unit a character folds to for matching: lowercase, compatibility-decomposed, combining marks
 *   dropped ("Ö" → "o", "é" → "e"). FOLD_DROP marks a character that folds to nothing (a combining mark), FOLD_EXPAND
 *   one that folds to several (the ligature "ﬁ" → "fi"), which the tokenizer sends to its slow path.
 *
 * ASCII is filled at load. Other code units are classified on first sight and cached, so startup costs nothing and a
 * text pays only for characters it contains. Surrogate halves (emoji, rare astral letters) are separators.
 */
export const WORD_START = 1; // a letter or a digit
export const WORD_PART = 2; // a letter, digit, combining mark, apostrophe, underscore or hyphen
const KNOWN = 128;

export const FOLD_DROP = 0xfffe;
export const FOLD_EXPAND = 0xffff;

export const CLASS = new Uint8Array(65_536);
export const FOLD = new Uint16Array(65_536);

for (let c = 0; c < 128; c++) {
  let k = KNOWN;
  const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  if (alnum) k |= WORD_START | WORD_PART;
  if (c === 39 || c === 95 || c === 45) k |= WORD_PART; // ' _ -
  CLASS[c] = k;
  FOLD[c] = c >= 65 && c <= 90 ? c | 32 : c;
}

const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
const MARK = /^\p{M}$/u;
const MARKS = /\p{M}/gu;

/** Classifies code unit `c` (≥ 128) into CLASS and FOLD, once. */
function learn(c: number): void {
  const ch = String.fromCharCode(c);
  let k = KNOWN;
  let f = c;
  if (c >= 0xd800 && c <= 0xdfff) {
    f = FOLD_DROP;
  } else if (c === 0x2019 || c === 0x2018) {
    k |= WORD_PART; // typographic apostrophes, as in "Dana’s"
    f = 39;
  } else if (MARK.test(ch)) {
    k |= WORD_PART;
    f = FOLD_DROP;
  } else if (LETTER_OR_DIGIT.test(ch)) {
    k |= WORD_START | WORD_PART;
    // Word-final sigma folds like sigma: "ΟΔΟΣ" and "οδος" are one term.
    const folded = c === 0x3c2 ? "σ" : ch.normalize("NFKD").replace(MARKS, "").toLowerCase();
    f = folded.length === 1 ? folded.charCodeAt(0) : folded.length === 0 ? FOLD_DROP : FOLD_EXPAND;
  }
  CLASS[c] = k;
  FOLD[c] = f;
}

/** The CLASS entry of code unit `c`. */
export function classOf(c: number): number {
  if (CLASS[c] === 0) learn(c);
  return CLASS[c]!;
}

/** The FOLD entry of code unit `c`; call after `classOf(c)` for non-ASCII `c`. */
export function foldOf(c: number): number {
  if (CLASS[c] === 0) learn(c);
  return FOLD[c]!;
}

/**
 * Folds a whole string for matching, per code unit with the same table the tokenizer uses, so both always agree.
 * Characters that expand (ligatures) are decomposed one at a time. Context-free on purpose: whole-string
 * `toLowerCase` turns a word-final Σ into ς, which the per-character fold maps to σ, and would give one word two ids.
 */
export function foldString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const f = c < 128 ? FOLD[c]! : foldOf(c);
    if (f === FOLD_DROP) continue;
    if (f === FOLD_EXPAND) {
      const expanded = String.fromCharCode(c).normalize("NFKD").replace(MARKS, "").toLowerCase();
      for (let j = 0; j < expanded.length; j++) {
        const e = expanded.charCodeAt(j);
        const g = e < 128 ? FOLD[e]! : foldOf(e);
        if (g !== FOLD_DROP && g !== FOLD_EXPAND) out += String.fromCharCode(g);
      }
      continue;
    }
    out += String.fromCharCode(f);
  }
  return out;
}
