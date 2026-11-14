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

/** Every stopword (for tests). */
export function stopwordList(): string[] {
  return [...STOPWORDS];
}

export function isStopword(term: string): boolean {
  return STOPWORDS.has(term);
}

/**
 * The stopwords by length and first code unit (all are ASCII and at most 8 letters), for `stopwordAt`: two or three
 * candidates a word, compared in place.
 */
const STOP_BUCKETS: string[][] = Array.from({ length: 9 * 128 }, () => []);
for (const w of STOPWORDS) STOP_BUCKETS[w.length * 128 + w.charCodeAt(0)]!.push(w);

/**
 * Marks of the stopwords' 32-bit FNV-1a hashes over their code units (`fnvOfWord`; `sketchTerms` hashes each word so
 * as it reads it), by the hash's low 12 bits. Equal words hash alike, so a word whose mark is clear is not a stopword
 * and `stopwordAt` runs only on a set one (about 4% of other words, D1911).
 */
export const STOP_FNV = new Uint8Array(4_096);
/** FNV-1a over a string's code units, as `sketchTerms` folds them (`Math.imul`, an int32). */
export function fnvOfWord(w: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 0x01000193);
  return h;
}
for (const w of STOPWORDS) STOP_FNV[fnvOfWord(w) & 4_095] = 1;

/** `isStopword(s.slice(start, end))`, with no string made (D1887). */
export function stopwordAt(s: string, start: number, end: number): boolean {
  const len = end - start;
  const c = s.charCodeAt(start);
  if (len > 8 || c >= 128) return false;
  for (const w of STOP_BUCKETS[len * 128 + c]!) if (s.startsWith(w, start)) return true;
  return false;
}

/** One code unit of `[\p{L}\p{N}]`: read alone, a unit outside the surrogates is the code point it is. */
const WORD_CHAR = /^[\p{L}\p{N}]$/u;

/**
 * Per code unit, whether it is a letter or a number (`\p{L}`, `\p{N}`): 1 it is, 2 it is not, 0 not read yet (or a
 * surrogate, never read). Filled as units are met (`readWordUnit`), once a process: content-free. Scans that read
 * words by code unit (`render.ts`'s `wordsIn`, `sketchTerms`) test `WORD_UNITS[c]` and call `readWordUnit` on a 0.
 */
export const WORD_UNITS = new Uint8Array(0x10000);

/**
 * The class of code unit `c` (`WORD_UNITS`), read and kept; 0 for a surrogate, whose pair a regex with the `u` flag
 * reads as one code point: the caller then reads the string by its regex instead.
 */
export function readWordUnit(c: number): number {
  if (c >= 0xd800 && c <= 0xdfff) return 0;
  const k = WORD_CHAR.test(String.fromCharCode(c)) ? 1 : 2;
  WORD_UNITS[c] = k;
  return k;
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

let stamps = new Uint32Array(4_096);
let tick = 0;

/**
 * Distinct term ids of `text` in `vocab`, in first-occurrence order, interning new terms; a fresh array. An event is
 * tokenized once and its usage check, memory, chatter test and cue share the result (each tokenized it again before:
 * concurrent.bench.ts profile, checkUsage and remember were 37% of CPU).
 */
export function distinctTermIds(text: string, vocab: Vocab): Uint32Array {
  const { ids, n } = termIds(text, vocab, true);
  if (stamps.length < vocab.size) stamps = new Uint32Array(Math.max(vocab.size, stamps.length * 2));
  if (++tick === 0xffffffff) {
    stamps.fill(0);
    tick = 1;
  }
  let m = 0;
  for (let i = 0; i < n; i++) {
    const id = ids[i]!;
    if (stamps[id] === tick) continue;
    stamps[id] = tick;
    ids[m++] = id;
  }
  return ids.slice(0, m);
}

/** The terms of `ids` that are not stopwords, as strings, in order. */
export function contentTermsOf(ids: ArrayLike<number>, vocab: Vocab): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const t = vocab.term(ids[i]!);
    if (!STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

/** Content terms of `text` (stopwords removed), as strings, in order. Interns new terms into `vocab`. */
export function contentTerms(text: string, vocab: Vocab): string[] {
  const { ids, n } = termIds(text, vocab, true);
  return contentTermsOf(ids.subarray(0, n), vocab);
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
 * Weekday and month names (lower-cased): capitalised, but dates, not entities. As one entity they matched every item
 * that names the day ("Sunday" in a yoga request found an invoice due on a Sunday) and earned the entity bonus.
 * Months and abbreviations that are also common names (April, May, June, August, Jan, Jun, Sun) stay entities:
 * missing a person costs more.
 */
const CALENDAR = new Set(
  (
    "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat " +
    "january february march july september october november december feb mar apr jul aug sep sept oct nov dec"
  ).split(" "),
);

/**
 * A capitalised word is a date: `Sunday`, `Sundays`, `Sunday's`, `Sunday-morning`, `SUNDAY`. Read by code unit
 * (D1886): the part before a hyphen, or the word less a possessive and a weekday's plural "s", then one look-up. Two
 * replaces and a split a word were a fifth of the sync's mention reading. `isCalendarByPattern` is the reading before.
 */
export function isCalendar(word: string): boolean {
  let end = word.indexOf("-");
  // A hyphen's head is the word's start whatever its end says: the two endings below hold no hyphen.
  if (end < 0) {
    end = word.length;
    // /['’]s$/i: an apostrophe and an "s" either case (an `i` regex with no `u` flag folds ASCII letters only).
    if (end >= 2 && (word.charCodeAt(end - 1) | 32) === 115) {
      const q = word.charCodeAt(end - 2);
      if (q === 39 || q === 0x2019) end -= 2;
    }
    // /(?<=day)s$/i on what is left: "Sundays".
    if (end >= 4 && (word.charCodeAt(end - 1) | 32) === 115 && (word.charCodeAt(end - 2) | 32) === 121) {
      if ((word.charCodeAt(end - 3) | 32) === 97 && (word.charCodeAt(end - 4) | 32) === 100) end -= 1;
    }
  }
  // Every name in `CALENDAR` is 3 to 9 letters, and lower-casing never shortens a string.
  if (end < 3 || end > 9) return false;
  return CALENDAR.has(word.slice(0, end).toLowerCase());
}

/** `isCalendar` as it read before D1886, for its differential test. */
export const isCalendarByPattern = (word: string) =>
  CALENDAR.has(
    word
      .replace(/['’]s$/i, "")
      .replace(/(?<=day)s$/i, "") // Plural weekdays ("on Sundays"); not months: "Mars" is no "Mar".
      .split("-")[0]!
      .toLowerCase(),
  );

/**
 * Named things a source might hold: emails, @handles, ticket-style ids (ABC-123), URLs, quoted phrases, and runs of
 * capitalised words not at a sentence start ("Dana Lee", "Acme Corp"). Recall over precision: a false entity costs
 * one wasted lookup, a missed one costs the injection. Weekday and month names are not entities (D37).
 */
export function extractTypedEntities(text: string): Entity[] {
  const found = new Map<string, Entity>();
  const add = (s: string | undefined, kind: EntityKind) => {
    const v = s?.trim();
    if (v && v.length > 1 && v.length <= 80 && !found.has(v)) found.set(v, { text: v, kind });
  };
  // Each pattern runs only where the text holds the character it cannot match without (D1886): an "@", a hyphen, a
  // link's "//", a quotation mark.
  const at = text.includes("@");
  if (at) for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) add(m[0], "email");
  if (at) for (const m of text.matchAll(/(?:^|\s)@([A-Za-z0-9_][\w.-]{1,40})/g)) add(m[1], "handle");
  if (text.includes("-")) for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g)) add(m[0], "id");
  if (text.includes("://")) for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) add(m[0], "url");
  if (text.includes('"') || text.includes("“")) {
    for (const m of text.matchAll(/["“]([^"”\n]{3,60})["”]/g)) add(m[1], "quoted");
  }
  // Capitalised runs. A run that starts a sentence counts only if it has two or more words.
  // Any capital letter starts a word, not only ASCII ones: "Łukasz", "Émile", "Ögmundur".
  for (const m of text.matchAll(/(^|[.!?]\s+|\s)((?:\p{Lu}[\p{L}&'-]+)(?:\s+\p{Lu}[\p{L}&'-]+)*)/gu)) {
    const sentenceStart = m[1] === "" || /[.!?]/.test(m[1]!);
    let words = m[2]!.split(/\s+/);
    // Dates around a name ("on Friday Dana Lee") are trimmed when a name of two or more words remains; a weekday
    // with one other word ("Sunday Times") may be the name itself, so it stays whole.
    let from = 0;
    let to = words.length;
    while (from < to && isCalendar(words[from]!)) from++;
    while (to > from && isCalendar(words[to - 1]!)) to--;
    if (to === from) continue; // Dates only ("Monday Tuesday").
    if (to - from >= 2) words = words.slice(from, to);
    const run = words.join(" ");
    if (words.length === 1 && (sentenceStart || STOPWORDS.has(run.toLowerCase()) || isCalendar(run))) continue;
    // A capitalised run of common words ("What We", "It Is") names nothing: its bonus would push any item holding
    // those words past the bar with no model's say (D6).
    if (words.every((w) => STOPWORDS.has(w.toLowerCase()))) continue;
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
  const { ids, n } = termIds(text, vocab, true);
  return isChatterTerms(text, ids.subarray(0, n), vocab);
}

/** As `isChatter`, given the text's term ids. */
export function isChatterTerms(text: string, ids: ArrayLike<number>, vocab: Vocab): boolean {
  if (CHATTER.test(text.trim())) return true;
  for (let i = 0; i < ids.length; i++) if (!STOPWORDS.has(vocab.term(ids[i]!))) return false;
  return true;
}

/**
 * The first `max` characters of `s`, cut so that redaction (which runs after the cut) still sees every secret whole:
 * the cut drops the whole run it would split, back to whitespace or JSON punctuation (" , { } [ ], which no token or
 * base64 body contains, so minified JSON keeps its head: half a JWT no longer looks like one), and a private key whose
 * END line falls past the cut is dropped from its BEGIN line (alone, the banner is all `redactPem` redacts).
 */
export function head(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  while (end > 0 && !isCutPoint(s.charCodeAt(end - 1))) end--;
  let out = s.slice(0, end);
  let begin = -1;
  for (const m of out.matchAll(PEM_BEGIN)) begin = m.index;
  if (begin >= 0 && !PEM_END.test(out.slice(begin))) out = out.slice(0, begin);
  return out;
}

/** Whitespace and the JSON punctuation " , [ ] { }. */
const isCutPoint = (c: number) => c <= 32 || c === 34 || c === 44 || c === 91 || c === 93 || c === 123 || c === 125;

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/gi;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/i;
