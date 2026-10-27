/**
 * Deterministic text analysis: the cue the partner builds from a session without a model. Everything here runs on
 * every event, so it must stay cheap (no I/O, linear in the text). Terms come from the shared tokenizer
 * (`@eden/primitives`), so cue terms, cached items and usage tracking all agree on what a term is.
 */
import { tokenizeInto, type Vocab } from "@eden/primitives";

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her him his how i if in into " +
    "is it its just me my no not of on or our please she so some than that the their them then there these they " +
    "this to up us was we were what when where which who why will with would you your yes ok okay thanks thank hi " +
    "hello hey sure great cool also about after again all am any because before being both each few get got here " +
    "more most much need only other out over own same should still such too under until very want way well while"
  ).split(" "),
);

export function isStopword(term: string): boolean {
  return STOPWORDS.has(term);
}

let scratch = new Uint32Array(1_024);

/**
 * Term ids of `text` in `vocab` (shared tokenizer: folded, possessives and trailing punctuation trimmed, one-character
 * terms dropped), written to a reused buffer: valid until the next call. With `intern` false, unknown terms are
 * skipped. Returns the buffer and the count.
 */
export function termIds(text: string, vocab: Vocab, intern: boolean): { ids: Uint32Array; n: number } {
  if (scratch.length < text.length) scratch = new Uint32Array(Math.max(text.length, scratch.length * 2));
  const n = tokenizeInto(text, vocab, intern, scratch, null);
  return { ids: scratch, n };
}

/** Content terms of `text` (stopwords removed), as strings, in order. Interns new terms into `vocab`. */
export function contentTerms(text: string, vocab: Vocab): string[] {
  const { ids, n } = termIds(text, vocab, true);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = vocab.term(ids[i]!);
    if (!STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

/**
 * What kind of thing an entity is. Names, handles and ids may be persisted in the source map (they route lookups);
 * emails, URLs and quoted phrases are used for this lookup only, since they can carry content ("my biopsy results").
 */
export type EntityKind = "name" | "handle" | "id" | "email" | "url" | "quoted";

export interface Entity {
  text: string;
  kind: EntityKind;
}

/** Kinds safe to store in the content-free source map (D8). */
export const PERSISTABLE_KINDS: ReadonlySet<EntityKind> = new Set(["name", "handle", "id"]);

/**
 * Named things a source might hold: emails, @handles, ticket-style ids (ABC-123), URLs, quoted phrases, and runs of
 * capitalised words not at a sentence start ("Dana Lee", "Acme Corp"). Recall over precision: a false entity costs
 * one wasted lookup, a missed one costs the injection.
 */
export function extractTypedEntities(text: string): Entity[] {
  const found = new Map<string, Entity>();
  const add = (s: string | undefined, kind: EntityKind) => {
    const v = s?.trim();
    if (v && v.length > 1 && v.length <= 80 && !found.has(v)) found.set(v, { text: v, kind });
  };
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) add(m[0], "email");
  for (const m of text.matchAll(/(?:^|\s)@([A-Za-z0-9_][\w.-]{1,40})/g)) add(m[1], "handle");
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g)) add(m[0], "id");
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) add(m[0], "url");
  for (const m of text.matchAll(/["“]([^"”\n]{3,60})["”]/g)) add(m[1], "quoted");
  // Capitalised runs. A run that starts a sentence counts only if it has two or more words.
  for (const m of text.matchAll(/(^|[.!?]\s+|\s)((?:[A-Z][\p{L}&'-]+)(?:\s+[A-Z][\p{L}&'-]+)*)/gu)) {
    const run = m[2]!;
    const sentenceStart = m[1] === "" || /[.!?]/.test(m[1]!);
    const words = run.split(/\s+/);
    if (words.length === 1 && (sentenceStart || STOPWORDS.has(run.toLowerCase()))) continue;
    add(run, "name");
  }
  return [...found.values()];
}

export function extractEntities(text: string): string[] {
  return extractTypedEntities(text).map((e) => e.text);
}

const CHATTER =
  /^(?:ok(?:ay)?|k|thanks?(?: you)?|thx|ty|cool|great|nice|perfect|got it|sounds good|yes|yep|no|nope|sure|lol|👍)[.! ]*$/i;

/** A message that carries no information need: an acknowledgement or a bare yes/no. */
export function isChatter(text: string, vocab: Vocab): boolean {
  return CHATTER.test(text.trim()) || contentTerms(text, vocab).length === 0;
}
