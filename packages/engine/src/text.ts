/**
 * Deterministic text analysis: the cue the partner builds from a session without a model. Everything here runs on
 * every event, so it must stay cheap (no I/O, linear in the text).
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her him his how i if in into " +
    "is it its just me my no not of on or our please she so some than that the their them then there these they " +
    "this to up us was we were what when where which who why will with would you your yes ok okay thanks thank hi " +
    "hello hey sure great cool also about after again all am any because before being both each few get got here " +
    "more most much need only other out over own same should still such too under until very want way well while"
  ).split(" "),
);

/** Lowercased word tokens, stopwords and one-character tokens removed. */
export function contentTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? []) {
    const t = raw.replace(/'s$/, "");
    if (t.length > 1 && !STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

/**
 * Named things a source might hold: emails, @handles, ticket-style ids (ABC-123), URLs, quoted phrases, and runs of
 * capitalised words not at a sentence start ("Dana Lee", "Acme Corp"). Recall over precision: a false entity costs
 * one wasted lookup, a missed one costs the injection.
 */
export function extractEntities(text: string): string[] {
  const found = new Set<string>();
  const add = (s: string | undefined) => {
    const v = s?.trim();
    if (v && v.length > 1 && v.length <= 80) found.add(v);
  };
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) add(m[0]);
  for (const m of text.matchAll(/(?:^|\s)@([A-Za-z0-9_][\w.-]{1,40})/g)) add(m[1]);
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g)) add(m[0]);
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) add(m[0]);
  for (const m of text.matchAll(/["“]([^"”\n]{3,60})["”]/g)) add(m[1]);
  // Capitalised runs. A run that starts a sentence counts only if it has two or more words.
  for (const m of text.matchAll(/(^|[.!?]\s+|\s)((?:[A-Z][\p{L}&'-]+)(?:\s+[A-Z][\p{L}&'-]+)*)/gu)) {
    const run = m[2]!;
    const sentenceStart = m[1] === "" || /[.!?]/.test(m[1]!);
    const words = run.split(/\s+/);
    if (words.length === 1 && (sentenceStart || STOPWORDS.has(run.toLowerCase()))) continue;
    add(run);
  }
  return [...found];
}

const CHATTER =
  /^(?:ok(?:ay)?|k|thanks?(?: you)?|thx|ty|cool|great|nice|perfect|got it|sounds good|yes|yep|no|nope|sure|lol|👍)[.! ]*$/i;

/** A message that carries no information need: an acknowledgement or a bare yes/no. */
export function isChatter(text: string): boolean {
  return CHATTER.test(text.trim()) || contentTerms(text).length === 0;
}
