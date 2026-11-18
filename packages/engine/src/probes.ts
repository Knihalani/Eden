/**
 * Probes: the checks a request implies but does not ask for (docs/research/probes.md). A request to act ("set up
 * dinner with Jamie on Thursday at 19:00", "send Rose the Q3 report") is sent to sources as it is, and as a few short,
 * targeted queries besides:
 *
 * - its people, cleaned of the verb that starts the sentence ("Send Rose Kimura" is Rose Kimura);
 * - the organisation each person belongs to, read from the results for that person (an address at
 *   umbrellahealth.com and the name "Umbrella Health" in the same results): what is said about their organisation
 *   applies to them;
 * - its topic, the content words that are neither people, days nor the action;
 * - for an action on a named day (scheduling, accepting, booking), a listing of that day from sources that list by
 *   time: what is already there is what the action might clash with.
 *
 * And it adds a structural ground for delivery with no model: an event close to the time a scheduling request names,
 * on the day it names (a clash). Their finds get seats among the judge's candidates.
 * Nothing here calls a model; every probe is a source call, bounded per lookup (`probeCalls`).
 */
import type { ContextItem } from "@eden/protocol";
import { readWordUnit, WORD_UNITS } from "./text";

/**
 * Words that start a request without naming anything: imperatives and politeness. A capitalised run at a sentence
 * start keeps them ("Send Rose Kimura", "Ask Łukasz"); without them the run is the name.
 */
export const LEADING = new Set(
  (
    "please pls can could would will ask tell send email e-mail message text ping remind reply respond forward share " +
    "book schedule set arrange organise organize plan invite accept decline cancel move reschedule push offer order " +
    "buy get pay sign approve draft write call meet put add find check confirm give let make help chase follow " +
    "introduce update notify loop thank congratulate wish hi hey ok okay so and also then"
  ).split(" "),
);

/** A request's people as they would appear in a source: no leading imperative, no possessive. */
export function cleanEntities(entities: string[]): string[] {
  const out: string[] = [];
  for (const e of entities) {
    let words = e.trim().split(/\s+/);
    while (words.length > 1 && LEADING.has(words[0]!.toLowerCase())) words = words.slice(1);
    const v = words.join(" ").replace(/['’]s$/i, "");
    if (v.length > 1 && !LEADING.has(v.toLowerCase()) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** A request to do something: it starts with an imperative or a polite ask ("Send …", "Can you book …"). */
export const isAction = (raw: string) =>
  LEADING.has(
    raw
      .trim()
      .split(/\s+/)[0]!
      .toLowerCase()
      .replace(/[^a-z-]/g, ""),
  ) || isScheduling(raw);

/** Words that open a request without being its verb: a courtesy, an aside, a "can you". */
const OPENERS = new Set("please pls can could would will you hi hey ok okay so and also then".split(" "));

/**
 * A request in the imperative: its first word other than an opener (`OPENERS`) is a verb that acts ("Book a table…",
 * "Please give Dana access…", "can you send…"). Stricter than `isAction`, which also takes a scheduling word anywhere
 * ("a great book on negotiation"). Reads at most the first eight words.
 */
export function isImperative(raw: string, more?: ReadonlySet<string>): boolean {
  const words = raw.trim().split(/\s+/, 8);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!.toLowerCase().replace(/[^a-z-]/g, "");
    if (OPENERS.has(word)) continue;
    // "Can you tell me if the migration finished?" asks to be told, not for the migration: a question.
    const next = words[i + 1]?.toLowerCase().replace(/[^a-z]/g, "");
    if (TELL_ME.has(word) && (next === "me" || next === "us") && /\?\s*$/.test(raw)) return false;
    return LEADING.has(word) || more?.has(word) === true;
  }
  return false;
}

/** Words that open a reply or a remark, not a request (`isOpenRequest`). */
const REMARKS = new Set(
  "thanks thank thx cheers great nice cool perfect lovely yes yep yeah no nope sure sorry lol sounds looks seems".split(
    " ",
  ),
);
/** Words that open a question, with or without its question mark (`isOpenRequest`). */
const ASKING = new Set(
  (
    "what when where which who whom whose why how is are am was were do does did has have had should shall may " +
    "might must"
  ).split(" "),
);
/** Words that open a statement about something, not an instruction (`isOpenRequest`); apostrophes are stripped. */
const STATING = new Set(
  "i im ive ill we were weve it its the this that these those there theres my our your he she they a an".split(" "),
);
/** Openers that, followed by "you", make a polite request ("Can you tag v2.8.0 … ?"); else they open a question. */
const POLITE = new Set(["can", "could", "would", "will"]);
/** How much of a message `isOpenRequest` reads: its head for the words, its tail for a question mark. */
const OPEN_HEAD_CHARS = 400;

/**
 * `pushOpen` (O3, D702): a message that opens like an instruction whatever its verb. `isImperative` knows a closed
 * list of verbs, and users do not keep to it ("Cash in £3,000 of my Premium Bonds", "Top up Maya's dinner account",
 * "Reimburse Oskar the £180"): 132 of 768 hidden train requests open with a verb on no list. No verb can be
 * recognised without a list, so this reads what the message is not: at least four words, and its first word after
 * the openers ("please", "hey", "can you") is not a remark's ("Thanks, …"), a question's ("What …", "Is …"; "Will the
 * bonds cover it" too: a polite opener not followed by "you"), a statement's ("I think …", "The boiler …") or a
 * request to be told ("let me know …"). A question mark is allowed only on a polite ask ("Could you …?"). It errs
 * towards yes for anything else (a pasted log line passes): the candidates' own gate still decides the packet.
 * Bounded: it reads the first `OPEN_HEAD_CHARS` characters and the last few. `strict` (`pushIndirect`, D820) also
 * refuses log lines (`looksLogged`) and chatter openers (`CHATTER`); `minWords` is 2 for the request after an
 * indirect lead-in (`pushStart`).
 */
export function isOpenRequest(raw: string, strict = false, minWords = 4): boolean {
  const words = raw.slice(0, OPEN_HEAD_CHARS).trim().split(/\s+/, 12);
  if (words.length < minWords) return false;
  if (strict && looksLogged(raw)) return false;
  const clean = (w: string | undefined) => (w ?? "").toLowerCase().replace(/[^\p{L}-]/gu, "");
  let i = 0;
  let polite = false;
  while (i < words.length - 1 && i < 8 && OPENERS.has(clean(words[i]))) {
    // "Can you …", "Hey could you …": the opener asks for the thing. "Will the bonds cover …": it asks about it.
    if (POLITE.has(clean(words[i]))) {
      if (clean(words[i + 1]) !== "you") return false;
      polite = true;
    }
    i++;
  }
  const first = clean(words[i]);
  if (!first || REMARKS.has(first) || ASKING.has(first) || STATING.has(first)) return false;
  if (strict && STATING_STRICT.has(first)) return false;
  // A chatter opener ("Morning! Book the …", "haha ok …") makes a request only when a listed verb follows it.
  if (strict && (CHATTER.has(first) || LAUGH.test(first)))
    return isImperative(words.slice(i + 1).join(" "), MORE_VERBS);
  const next = clean(words[i + 1]);
  if (TELL_ME.has(first) && (next === "me" || next === "us")) return false;
  if (/\?\s*$/.test(raw.slice(-32))) return polite;
  return true;
}

/**
 * `pushIndirect` (P2, D820; in the default since D828): chatter openers a remark starts with beyond `REMARKS`
 * ("haha, …", "ugh …", "morning! …"), and contractions `isOpenRequest` reads as words once their apostrophe is
 * stripped ("I'd", "Let's", "we'd": statements or the indirect lead-ins `indirectRest` reads). Only with the switch.
 */
const CHATTER = new Set(
  (
    "anyway anyways ugh argh oh ah aw aww wow omg yay meh hmm hm morning evening afternoon night hello hiya brb " +
    "fyi btw fun good welcome congrats whew phew bro dude mate honestly seriously literally nothing ciao hola " +
    "bonjour salut hallo ola olá mamma qué que quoi comment wie warum cómo como dove perché happy"
  ).split(" "),
);
const STATING_STRICT = new Set("id lets wed youd theyd youre theyre youve theyve hes shes thats".split(" "));
/** Laughter and its spellings in a few languages ("hahaha", "lmaooo", "jajaja", "kkkk", "mdr"). */
const LAUGH =
  /^(?:(?:ha|he|ja|je|hi){2,}h?|ha|lo+l|lma+o+|ro+fl|k{3,}|mdr|xd+|ye+s+|he+y+|a+h+|o+h+|o+o+h+|ya+y+|wo+o+|wo+w+)$/;

/**
 * `pushIndirect` (D820): a pasted log line, not a request (`isOpenRequest`'s strict form). A level word in capitals,
 * a timestamp, an address, an HTTP request line, a traceback or exit code, or a message whose words are mostly
 * symbols and numbers (a third or more of them, amounts aside; the train requests reach 0.18).
 */
const LOG_LEVEL = /\b(?:ERROR|ERR!?|WARN(?:ING)?|INFO|DEBUG|FATAL|TRACE|CRITICAL|FAIL|PASS)\b/;
const LOG_MARK =
  /^\s*[\w.-]+:\s+(?:error|fatal|warning|panic)\b|^\s*(?:warning|error):\s|^\s*[\w.-]+:\s+\(\d+\)|^\s*(?:panic|fatal|error|e|w):\s|\b\w+\.(?:js|ts|py|go|rs|java|rb|c|cpp):\d+|\b\d+ failed, \d+ passed|\b[a-z]*error:\s|traceback|\bexception\b|\bexit code\b|\bstack ?trace\b|\b\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}|[ ]\d{2}:\d{2}:\d{2})|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b(?:get|post|put|patch|delete) \//i;
function looksLogged(raw: string): boolean {
  const head = raw.slice(0, OPEN_HEAD_CHARS);
  if (LOG_LEVEL.test(head) || LOG_MARK.test(head)) return true;
  const words = head.trim().split(/\s+/);
  const symbolic = words.filter((w) => {
    const t = w.replace(/[,.;!?]+$/, "");
    // Amounts, clock times and dates are a request's own symbols ("£180", "09:00", "4pm", "12/05", "2026-05-14").
    if (/^[£$€]?[\d,]+(?:\.\d+)?[kKmM]?$|^\d{1,2}(?::\d{2})?(?:am|pm)?$|^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/i.test(t))
      return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
    return /[\d:/=[\]_#{}()<>|\\]/.test(t);
  }).length;
  return words.length >= 4 && symbolic / words.length >= 0.3;
}

/**
 * `pushIndirect` (D820): lead-ins that turn an imperative into a need, a plan, a wish or a question about acting
 * ("I need to pay …", "We should move …", "I want you to book …", "Should I book …?", "Can I cancel …?", "Is it OK to
 * renew …?"). `isOpenRequest` reads them as statements or questions, so the push never started for them.
 */
const A = "(?:'|’)?";
const INDIRECT = new RegExp(
  "^(?:" +
    [
      // Needs, obligations and plans: "I need to …", "we've got to …", "I'm supposed to …", "gotta …".
      `(?:i|we)\\s+(?:really\\s+|probably\\s+|just\\s+)?(?:need|have|want|got|ought)\\s+to`,
      `(?:i|we)\\s+(?:really\\s+|probably\\s+)?(?:must|should)`,
      `(?:i|we)${A}(?:ve|\\s+have)\\s+(?:got|been\\s+meaning|decided)\\s+to`,
      `(?:i${A}m|i\\s+am|we${A}re|we\\s+are)\\s+(?:supposed|meant|going|due)\\s+to`,
      `(?:need|have|got)\\s+to|gotta|time\\s+to`,
      // Wishes: "I'd like to …", "would like to …", "would be good to …".
      `(?:(?:i|we)${A}d|(?:i|we)\\s+would|would)\\s+(?:like|love|prefer)\\s+to`,
      `(?:it${A}d|(?:it\\s+)?(?:would|might))\\s+be\\s+(?:good|great|nice|best|handy|helpful|useful|wise|worth)\\s+(?:to|if\\s+(?:you|we)\\s+could)`,
      // Hedges (P2 v4): "might be worth chasing …", "it'd help to …", "I'm planning to …", "should probably …".
      `(?:it\\s+)?might\\s+be\\s+(?:worth|a\\s+good\\s+idea\\s+to)|(?:we|you|i)?\\s*might\\s+want\\s+to`,
      `it(?:${A}d|\\s+would|\\s+might|\\s+could)\\s+help\\s+(?:to|if\\s+(?:you|we)\\s+could)`,
      `(?:i|we)(?:${A}ll|\\s+will)\\s+(?:probably\\s+)?(?:need|have)\\s+to`,
      `(?:i${A}m|i\\s+am|we${A}re|we\\s+are)\\s+(?:planning|hoping|thinking\\s+of)(?:\\s+to)?`,
      `i\\s+was\\s+thinking\\s+(?:of|(?:i|we)\\s+should)`,
      `(?:(?:i|we)\\s+)?should\\s+probably`,
      `someone\\s+should(?:\\s+probably)?|maybe\\s+(?:i|we)\\s+should|it${A}?s\\s+(?:probably\\s+)?time\\s+(?:we|i|to)`,
      `i${A}m\\s+wondering\\s+(?:whether|if)\\s+(?:i|we)\\s+should|would\\s+it\\s+make\\s+sense\\s+to`,
      `(?:do|would)\\s+you\\s+(?:think|reckon)\\s+(?:i|we)\\s+should|any\\s+idea\\s+if\\s+(?:i|we)\\s+could`,
      `let${A}s|let\\s+us`,
      // Questions about acting: "Should I …?", "Shall we …?", "Is it OK to …?", "Would it be fine to …?".
      `(?:should|shall|can|could|may)\\s+(?:i|we)`,
      `would\\s+it\\s+be\\s+(?:ok(?:ay)?|fine|possible|alright|all\\s+right|sensible|wise|better|worth)(?:\\s+to)?`,
      `is\\s+it\\s+(?:ok(?:ay)?|fine|alright|all\\s+right)\\s+to`,
      `(?:do\\s+you\\s+think|i\\s+think|i${A}m\\s+thinking|i\\s+reckon|maybe)\\s+(?:i|we)\\s+should`,
      // Asking the assistant: "I want you to …", "I'd love it if you could …", "I was wondering if you could …".
      `(?:i|we)(?:${A}d|\\s+would)\\s+(?:like|love|prefer)\\s+(?:it\\s+if\\s+)?you\\s+(?:to|could)`,
      `(?:i|we)\\s+(?:want|need)\\s+you\\s+to`,
      `i(?:${A}d|\\s+would)\\s+be\\s+grateful\\s+if\\s+you\\s+could`,
      `i\\s+was\\s+wondering\\s+if\\s+you\\s+could|any\\s+chance\\s+you\\s+could`,
    ].join("|") +
    ")\\s+",
  "i",
);
/** Verbs after a lead-in that think, say or wait rather than act ("I need to think …", "Let's see how …"). */
const NOT_ACTING = new Set(
  (
    "know think see say admit wonder believe feel understand remember hear learn be have look figure decide wait " +
    "sleep talk mention point note consider worry rest relax celebrate chat stay eat retire drink imagine bother " +
    "ignore disregard"
  ).split(" "),
);
/** Someday words: a lead-in followed by one is a resolution or a wish, not a request (P2 v4). */
const VAGUE =
  /\b(?:one day|some ?day|sometime(?! (?:this|next|today|tomorrow|tonight|before|on|by))|eventually|at some point|one of these (?:days|years)|more often|in (?:the )?future|in general|again sometime)\b/i;
/** Adverbs a lead-in may carry before its verb ("We should probably …"). */
const ADVERBS = new Set(
  "really probably maybe definitely just still also quickly actually perhaps finally even".split(" "),
);
/** A clause that holds an action back or tells the assistant something rather than asking it to act (review of v4). */
const HOLD_BACK = /^(?:not|n['’]t|never|don['’]?t|do not|hold off|wait)\b|^(?:tell|show|ask) (?:you|me)\b/i;
/** A date, a clock time, a weekday or an amount: a plan with one is a request, not a someday idea. */
const DATED =
  /[£$€]\s?\d|\b\d{1,2}(?::\d{2}|\/\d{1,2})\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2}\s?(?:am|pm)\b|\b(?:today|tomorrow|tonight|next week)\b/i;

/**
 * `pushIndirect` (P2, D820; in the default since D828): the request inside an indirect lead-in, verb first, with no
 * closing question mark ("Should I book the 7am flight to Leeds?" is "book the 7am flight to Leeds"), or null when the
 * message has no lead-in (after `OPENERS`), when what follows is under two words, or when its verb thinks or waits
 * (`NOT_ACTING`). The push then reads the request as its imperative: listed or opened as any other.
 */
export function indirectRest(raw: string): string | null {
  // The head decides; the text handed on is the message itself from where the lead-in ends, whole (review of D820:
  // a cut or rejoined copy would hide later lines from the lookup and split a secret before redaction).
  const head = raw.slice(0, OPEN_HEAD_CHARS);
  let at = head.length - head.trimStart().length;
  // Openers before the lead-in ("ok so I need to …", "hey, should we …"); a polite "can you" is not one here.
  for (let i = 0; i < 4; i++) {
    const m = /^([\p{L}]+)[,!]?\s+/u.exec(head.slice(at));
    if (!m || !OPENERS.has(m[1]!.toLowerCase()) || POLITE.has(m[1]!.toLowerCase())) break;
    at += m[0].length;
  }
  const lead = INDIRECT.exec(head.slice(at));
  if (!lead) return null;
  at += lead[0].length;
  // Adverbs a lead-in may carry before its verb ("We should probably …").
  for (let m = /^([\p{L}]+)\s+/u.exec(head.slice(at)); m && ADVERBS.has(m[1]!.toLowerCase());) {
    at += m[0].length;
    m = /^([\p{L}]+)\s+/u.exec(head.slice(at));
  }
  const words = head.slice(at).trim().split(/\s+/);
  if (words.length < 2) return null;
  if (NOT_ACTING.has(words[0]!.toLowerCase().replace(/[^\p{L}]/gu, ""))) return null;
  // A resolution or a someday idea is not a request (P2 v4): "I need to stop eating biscuits", "we should go to
  // Iceland one day", "I want to get fitter by spring". A date or an amount keeps it a request.
  const tail = head.slice(at);
  if (HOLD_BACK.test(tail.trimStart())) return null;
  // A habit to stop is a resolution ("I need to stop eating biscuits"); "stop paying for Netflix" is a request.
  if (
    /^(?:stop|quit)\s+(?:eating|drinking|smoking|snacking|biting|worrying|procrastinating|overthinking|scrolling)\b/i.test(
      tail,
    )
  )
    return null;
  if (!DATED.test(tail) && (VAGUE.test(tail) || /^(?:get|be|become|feel)\s+\p{L}+er\b/iu.test(tail))) return null;
  return raw.slice(at).replace(/\s*\?\s*$/, "");
}

/**
 * `pushIndirect` (P2 v4): where a request follows a first clause of context ("The boiler's making that noise again,
 * can you book Ferguson's for Tuesday?", "Mum's prescription runs out Sunday so please reorder it"): the offset of
 * the polite ask or lead-in after a clause break in the head, or -1.
 */
const CLAUSE_BREAK = /[,;:.!?\u2013\u2014]\s+(?:(?:so|and|but|then)\s+)?|\s-\s+/g;
const POLITE_ASK = /^(?:please|pls|can you|could you|would you|will you)\s/i;
function secondClause(raw: string): number {
  const head = raw.slice(0, OPEN_HEAD_CHARS);
  for (const m of head.matchAll(CLAUSE_BREAK)) {
    const at = m.index! + m[0].length;
    const tail = head.slice(at);
    // The polite ask's verb gets the lead-in's tests: "can you believe it?", "please ignore my last message" and
    // "can you hold off on booking" ask for nothing (review of v4).
    const ask = POLITE_ASK.exec(tail);
    if (ask) {
      const rest = tail.slice(ask[0].length).replace(/^please\s+/i, "");
      const verb = rest
        .split(/\s+/, 1)[0]!
        .toLowerCase()
        .replace(/[^\p{L}]/gu, "");
      if (verb && !NOT_ACTING.has(verb) && !HOLD_BACK.test(rest) && verb !== "be") return at;
    } else if (INDIRECT.test(tail) && indirectRest(tail) !== null) return at;
  }
  return -1;
}

/**
 * How a user message starts the push: "listed" (its verb is on a list: an acting request), "opened" (`pushOpen`'s
 * shape) or null. With `indirect` (`pushIndirect`, D820) an indirect lead-in is read as its imperative
 * (`indirectRest`, whose text is returned as `request`), a request after a first clause of context is read from where
 * it starts (`secondClause`), and `isOpenRequest` runs strict (no log lines, no chatter).
 */
export interface PushStart {
  how: "listed" | "opened";
  request: string;
  /** A listed start that is still no plan to act on — a question about an owned thing (D1980). */
  open?: boolean;
}

export function pushStart(raw: string, opts: { open: boolean; indirect: boolean }): PushStart | null {
  const first = pushStartOne(raw, opts);
  if (first || !opts.indirect) return first;
  const at = secondClause(raw);
  return at < 0 ? null : pushStartOne(raw.slice(at), opts);
}

/**
 * `pushIndirect` (P2 v4): a need for something to be done, with no verb first ("I'll need the Dublin hotel changed to a
 * king room", "We need the drawings signed off by Carl", "We could really use the delivery sorted"): read whole.
 */
/** Participles of a job done for the user (a list: "bed", "oven", "garden" end the same way, review of v4). */
const DONE =
  "(?:changed|signed|booked|sorted|sent|fixed|done|cancelled|canceled|moved|paid|renewed|updated|filed|forwarded|" +
  "scanned|checked|resubmitted|submitted|approved|arranged|ordered|reordered|replaced|repaired|serviced|cleaned|" +
  "rebooked|transferred|refunded|returned|posted|printed|delivered|collected|confirmed|reviewed|merged|deployed|" +
  "scheduled|rescheduled|finished|completed|organised|organized|handled|written|shipped|looked\\s+at|set\\s+up)";
const PASSIVE_NEED = new RegExp(
  `^(?:i|we)(?:${A}ll|\\s+will|${A}d|\\s+would)?\\s+(?:really\\s+)?(?:need|want|like|could\\s+(?:really\\s+)?(?:use|do\\s+with))` +
    `\\s+(?:the|my|our|his|her|their|a|an)\\s+[^,.;!?]{2,80}?\\s+${DONE}\\b`,
  "iu",
);

/**
 * A question asking for a thing of the user's own (D1980): "When is my physio appointment?", "Where is my
 * passport?" The open shape reads it as a question and starts nothing, but the lookup is the same work — the
 * candidates' own gate decides whether anything goes. A wh-word about a thing it owns ("my", "our"), and not a
 * fact of the world's ("What is the capital of Australia?") nor about something not theirs ("When is the office
 * party?").
 */
export const ASKS_OWN = /^(?:when|where|what\s+(?:time|day|date)\b|how\s+(?:much|many)\b)\b[^.,;!?]*\b(?:my|our)\b/i;

/**
 * A question asking who a pronoun means (D1981): "Who is he again?", "Who's she?". It names nobody — the person
 * it asks about is the one the last request named (its `carry` is in `partner.ts`).
 */
export const ASKS_WHO = /\bwho\s+(?:is|was|'s|are|were)\s+(?:he|she|they|him|her|them|that|this)\b/i;

function pushStartOne(raw: string, opts: { open: boolean; indirect: boolean }): PushStart | null {
  if (isImperative(raw, MORE_VERBS)) return { how: "listed", request: raw };
  // An own-thing question is a request the lists know, not a shape the open gate guesses at: `listed` keeps it
  // through the turn gate, whose "opened" score a question never reaches. `open` keeps the question out of plan
  // alerts: no plan was made by asking about one.
  if (opts.open && ASKS_OWN.test(raw)) return { how: "listed", request: raw, open: true };
  if (opts.indirect && opts.open && PASSIVE_NEED.test(raw.slice(0, OPEN_HEAD_CHARS)))
    return { how: "opened", request: raw };
  const rest = opts.indirect ? indirectRest(raw) : null;
  if (rest !== null) {
    if (isImperative(rest, MORE_VERBS)) return { how: "listed", request: rest };
    // The lead-in is the request's frame; what follows is read as the open shape reads a message's head.
    // Two words are enough here: the lead-in already made it a request ("Let's cash in the bonds").
    if (opts.open && isOpenRequest(rest, true, 2)) return { how: "opened", request: rest };
    return null;
  }
  return opts.open && isOpenRequest(raw, opts.indirect) ? { how: "opened", request: raw } : null;
}

/**
 * `conflictVocab` (D75): more verbs that open a request to act, beside `LEADING` (which also cleans names, so it
 * is not widened): moving money, renewing, raising, reserving, granting or removing, releasing.
 */
export const MORE_VERBS: ReadonlySet<string> = new Set(
  (
    "pick transfer wire refund raise renew reserve grant revoke remove delete submit file upload deploy release " +
    "launch publish post bring lend return sell rent hire issue sponsor donate subscribe cover"
  ).split(" "),
);

/** Verbs that, with "me" and a question mark, ask to be told something ("let me know", "show me", "tell me"). */
const TELL_ME = new Set(["tell", "let", "show", "remind"]);

/** A request that puts something in the calendar or commits the user's time. */
const SCHEDULING =
  /\b(schedul\w*|set up|setup|arrange|organi[sz]e|book|invite|accept|put .* (diary|calendar)|block|hold|meet(ing)?|dinner|lunch|breakfast|coffee|drinks|call|workshop|session|1:1|appointment|visit|trip|flight|travel)\b/i;
export const isScheduling = (raw: string) => SCHEDULING.test(raw);

/**
 * The time of day a request names, as a range in minutes from midnight: "at 19:00", "7pm", "10:00", "8am" are that
 * time ±3 h (an event's end is rarely known: a 07:10 flight clashes with a 10:00 workshop); "morning", "afternoon",
 * "evening", "night" their part of the day. Null when it names none.
 */
export function requestedRange(raw: string): { from: number; to: number } | null {
  const t = raw.toLowerCase();
  const m =
    /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t) ?? /\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t);
  if (m) {
    let h = Number(m[1]) % 24;
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    const at = h * 60 + Number(m[2] ?? 0);
    return { from: at - 180, to: at + 180 };
  }
  if (/\bmorning\b/.test(t)) return { from: 6 * 60, to: 12 * 60 };
  if (/\bafternoon\b/.test(t)) return { from: 12 * 60, to: 18 * 60 };
  if (/\b(evening|tonight|night)\b/.test(t)) return { from: 17 * 60, to: 23 * 60 + 59 };
  return null;
}

/**
 * The time a request asks to fill, in minutes from midnight: a range it states ("3–5pm", "15:00-17:00", "from 2 to
 * 4pm") as it is, a single time ("dinner at 19:00") as the 90 minutes from it, a part of the day as that part. Null
 * when it names no time. A clash is an event overlapping this (`overlaps`), not one merely near it.
 */
export function requestedSpan(raw: string): { from: number; to: number } | null {
  // Whitespace collapsed first, and a request's head is where its time is: the patterns below then never rescan a
  // long run (a digit before thousands of spaces was quadratic).
  const t = raw.slice(0, 2_000).toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ");
  const clock = (h: string, m: string | undefined, half: string | undefined) => {
    let hour = Number(h) % 24;
    if (half === "pm" && hour < 12) hour += 12;
    if (half === "am" && hour === 12) hour = 0;
    return hour * 60 + Number(m ?? 0);
  };
  // A stated range, the first one that is a time ("6-9 nov" is a date): a meridiem written once ("3-5pm") holds for
  // both ends, unless that would start it after it ends ("11-1pm" is 11 in the morning to 1).
  for (const r of t.matchAll(
    /\b(?:from |between )?(\d{1,2})(?::(\d{2}))? ?(am|pm)? ?(?:-|to|and|until) ?(\d{1,2})(?::(\d{2}))? ?(am|pm)?\b/g,
  )) {
    if (!(r[3] || r[6] || r[2] || r[5])) continue;
    let from = clock(r[1]!, r[2], r[3] ?? r[6]);
    const to = clock(r[4]!, r[5], r[6] ?? r[3]);
    if (!r[3] && r[6] === "pm" && from >= to) from = clock(r[1]!, r[2], "am");
    if (to > from && to - from <= 12 * 60) return { from, to };
  }
  const one =
    /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t) ?? /\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t);
  if (one) {
    const at = clock(one[1]!, one[2], one[3]);
    return { from: at, to: at + 90 };
  }
  // A bare hour after "at" ("the barbecue at 1", "dinner at 7"): one to seven is the afternoon or evening.
  const bare = /\bat\s+(\d{1,2})\b(?![:.\d%])/.exec(t);
  if (bare && Number(bare[1]) >= 1 && Number(bare[1]) <= 12) {
    const h = Number(bare[1]);
    const at = (h <= 7 ? h + 12 : h) * 60;
    return { from: at, to: at + 90 };
  }
  if (/\bmorning\b/.test(t)) return { from: 6 * 60, to: 12 * 60 };
  if (/\bafternoon\b/.test(t)) return { from: 12 * 60, to: 18 * 60 };
  if (/\b(evening|tonight|night)\b/.test(t)) return { from: 17 * 60, to: 23 * 60 + 59 };
  return null;
}

/** A clock time in text: `HH:MM`, optionally with an am/pm marker ("4:15pm", "4:15 p.m."). */
const CLOCK = /\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*([ap])\.?m\.?)?/gi;

/** Minutes from midnight a clock match means: a pm hour under 12 gets twelve added, a 12am hour none. */
const clockOf = (m: RegExpExecArray | RegExpMatchArray): number => {
  let t = Number(m[1]) * 60 + Number(m[2]);
  const ap = m[3]?.toLowerCase();
  if (ap === "p" && Number(m[1]) < 12) t += 12 * 60;
  if (ap === "a" && Number(m[1]) === 12) t -= 12 * 60;
  return t;
};

/**
 * Minutes from midnight an event ends: the first time its title or text gives after its start ("10:00–11:30",
 * "departs 07:10, arrives 10:35"), within twelve hours; else an hour after it starts.
 */
export function endMinutes(item: ContextItem, start: number): number {
  for (const m of `${item.title} ${item.text}`.matchAll(CLOCK)) {
    const t = clockOf(m);
    if (t > start && t - start <= 12 * 60) return t;
  }
  return start + 60;
}

/** Whether an event starting at `start` overlaps the span (an hour long when its end is not stated). */
export function overlaps(item: ContextItem, start: number, span: { from: number; to: number }): boolean {
  return start < span.to && endMinutes(item, start) > span.from;
}

/** Verbs of a request about an event that already exists. */
const ABOUT_EXISTING = /\b(confirm|cancel|move|reschedul\w*|push|postpone|remind|attend|still on|what time)\b/i;
/** Verbs of a request that makes something new in the calendar: then no existing event is its subject. */
const MAKES_NEW = /\b(book|schedule|set up|arrange|add|fit in|put in|block|invite|organi[sz]e)\b/i;

/**
 * Whether an event is the thing the request is about rather than something in its way: it shares a distinctive word
 * with the request ("confirm my dentist appointment" and "Dental check-up": the same first four letters, words of
 * five letters or more that are neither scheduling words nor times). Confirming an appointment is not a clash with it.
 */
/** Recurrence adjectives that say how often, not what (as their 4-letter stems): "my annual physio" is not
 * "Annual boiler inspection", but a modifier-only match still counts when the request names nothing the item
 * lacks — "my weekly call" and "Weekly call". */
const MODIFIER_STEMS = new Set(
  ["annual", "yearly", "monthly", "weekly", "daily", "quarterly", "regular"].map((w) => w.slice(0, 4)),
);

export function isSubject(item: ContextItem, raw: string): boolean {
  // Only a request about something already in the calendar has one there; "block", "book" or "set up" make a new
  // one. A wh-question about the user's own thing ("When is my physio appointment?") is one too (D1980).
  if ((!ABOUT_EXISTING.test(raw) && !ASKS_OWN.test(raw)) || MAKES_NEW.test(raw)) return false;
  const stems = (text: string) =>
    new Set(
      (text.toLowerCase().match(/[\p{L}]{5,}/gu) ?? [])
        .filter((w) => !SCHEDULING.test(w) && !TIMEISH.test(w) && !LEADING.has(w))
        .map((w) => w.slice(0, 4)),
    );
  const asked = stems(raw);
  const own = stems(item.title);
  const shared = [...own].filter((x) => asked.has(x));
  if (shared.length === 0) return false;
  if (shared.some((x) => !MODIFIER_STEMS.has(x))) return true;
  // Only recurrence words met ("annual" … "annu"): stems can no longer tell the thing apart — the words the
  // filters dropped are the ones that name it ("my weekly call" and "Weekly call" share "call"; "Weekly lunch"
  // shares only "weekly"). The subject it is when an unfiltered word of four letters or more meets too.
  const plain = (text: string) =>
    new Set((text.toLowerCase().match(/[\p{L}]{4,}/gu) ?? []).filter((w) => !MODIFIER_STEMS.has(w.slice(0, 4))));
  const said = plain(raw);
  // But a modifier-only match fails when the request names a thing of its own the item lacks: "my annual physio
  // appointment" is not "Annual boiler appointment" — "physio" never met, "appointment" names nothing.
  const content = [...said].filter(
    (w) => !SCHEDULING.test(w) && !TIMEISH.test(w) && !LEADING.has(w) && !GENERIC.has(w) && !QUESTIONISH.has(w),
  );
  const itemWords = plain(item.title);
  if (content.some((w) => !itemWords.has(w) && ![...itemWords].some((t) => t.startsWith(w) || w.startsWith(t))))
    return false;
  return [...itemWords].some((w) => said.has(w));
}

/** Minutes from midnight an item starts at, in its own offset; null without a timed `meta.start`. */
export function startMinutes(item: ContextItem): number | null {
  const m = /T(\d{2}):(\d{2})/.exec(item.meta?.start ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes of the first clock time an item's own text writes ("Thursday 16:15-17:00"), when `meta.start`
 * gives none (D1979). */
export function textMinutes(item: ContextItem): number | null {
  const m = new RegExp(CLOCK.source, "i").exec(`${item.title} ${item.text}`);
  return m ? clockOf(m) : null;
}

/**
 * Words of a request that carry its topic: not a person's, not a day's, not the action's. "Send Rose Kimura the Q3
 * report" is "q3 report"; "Offer Globex 15% off so we can close their renewal this week" is "15 off close renewal".
 * At most `max` words, in the request's order: an all-words search finds nothing for a longer one.
 */
export function topicOf(terms: string[], entities: string[], max = 2): string {
  const named = new Set(entities.flatMap((e) => e.toLowerCase().split(/\s+/)));
  const out = terms.filter(
    (w) => !named.has(w) && !LEADING.has(w) && !TIMEISH.test(w) && !GENERIC.has(w) && w.length > 1 && !/['’]/.test(w),
  );
  return out.slice(0, max).join(" ");
}

const TIMEISH =
  /^(today|tonight|tomorrow|yesterday|week|weekend|next|this|last|morning|afternoon|evening|night|am|pm|\d{1,2}(:\d\d)?(am|pm)?|(mon|tues|wednes|thurs|fri|satur|sun)day|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|\d{1,2}(st|nd|rd|th))$/;
/** Words too common in requests to search on. */
const GENERIC = new Set(
  "me my our us we you your them their they it its need want like know new".split(" "),
);
/** Question words and fillers that name nothing (kept beside GENERIC: topicOf already reads that set). */
const QUESTIONISH = new Set(
  "when where what who whom whose which how why again exactly about still right just very".split(" "),
);

/**
 * The organisations the people of a request belong to, read from items returned for them: an address of theirs at a
 * domain, and a name in the same items whose letters are the domain's label ("Umbrella Health" for
 * umbrellahealth.com). Free-mail domains name no organisation.
 */
export function orgsOf(people: string[], items: ContextItem[]): string[] {
  const out: string[] = [];
  // Each item's addresses, read once for all the request's people.
  const found = items.map((it) => addresses(`${it.text}\n${it.meta?.people ?? ""}`));
  for (const person of people) {
    const words = person.toLowerCase().split(/\s+/);
    const labels = new Set<string>();
    for (const list of found) {
      for (const { near, local, label } of list) {
        if (!words.every((w) => near.includes(w) || local.includes(w))) continue;
        if (!FREE_MAIL.has(label)) labels.add(label);
      }
    }
    if (labels.size === 0) continue;
    for (const it of items) {
      for (const m of `${it.title}. ${it.text}`.matchAll(/\b([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})\b/g)) {
        const squashed = m[1]!.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (squashed.length >= 4 && labels.has(squashed) && !out.includes(m[1]!)) out.push(m[1]!);
      }
    }
  }
  return out;
}

/** An address and the words before it ("Dana Lee <dana@umbrellahealth.com>"); one `exec` of it reads one address. */
const ADDRESS = /([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)*)?\s*<?([\w.+-]+)@([\w-]+)\.[\w.-]+/;
/** Characters read before an "@" for the words beside an address. */
const NEAR_MAX = 512;

/** `\s` in a JavaScript regex: what `ADDRESS` lets stand between the words before an address. */
function isSpace(c: number): boolean {
  return (
    (c >= 9 && c <= 13) ||
    c === 32 ||
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

/** `\w` without the `u` flag: ASCII letters, digits and the underscore. */
function isWord(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/** A character an `ADDRESS` match may hold before its "@": words, `.'-+<` and spacing. */
function beforeAt(c: number): boolean {
  return isWord(c) || c === 46 || c === 39 || c === 45 || c === 43 || c === 60 || isSpace(c);
}

/**
 * The addresses in `hay`, each with the words before it and its domain's first label, lowercased: what a global
 * `ADDRESS` scan finds, in linear time. The global scan tried every position of a run of words with no address at
 * its end, each reading to the end of the run: quadratic, ~250 ms for an 8 KB item of words ending in "x@nodot"
 * (connector text is untrusted). Every match holds exactly one "@", and from its start to that "@" only characters
 * `beforeAt` allows, so the regex is run once per "@" that can match, on that run (at most `NEAR_MAX` before it) and
 * the domain after it, starting no earlier than the previous match's end: the same matches, except that words further
 * than `NEAR_MAX` before an address are not read as beside it.
 */
export function addresses(hay: string): { near: string; local: string; label: string }[] {
  const out: { near: string; local: string; label: string }[] = [];
  let last = 0;
  for (let at = hay.indexOf("@"); at >= 0; at = hay.indexOf("@", at + 1)) {
    if (at < last) continue;
    // No match without a local part's character before the "@" and a `[\w-]+\.[\w.-]` after it: checked first, since
    // the regex reads each start's every split before failing (cubic in the run: 60 ms for 8 KB of "a" then "@").
    const before = at > last ? hay.charCodeAt(at - 1) : -1;
    if (!(isWord(before) || before === 46 || before === 43 || before === 45)) continue;
    let dot = at + 1;
    while (dot < hay.length && (isWord(hay.charCodeAt(dot)) || hay.charCodeAt(dot) === 45)) dot++;
    const after = hay.charCodeAt(dot + 1);
    if (dot === at + 1 || hay.charCodeAt(dot) !== 46 || !(isWord(after) || after === 46 || after === 45)) continue;
    const floor = Math.max(last, at - NEAR_MAX);
    let start = at;
    while (start > floor && beforeAt(hay.charCodeAt(start - 1))) start--;
    // The domain's `[\w.-]+` tail, whole: the match's end is where the next one may start.
    let end = dot + 1;
    while (end < hay.length) {
      const c = hay.charCodeAt(end);
      if (!isWord(c) && c !== 46 && c !== 45) break;
      end++;
    }
    const m = ADDRESS.exec(hay.slice(start, end));
    if (!m) continue;
    last = start + m.index + m[0].length;
    out.push({ near: (m[1] ?? "").toLowerCase(), local: m[2]!.toLowerCase(), label: m[3]!.toLowerCase() });
  }
  return out;
}

const FREE_MAIL = new Set(
  "gmail googlemail icloud me mac outlook hotmail live msn yahoo aol proton protonmail hey fastmail gmx yandex".split(
    " ",
  ),
);

/**
 * Phrases saying a matter stands as the user would expect: the plan holds, the issue is closed. Not "already done"
 * ("already paid" changes what to do: do not pay twice), not a return ("back from leave on Monday" says away until
 * then), and not when negated ("not resolved").
 */
const SETTLED =
  /\b(as usual|as planned|as normal|as agreed|as before|no changes?|unchanged|nothing (has )?changed|still (on|valid|in place|the same|going ahead)|all clear|(is|are|now|it's) clear to|good to go|(?:you|we) can go ahead|(?:you're|you are) clear to go ahead|resolved|sorted( out)?)\b/i;
/** `SETTLED` for `matchAll`, built once: `matchAll` scans a copy, so this one's `lastIndex` stays 0. */
const SETTLED_ALL = new RegExp(SETTLED.source, "gi");
const NEGATED =
  /\b(not|n't|never|no longer|isn't|hasn't|wasn't|yet to be|nothing (?:is|has been|was|got))\s+(\w+\s+)?$/i;

/**
 * Whether an item only confirms that things stand as expected (`SETTLED`, not negated): with no model to judge, such
 * an item is not pushed unasked, since it changes nothing the agent would do (`quietSettled`).
 */
export function settled(item: ContextItem): boolean {
  const text = `${item.title}. ${item.text}`;
  for (const m of text.matchAll(SETTLED_ALL)) {
    if (NEGATED.test(text.slice(Math.max(0, m.index! - 24), m.index!))) continue;
    // Asked, not said: the sentence it is in ends with a question mark ("Is this resolved?").
    const end = text.slice(m.index!).search(/[.!?\n]/);
    if (end >= 0 && text[m.index! + end] === "?") continue;
    return true;
  }
  return false;
}

/** Words saying someone is not there: on leave, away, out of office, unavailable. */
// "Away" only as a person's ("is away", "I'm away", "away on Skye", "away until"); "right away" and "throw away" are
// not.
const ABSENT =
  /\b((?:is|am|are|i'm|im|we're|he's|she's|they're|be|been|being)\s+away|away\s+(?:on|from|until|till|through|for|in|at|between)|on leave|annual leave|parental leave|maternity leave|paternity leave|sick leave|compassionate leave|out of (the )?office|ooo|on holiday|on vacation|off sick|off work|unavailable|not available)\b/i;
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SEP = "\\s*(?:-|–|—|to|until|till|through|and)\\s*";
const DAYS_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?${SEP}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`);
const DATE_TO_DATE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}${SEP}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`,
);
const MONTH_DAYS = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?${SEP}(\\d{1,2})\\b`);
const UNTIL_DATE = new RegExp(
  `\\b(until|till|through|thru|back(?: on)?|returning(?: on)?)\\s+(?:\\w+day,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`,
);
const ONE_DATE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`);
/** `ONE_DATE` for `matchAll`, built once: `matchAll` scans a copy, so this one's `lastIndex` stays 0. */
const DATES_ALL = new RegExp(ONE_DATE.source, "g");

/**
 * The days an item says someone is away, as ISO dates from and to (inclusive), read from the dates written near its
 * absence words ("away on Skye 6–9 Nov", "on leave from 2 Nov to 6 Nov", "out of office until 9 November", "back on
 * 9 Nov"); the year is the one that puts the date nearest after `now` less two months. Null when the item says no one
 * is away or gives no date for it.
 */
export function absenceSpan(item: ContextItem, now: number): { from: string; to: string } | null {
  const text = `${item.title}. ${item.text}`;
  const m = ABSENT.exec(text);
  if (!m) return null;
  // Dates after the absence words first ("unavailable for calls 20 Nov"), then just before them ("6–9 Nov: away").
  const after = text.slice(m.index, m.index + m[0].length + 120).toLowerCase();
  const before = text.slice(Math.max(0, m.index - 60), m.index + m[0].length).toLowerCase();
  const today = new Date(now).toISOString().slice(0, 10);
  const iso = (day: number, month: string) => {
    const mi = MONTHS.indexOf(month.slice(0, 3));
    if (mi < 0 || day < 1 || day > 31) return null;
    const base = new Date(now);
    for (const year of [base.getUTCFullYear() - 1, base.getUTCFullYear(), base.getUTCFullYear() + 1]) {
      const d = new Date(Date.UTC(year, mi, day));
      if (d.getTime() >= now - 60 * 86_400_000 && d.getTime() <= now + 300 * 86_400_000) {
        return d.toISOString().slice(0, 10);
      }
    }
    return null;
  };
  const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);
  const span = (from: string | null, to: string | null) => (from && to && from <= to ? { from, to } : null);
  const read = (near: string): { from: string; to: string } | null => {
    let r: RegExpExecArray | null;
    // "6–9 Nov"
    if ((r = DAYS_MONTH.exec(near))) {
      return span(iso(Number(r[1]), r[3]!), iso(Number(r[2]), r[3]!));
    }
    // "2 Nov to 6 Nov", "30 Oct – 2 Nov"
    if ((r = DATE_TO_DATE.exec(near))) {
      return span(iso(Number(r[1]), r[2]!), iso(Number(r[3]), r[4]!));
    }
    // "Nov 6–9"
    if ((r = MONTH_DAYS.exec(near))) {
      return span(iso(Number(r[2]), r[1]!), iso(Number(r[3]), r[1]!));
    }
    // "until 9 November", "back on 9 Nov" (away until the day before)
    if ((r = UNTIL_DATE.exec(near))) {
      const d = iso(Number(r[2]), r[3]!);
      return d ? span(today, r[1]!.startsWith("back") || r[1]!.startsWith("return") ? dayBefore(d) : d) : null;
    }
    // One date: that day.
    if ((r = ONE_DATE.exec(near))) {
      const d = iso(Number(r[1]), r[2]!);
      return span(d, d);
    }
    return null;
  };
  return read(after) ?? read(before);
}

/**
 * Whether a request's person (a name of one or more words) is named in an item, whole words, any case. The reference
 * for `mentionsAny`, which the partner calls (`opt-round3.test.ts` fuzzes the two).
 */
export function mentions(name: string, item: ContextItem): boolean {
  const hay = ` ${`${item.title} ${item.text} ${item.meta?.people ?? ""}`.toLowerCase().replace(/[^\p{L}\p{N}@.]+/gu, " ")} `;
  const words = name
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  return words.length > 0 && words.every((w) => hay.includes(` ${w} `));
}

/**
 * Each name's words as `mentions` reads them (lowercased, of two characters or more), names with none left out:
 * read once per request, for `mentionsAny`.
 */
export function mentionWords(names: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const name of names) {
    const words = name
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);
    if (words.length > 0) out.push(words);
  }
  return out;
}

/**
 * `names.some((n) => mentions(n, item))` for `words = mentionWords(names)`, with the item's text read once rather than
 * once per name, by a code-unit pass (D1920): building it was most of `mentions`' cost (12 µs a call on the pipeline
 * bench).
 */
export function mentionsAny(words: readonly (readonly string[])[], item: ContextItem): boolean {
  if (words.length === 0) return false;
  const lower = `${item.title} ${item.text} ${item.meta?.people ?? ""}`.toLowerCase();
  // A string with a surrogate is read through `mentionText`'s regex, which reads a pair as one code point.
  if (HAS_SURROGATE.test(lower) || words.some((ws) => ws.some((w) => HAS_SURROGATE.test(w)))) {
    return mentionsAnyByText(words, lower);
  }
  return words.some((ws) => ws.every((w) => mentionedIn(lower, w)));
}

/** `mentionsAny` as D1920 read it: the item's text with every run of other characters made one space, then searched. */
export function mentionsAnyByText(words: readonly (readonly string[])[], lower: string): boolean {
  const hay = ` ${mentionText(lower)} `;
  return words.some((ws) => ws.every((w) => hay.includes(` ${w} `)));
}

const HAS_SURROGATE = /[\uD800-\uDFFF]/;

/** Whether code unit `c` is one `mentionText` keeps (a letter, a digit, "@" or "."), for a string with no surrogate. */
function keeps(c: number): boolean {
  if (c === 64 || c === 46) return true;
  const k = WORD_UNITS[c]!;
  return (k !== 0 ? k : readWordUnit(c)) === 1;
}

/**
 * `` ` ${mentionText(lower)} `.includes(` ${w} `) `` with no copy of the text (D1934), for `lower` and `w` with no
 * surrogate: `mentionText` turns each run of characters it does not keep into one space, so ` w ` is in it exactly
 * when `w` is all kept characters and occurs in `lower` with no kept character either side.
 */
function mentionedIn(lower: string, w: string): boolean {
  // An empty word (never one of `mentionWords`') is in the padded text where it holds two spaces in a row.
  if (w.length === 0) return ` ${mentionText(lower)} `.includes("  ");
  // A word holding a character the text drops (a space inside a phrase; `mentionWords` never gives one) is read as
  // the reference reads it, on the copy, so a later caller passing phrases is answered alike (D1934's review).
  for (let i = 0; i < w.length; i++) if (!keeps(w.charCodeAt(i))) return ` ${mentionText(lower)} `.includes(` ${w} `);
  let i = lower.indexOf(w);
  while (i >= 0) {
    const end = i + w.length;
    if ((i === 0 || !keeps(lower.charCodeAt(i - 1))) && (end === lower.length || !keeps(lower.charCodeAt(end)))) {
      return true;
    }
    i = lower.indexOf(w, i + 1);
  }
  return false;
}

const NOT_MENTION_CHARS = /[^\p{L}\p{N}@.]+/gu;

/**
 * `lower.replace(/[^\p{L}\p{N}@.]+/gu, " ")` by one pass over the code units (`WORD_UNITS`, D1881): a run of other
 * characters becomes one space, and a lone space, the usual run, is kept without copying. A string with a surrogate
 * goes to the regex, which reads a pair as one code point.
 */
export function mentionText(lower: string): string {
  let out = "";
  let from = 0;
  const n = lower.length;
  for (let i = 0; i < n;) {
    let c = lower.charCodeAt(i);
    let k = WORD_UNITS[c]!;
    if (k === 0 && (k = readWordUnit(c)) === 0) return lower.replace(NOT_MENTION_CHARS, " ");
    if (k === 1 || c === 64 || c === 46) {
      i++;
      continue;
    }
    const start = i;
    for (i++; i < n; i++) {
      c = lower.charCodeAt(i);
      k = WORD_UNITS[c]!;
      if (k === 0 && (k = readWordUnit(c)) === 0) return lower.replace(NOT_MENTION_CHARS, " ");
      if (k === 1 || c === 64 || c === 46) break;
    }
    if (i - start === 1 && lower.charCodeAt(start) === 32) continue;
    out += lower.slice(from, start) + " ";
    from = i;
  }
  return from === 0 ? lower : out + lower.slice(from);
}

/**
 * Words that name someone by their relation to the user rather than by name ("my manager", "the landlord", "my
 * sister"): a person probe has no name to send, so the word itself is sent (the user's items say "your landlord",
 * "Mum", "the school office").
 */
export const ROLES = new Set(
  (
    "manager boss lead director ceo cfo cto founder cofounder colleague team assistant recruiter hr payroll finance " +
    "accounts legal counsel lawyer solicitor accountant landlord letting agent tenant neighbour neighbor nanny " +
    "babysitter cleaner school teacher nursery doctor gp dentist physio therapist vet pharmacy mum mom dad mother " +
    "father sister brother wife husband partner son daughter grandma grandpa aunt uncle cousin parents kids"
  ).split(" "),
);

/** The relation words of a request ("Book a 1:1 with my manager" is ["manager"]), at most `max`, in order. */
export function rolesOf(raw: string, max = 2): string[] {
  const out: string[] = [];
  for (const w of raw.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (ROLES.has(w) && !out.includes(w)) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** The days an item names by day and month ("Fri 6 Nov", "6 November"), as ISO dates: the year nearest `now`. */
export function daysNamed(item: ContextItem, now: number): string[] {
  const out: string[] = [];
  const year = new Date(now).getUTCFullYear();
  for (const m of `${item.title} ${item.text}`.toLowerCase().matchAll(DATES_ALL)) {
    const mi = MONTHS.indexOf(m[2]!.slice(0, 3));
    const day = Number(m[1]);
    if (mi < 0 || day < 1 || day > 31) continue;
    let best = "";
    let gap = Infinity;
    for (const y of [year - 1, year, year + 1]) {
      const t = Date.UTC(y, mi, day);
      if (Math.abs(t - now) < gap) [best, gap] = [new Date(t).toISOString().slice(0, 10), Math.abs(t - now)];
    }
    if (!out.includes(best)) out.push(best);
  }
  return out;
}
