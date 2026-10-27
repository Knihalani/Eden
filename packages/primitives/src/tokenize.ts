/**
 * The shared tokenizer: one definition of a "term" for indexes, queries, gazetteers and usage tracking, so they
 * always agree. A term starts with a letter or digit and continues through letters, digits, combining marks,
 * apostrophes, underscores and hyphens; it is folded (lowercase, accents dropped: FOLD in charclass.ts); a trailing
 * possessive ('s, ’s) and trailing punctuation (' _ -) are stripped; terms of one character are dropped.
 *
 * `tokenizeInto` fuses scanning, folding, hashing and interning in one pass and writes term ids into a caller-owned
 * Uint32Array. A term already in the vocabulary allocates nothing, ASCII or not. Only a new term (its string is
 * stored once) or a term with an expanding character such as a ligature (rare) takes a slower path.
 */
import { CLASS, classOf, FOLD, FOLD_DROP, FOLD_EXPAND, foldOf, foldString, WORD_PART, WORD_START } from "./charclass";
import { termHash, type Vocab } from "./vocab";

const lanes = new Uint32Array(2);

/**
 * Tokenizes `text` into term ids. With `intern` true, unseen terms are added to `vocab` (indexing); with it false
 * they are skipped (querying: an unseen term matches nothing). Writes at most `out.length` ids and returns how many
 * it wrote. `starts`, if given, receives each term's start offset in `text`.
 */
export function tokenizeInto(
  text: string,
  vocab: Vocab,
  intern: boolean,
  out: Uint32Array,
  starts: Uint32Array | null,
): number {
  const n = text.length;
  const cap = out.length;
  let count = 0;
  let i = 0;
  while (i < n && count < cap) {
    let c = text.charCodeAt(i);
    if (((c < 128 ? CLASS[c]! : classOf(c)) & WORD_START) === 0) {
      i++;
      continue;
    }
    const start = i;
    let h = 0x811c9dc5 | 0;
    let g = 0x9747b28c | 0;
    let len = 0;
    let expands = false;
    for (; i < n; i++) {
      c = text.charCodeAt(i);
      let f: number;
      if (c < 128) {
        if ((CLASS[c]! & WORD_PART) === 0) break;
        f = FOLD[c]!;
      } else {
        if ((classOf(c) & WORD_PART) === 0) break;
        f = FOLD[c]!;
        if (f === FOLD_DROP) continue;
        if (f === FOLD_EXPAND) {
          expands = true;
          continue;
        }
      }
      h = Math.imul(h ^ f, 0x01000193);
      g = Math.imul(g ^ f, 0x5bd1e995);
      g = (g << 15) | (g >>> 17);
      len++;
    }
    // Trim a trailing possessive and trailing punctuation; rehash only when something was trimmed (rare).
    let end = i;
    if (end - start > 2) {
      const last = text.charCodeAt(end - 1);
      const prev = text.charCodeAt(end - 2);
      if ((last === 115 || last === 83) && (prev === 39 || prev === 0x2019)) end -= 2;
    }
    while (end > start && (classOf(text.charCodeAt(end - 1)) & WORD_START) === 0) end--;

    let id: number;
    if (expands) {
      const term = foldString(text.slice(start, end));
      if (term.length <= 1) continue;
      id = intern ? vocab.intern(term) : vocab.lookup(term);
    } else {
      if (end !== i) {
        termHash(text, start, end, lanes);
        h = lanes[0]!;
        g = lanes[1]!;
        len = foldedLengthOf(text, start, end);
      }
      if (len <= 1) continue;
      id = intern ? vocab.internRange(text, start, end, h, g, len) : vocab.lookupRange(h, g, len);
    }
    if (id < 0) continue;
    if (starts !== null) starts[count] = start;
    out[count++] = id;
  }
  return count;
}

function foldedLengthOf(text: string, start: number, end: number): number {
  let len = 0;
  for (let j = start; j < end; j++) {
    const c = text.charCodeAt(j);
    if ((c < 128 ? FOLD[c]! : foldOf(c)) !== FOLD_DROP) len++;
  }
  return len;
}

/** Convenience: term strings for a text (allocates; for tests and cold paths). */
export function tokenize(text: string, vocab: Vocab): string[] {
  const out = new Uint32Array(text.length);
  const n = tokenizeInto(text, vocab, true, out, null);
  const terms: string[] = new Array(n);
  for (let j = 0; j < n; j++) terms[j] = vocab.term(out[j]!);
  return terms;
}
