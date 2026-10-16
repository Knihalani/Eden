/**
 * BM25F (D17, A2 §2.2, R1 M1): how the lexical path ranks a row against a cue's words. A row's words fall in four
 * fields, weighted as D17 sets them: the values its D7 keys set (×3), the subjects of those keys (×2), its aliases
 * (×1.5) and its text (×1); k1 = 1.2 and b = 0.75. A term's weighted frequency is normalized field by field against
 * the field's mean length over the rows the reader sees, so a long row that names a cue word once cannot outrank a
 * short row that states it (A2: "one long diary line that mentions `auth` five times cannot outrank the short
 * copula"). Every reader ranks one way: the Submit's situation cue, SubagentStart, PreCompact and the wrap alike.
 *
 * Words are read with R1's tokenizer (`benchmarks/memory-cues/lex.ts`, which D17's BM25F was measured with): a term
 * is 2 characters or more, no stop word (R1's and Eden's own), no number of 1–2 digits, plurals stemmed (`singular`).
 * A row's text gives each compound identifier (`apps/web/middleware.ts`, `T-1264`) whole, its dotted segments whole
 * (`middleware.ts`, as Eden's needles were) and its parts; a prompt keeps a dotted name whole and gives no parts of it
 * (P4.1: "Node.js" split to "node" admitted a mined node-version fact on an R1 hard negative, until P4.3's τ).
 */
import type { MemoryRecord } from "./index";
import { queryHay, singular } from "./memory-cue";
import { isCited, isUntyped } from "./memory-provenance";
import { slotLabel } from "./memory-slots";

export type Field = "value" | "subject" | "alias" | "body";
export const FIELDS: readonly Field[] = ["value", "subject", "alias", "body"];
/** D17's field weights. */
export const FIELD_WEIGHTS: Readonly<Record<Field, number>> = { value: 3, subject: 2, alias: 1.5, body: 1 };
export const K1 = 1.2;
export const B = 0.75;

/**
 * A row the user did not type (a tool result, the agent's text) of more than this many distinct needles is not
 * ranked: P0.6's cost fix for tool results, kept for them only (A2 §2.2: "keep it for episodes only"). Rows the user
 * typed rank at any length, normalized for it.
 */
export const UNTYPED_NEEDLES = 12;

export const STOP = new Set([
  "the",
  "of",
  "is",
  "a",
  "an",
  "on",
  "to",
  "and",
  "in",
  "for",
  "this",
  "that",
  "with",
  "from",
  "into",
  "about",
  "these",
  "then",
  "still",
  "has",
  "out",
  "please",
  "how",
  "should",
  "what",
  "why",
  "was",
  "are",
  "you",
  "your",
  "its",
  "our",
  "not",
  "never",
  "use",
  "used",
  "just",
  "last",
  "week",
  "down",
  "look",
  "next",
  "need",
  "before",
  "merge",
  "prefers",
  "user",
  "memory",
  "ran",
  "fact",
  "such",
  "or",
  "no",
  "app",
  "where",
  "who",
  "whom",
  "whose",
  "does",
  "did",
  "which",
  "when",
]);

/** R1's stop words: English function words and chat words (`lex.ts`). */
const R1_STOP = (
  "a about above after again against all am an and any are aren't as at be because been before being below between " +
  "both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from " +
  "further had hadn't has hasn't have haven't having he her here hers herself him himself his how i if in into is " +
  "isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our " +
  "ours ourselves out over own same shan't she should shouldn't so some such than that that's the their theirs them " +
  "themselves then there there's these they this those through to too under until up very was wasn't we were " +
  "weren't what what's when where which while who whom why with won't would wouldn't you your yours yourself " +
  "yourselves ok okay yes yeah yep sure thanks thank please just also get got getting need needs want wants like use " +
  "used using uses make makes way thing things something anything one two again still really now know tell show let " +
  "lets go going do done does doing did can could should would will may might im ive youre whats hows wheres whos " +
  "isnt dont doesnt cant here there than then us we our ours my me i you it its hey hi hello"
).split(" ");

/** The words BM25F never reads: R1's stop words and Eden's own (`STOP`). */
const TERM_STOP = new Set([...STOP, ...R1_STOP]);

/** A short code that names nothing (`a1b`), or a `neo4j`-like name: never a term, as it was never a needle. */
const SHORT_CODE = /^[a-z]\d[a-z]$|^[a-z]{3,}\d+[a-z]$/;

/** Whether a token is a term: 2 characters or more, no stop word, no number of 1–2 digits, no short code. */
function isTerm(token: string): boolean {
  return token.length >= 2 && !TERM_STOP.has(token) && !/^\d{1,2}$/.test(token) && !SHORT_CODE.test(token);
}

/** R1's token: a run of word characters and identifier punctuation, or one character. */
const R1_TOKEN = /[a-z0-9@~][a-z0-9_.\-/@:~*]*[a-z0-9*]|[a-z0-9]/g;

/** A row's text's terms (see the header), in order, repeats kept; `skip` holds words that are not the row's. */
export function textTerms(text: string, skip?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const add = (token: string) => {
    if (isTerm(token) && !skip?.has(token)) out.push(singular(token));
  };
  // An apostrophe parts words, as Eden's needles did ("Kai's" is "kai"); R1 joined them ("kais").
  for (const [token] of String(text ?? "")
    .toLowerCase()
    .matchAll(R1_TOKEN)) {
    const parts = token.split(/[^a-z0-9]+/).filter(Boolean);
    if (parts.length > 1) {
      add(token.replace(/[.:\-/]+$/, ""));
      for (const segment of token.split(/[/\-_:@~*]+/))
        if (/^[a-z0-9]+(?:\.[a-z0-9]+)+$/.test(segment) && segment !== token) add(segment);
    }
    for (const part of parts) add(part);
  }
  return out;
}

/** A prompt's terms (see the header): its words, a dotted name whole (`queryHay`). */
export function promptTerms(text: string): Set<string> {
  return cueTerms(queryHay(text));
}

/** Tokens a cue part already split (`cueTokens`), as terms. */
export function cueTerms(tokens: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const token of tokens) if (isTerm(token)) out.add(singular(token));
  return out;
}

/** A row's terms by field, stemmed, repeats kept (a term's frequency is its count). */
export type RowFields = Readonly<Record<Field, readonly string[]>>;

/**
 * A row's fields (see the header). A mined row's folder is where it is true, which the read set decides (A4 §2),
 * not what it is about: its text's folder words are not its needles. Its aliases are its tags that its text does not
 * hold (`writeAliasTags`' expansions), its keys' values and subjects come from its stored D7 keys (A4 §3.1).
 */
export function rowFields(rec: Pick<MemoryRecord, "text" | "tags" | "slots" | "cite" | "scope">): RowFields {
  const place = isCited(rec) ? new Set([...queryHay(rec.scope ?? ""), (rec.scope ?? "").toLowerCase()]) : undefined;
  const body = textTerms(rec.text, place);
  const own = new Set(body);
  const alias = (rec.tags ?? [])
    .map((tag) => String(tag).toLowerCase())
    .filter((tag) => /^[a-z0-9][a-z0-9.]*$/.test(tag) && isTerm(tag) && !place?.has(tag))
    .map(singular)
    .filter((tag) => !own.has(tag));
  const value: string[] = [];
  const subject: string[] = [];
  for (const key of rec.slots ?? []) {
    if (key.v) value.push(...textTerms(key.v));
    subject.push(...textTerms(slotLabel(key.k)));
  }
  return { value, subject, alias: [...new Set(alias)], body };
}

/** Every distinct term of a row, whatever its field: what the postings list it under. */
export function rowTerms(fields: RowFields): Set<string> {
  return new Set(FIELDS.flatMap((field) => fields[field]));
}

/** Whether the lexical path ranks a row at all (`UNTYPED_NEEDLES`). */
export function rankable(rec: Pick<MemoryRecord, "tags">, fields: RowFields): boolean {
  return !isUntyped(rec) || new Set(fields.body).size <= UNTYPED_NEEDLES;
}

/** The rows a reader sees, as BM25F reads them: their number, each field's mean length, and each term's df. */
export interface Corpus {
  n: number;
  avg: Readonly<Record<Field, number>>;
  df(term: string): number;
}

/** R1 / Robertson's IDF, never negative: `ln(1 + (N − df + 0.5) / (df + 0.5))`. */
export function idf(corpus: Corpus, term: string): number {
  const df = Math.min(corpus.df(term), corpus.n);
  return Math.log(1 + (corpus.n - df + 0.5) / (df + 0.5));
}

/**
 * One term's BM25F contribution to a row, as R1 scored it (`lex.ts`): its weighted frequency, each field's normalized
 * by that field's length against its mean (at least 1), saturated by k1. On R1's scale, so P4.3's τ can start at R1's
 * points (3.2, 4.1).
 */
export function termScore(term: string, fields: RowFields, corpus: Corpus): number {
  let weighted = 0;
  for (const field of FIELDS) {
    const terms = fields[field];
    let tf = 0;
    for (const t of terms) if (t === term) tf++;
    if (!tf) continue;
    weighted += (FIELD_WEIGHTS[field] * tf) / (1 - B + (B * terms.length) / Math.max(1, corpus.avg[field]));
  }
  return weighted ? (idf(corpus, term) * weighted) / (K1 + weighted) : 0;
}
