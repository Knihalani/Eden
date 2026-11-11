/**
 * M8's connector router (D940–D949; docs/research/m8-router.md): from a request's words and a user's own history,
 * which of the user's sources hold what the request needs, so a lookup reads those live and skips the rest.
 *
 * This file holds the router's features. Terms are the shared tokenizer's (`@eden/primitives`: a letter or digit,
 * then letters, digits, marks, apostrophes, underscores, hyphens; folded; a trailing possessive and punctuation cut;
 * one-character terms dropped), each hashed with FNV-1a over its folded code units, so the lab's trainers (which read
 * terms exported by `m8-export.ts`) and the engine see the same numbers by construction.
 */
import { classOf, CLASS, fnv1a, foldString, WORD_PART, WORD_START } from "@eden/primitives";

/** Words a request or item is read for at most (bounded input: the router never reads more). */
export const ROUTER_MAX_TERMS = 512;

function isStart(c: number): boolean {
  return ((c < 128 ? CLASS[c]! : classOf(c)) & WORD_START) !== 0;
}
function isPart(c: number): boolean {
  return ((c < 128 ? CLASS[c]! : classOf(c)) & WORD_PART) !== 0;
}

/** Calls `each(start, end)` for every term span of `text` (after the tokenizer's trims), at most `max`. */
function spans(text: string, max: number, each: (start: number, end: number) => void): void {
  const n = text.length;
  let i = 0;
  let count = 0;
  while (i < n && count < max) {
    if (!isStart(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && isPart(text.charCodeAt(i))) i++;
    let end = i;
    if (end - start > 2) {
      const last = text.charCodeAt(end - 1);
      const prev = text.charCodeAt(end - 2);
      if ((last === 115 || last === 83) && (prev === 39 || prev === 0x2019)) end -= 2;
    }
    while (end > start && !isStart(text.charCodeAt(end - 1))) end--;
    each(start, end);
    count++;
  }
}

/** The terms of `text` as hashes, in order (bigrams are read from neighbours), at most `ROUTER_MAX_TERMS`. */
export function routerTerms(text: string): number[] {
  const out: number[] = [];
  spans(text, ROUTER_MAX_TERMS, (start, end) => {
    const term = foldString(text.slice(start, end));
    if (term.length <= 1) return;
    out.push(fnv1a(term, 0, term.length));
  });
  return out;
}

/**
 * The names a text mentions, as term hashes: a term written with a capital first letter that does not open a
 * sentence (a request's first word, or one after ". ", "! ", "? " or a line break, is often capitalised for its
 * place alone). Deduplicated, at most 32.
 */
export function routerNames(text: string): number[] {
  const out = new Set<number>();
  let opener = true;
  let last = 0;
  spans(text, ROUTER_MAX_TERMS, (start, end) => {
    for (let j = last; j < start; j++) {
      const c = text.charCodeAt(j);
      if (c === 46 || c === 33 || c === 63 || c === 10) opener = true;
    }
    last = end;
    const c = text.charCodeAt(start);
    const capital = c >= 65 && c <= 90 ? true : c >= 128 ? text[start] !== text[start]!.toLowerCase() : false;
    if (capital && !opener && out.size < 32) {
      const term = foldString(text.slice(start, end));
      if (term.length > 1) out.add(fnv1a(term, 0, term.length));
    }
    opener = false;
  });
  return [...out];
}
