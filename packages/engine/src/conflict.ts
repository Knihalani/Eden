/**
 * The conflict test: would this item change what the request is about to do? With no model's say, words shared with
 * a request say only that an item is about the same thing, and its near-miss twin ("the invoice was paid" against
 * "the other invoice was paid", "on leave this week" against "on leave next month") shares them all. What tells them
 * apart is structure: the request's days, amounts and named references set against what the item states about them.
 *
 * - A request's frame (`frameOf`): the days it acts on (today when it names none: an action unqualified happens now),
 *   the amounts it commits (money and percentages; "15 people … £85 a head" is £1,275), and the references it names
 *   ("INV-5842", "Q3 report", "October invoice").
 * - An item's statements, sentence by sentence: what blocks or negates an action (a prohibition, a hold, an absence,
 *   an expiry, a move, an allergy, an approval rule), what clears it (lifted, restored, unchanged, approved for), and
 *   the dates and amounts those statements are about.
 * - The verdict (`assess`): `conflict` when a blocking statement holds for the request (a span covering a day it acts
 *   on, a deadline or expiry before it, a limit below its amount, or no date at all), `clear` when the item's decisive
 *   value does not conflict (the span is elsewhere, the amount is under the limit, the matter is lifted, or the item is
 *   about a sibling reference: Q2 for Q3, INV-5825 for INV-5842), else `none`.
 *
 * Nothing here reads instructions from an item: its text is matched against fixed patterns, never followed. Every
 * pattern is linear (no nested quantifiers over the same characters) and reads at most `MAX_TEXT` characters.
 */
import type { ContextItem } from "@eden/protocol";
import { parseWhen } from "./grounding";
import { isPacked } from "./packed-text";
import { compactText } from "./render";

const NO_FOCUS: ReadonlySet<string> = new Set();
/** A message's header lines: who sent it and when, not what it says (a calendar item's "When:" line stays). */
const HEADERS = /^(?:from|to|cc|bcc|date|sent|subject|reply-to):[^\n]*$/gim;

/** What a request commits to, read from its own words. */
export interface Frame {
  /** The days it acts on (YYYY-MM-DD); today when it names none. */
  days: string[];
  /** Whether the request named those days itself (a span elsewhere only clears an item against named days). */
  named: boolean;
  /** Money and percentages it commits to, each in its unit ("£", "€", "$", "%"). */
  amounts: Amount[];
  /** References it names: an identifier ("inv-5842"), or a qualifier and the noun it qualifies ("q3 report"). */
  refs: Ref[];
  /** It assumes things are as they were ("same as usual", "the usual form"): a change is then a conflict. */
  routine: boolean;
  /** The people and organisations it names, lower case. */
  names: string[];
  /** Words that tie a statement to the request by name: its names' words and its references ("inv-5842"). */
  nameTies: Set<string>;
  /**
   * Its content words of four letters or more that are not days, times or the verbs every request starts with: they
   * tie a statement to a request that names no one ("schedule the billing release" and "no production changes").
   */
  wordTies: Set<string>;
  /** `conflictVocab` (D75): the wider vocabulary, possessive ties, more date forms and party-tied clearances. */
  vocab?: boolean;
}

interface Amount {
  unit: string;
  value: number;
}

interface Ref {
  /** The kind of qualifier: an identifier's prefix ("inv"), "quarter", "half", "month" or "year". */
  kind: string;
  value: string;
  /** The noun qualified ("report", "invoice"); empty for an identifier. */
  noun: string;
}

export type Verdict = "conflict" | "clear" | "none";

/** The head of an item that is read: statements that matter come early, and the bound keeps every scan linear. */
const MAX_TEXT = 3_000;
const DAY = 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A month's name or its usual short form, whole ("mar" and "march", never "marketing"). */
const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b";
const WEEKDAY = "(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s";

/**
 * Statements that stop or negate an action. Prohibitions ("do not", "nobody should", "no … until"), holds and
 * suspensions, absences, expiries and endings, a contact gone, a plan moved or called off, a constraint on what can
 * be served or shared, a rule that needs someone else's approval first, and a thing already done.
 */
const BLOCKS = new RegExp(
  `\\b(?:${[
    "do not|don't|dont|must not|mustn't|may not|cannot|can't|should not|shouldn't|will not|won't|does not|doesn't",
    "not to be|nobody (?:should|may|can)|no one (?:should|may|can)|never|not allowed|prohibited|forbidden",
    "not (?:be )?processed|not accepted|no longer|is off\\b|called off|not before|no transfers",
    "no (?:new |net-new |international |production |further )?[a-z]+s? (?:until|before|during|while|from)",
    "suspended|on hold|blocked|frozen|freeze|pausing|paused|embargo(?:ed)?|expired|expires|lapsed|retired|retiring",
    "discontinued|cancell?ed|closed lost|inactive|bounces|deactivated|terminated|ended|in dispute|disputed|withdrawn",
    "pulled",
    "on leave|annual leave|parental leave|compassionate leave|sick leave|out of (?:the )?office|is away|i'm away",
    "offline|unavailable|not available|jury service",
    "requires?|required|needs? (?:[a-z-]+ ){0,2}(?:sign-?off|approval|countersignature)",
    "pre-?approv[a-z]*|sign-?off from|only (?:on|with|after|if|until)",
  ].join("|")})\\b`,
  "gi",
);

/** Statements that a plan moved: the new date is not the one the request acts on. */
const MOVES =
  /\b(?:slips?|slipping|slipped|postponed|rescheduled|delayed|(?:moved|brought) (?:forward|back|to|from)|push(?:ed)? (?:[a-z']+ ){0,3}to)\b/gi;

/** A standing constraint on what can be served, given or shared: when it was said does not matter. */
const STANDING =
  /\b(?:allerg[a-z]*|anaphyla[a-z]*|intoleran[a-z]*|coeliac|celiac|(?:gone|now|fully|strictly|is|am|i'm) (?:vegan|vegetarian)|no-gifts?|confidential|strictly internal|internal only|recused)\b/gi;
/**
 * `conflictVocab` (D75): more of the ordinary ways to say an action is blocked, written from general usage: an open
 * end ("until further notice"), a thing not signed or refused, access revoked, someone off ("I'm off from 26 Oct",
 * "off sick", parental leave), a hold on an account or an order to hold ("credit hold", "hold every send"), a
 * prohibition on new commitments ("no new spend", "no further orders"), a plan dropped ("scrapped", "shelved",
 * "dropped in favour of"), something not possible, a thing out of action ("in the garage", "out of service"),
 * and someone travelling ("Mum's off to Málaga"). Most of these phrases were taken from the dev6a/dev6b suites the
 * flag was measured on, so its dev gains are in-sample (D75).
 */
const BLOCKS_MORE = new RegExp(
  `\\b(?:${[
    "until further notice|not (?:yet )?signed|unsigned|not (?:yet )?approved|unapproved|not authori[sz]ed",
    "revoked|revoking|barred|banned|blacklisted|struck off",
    "(?:i'm|i am|i'll be|he's|she's|they're|we're|is|are|will be) off (?:from|until|till|between|for|sick|work)",
    "off sick|maternity leave|paternity leave|on (?:maternity|paternity|sabbatical|holiday|vacation)",
    "(?:credit|account|payment|legal|spending|hiring) (?:hold|freeze)|hold (?:every|all|any|off)",
    "no (?:new|further|more) (?:[a-z-]+ )?(?:permissions?|access|spend|spending|orders?|purchases?|hires?|hiring)",
    "no (?:new|further|more) (?:[a-z-]+ )?(?:accounts?|contracts?|commitments?|bookings?|deals?|work|projects?)",
    "no (?:[a-z-]+ ){0,2}[a-z]+s? (?:until|before|during|while)",
    "scrapped|shelved|axed|dropped in favou?r of|dropped from|not going ahead|no longer going ahead|not happening",
    "(?:aren't|isn't|is not|are not|not) possible|impossible",
    "in the garage|in for (?:repairs?|a service|service)|off the road|out of action|out of (?:service|order)",
    "broken down|being repaired|written off",
    "(?:'s|is|are|i'm|they're|we're) off to|flies out|flying out",
  ].join("|")})\\b`,
  "gi",
);
/**
 * `conflictVocab`: block words with no object of their own ("declined", "rejected", "impossible"): a card declined
 * at the shop or a proposal rejected by the board says nothing about dinner on Friday. They block only in a
 * statement that holds one of the request's own words other than a name ("the booking was declined").
 */
const BLOCKS_OBJECT = /\b(?:rejected|declined|denied|refused|impossible)\b/gi;
/**
 * `conflictVocab`: more ways to say a block is gone. "Released" alone is not one ("the hotfix was released to
 * staging" lifts no freeze): only a hold, freeze or block released is.
 */
const LIFTED_MORE =
  // Lookbehind: the mark is at "released", after the block's own word, so it reads as the later statement.
  "(?<=(?:hold|freeze|block|embargo|suspension|ban|restriction)s? (?:has been |have been |was |were |is |are |now )?)" +
  "released|" +
  "released (?:the |its |our |their )?(?:hold|freeze|block|embargo|suspension|ban|restriction)s?|" +
  "back to normal|resumed|reopened|up and running|now signed";
const CLEARS_MORE = new RegExp(`\\b(?:${LIFTED_MORE})\\b`, "gi");
const REVERSAL_MORE = new RegExp(`\\b(?:${LIFTED_MORE})\\b`);
/**
 * `conflictVocab`: more standing constraints on what can be served or given, and security alerts ("changed from a
 * device we don't recognise"): when an alert was raised does not matter, it stands until something clears it.
 */
const STANDING_MORE =
  /\b(?:(?:don't|do not|didn't) recogni[sz]e|unrecogni[sz]ed|compromised|fraudulent|teetotal|(?:stopped|quit|given up|giving up) (?:drinking|alcohol|booze|meat|dairy|gluten)|(?:not|no longer|don't|doesn't) drink(?:ing)?|pregnant|halal|kosher|nut-free|gluten-free|dairy-free)\b/gi;
/** `conflictVocab`: sign-off courtesies, which state nothing about the matter. */
const COURTESY =
  /\b(?:happy to (?:jump|hop) on a (?:quick )?(?:call|chat)|if easier|shout if you have|let me know (?:what you think|if you have any questions)|any questions)\b/;
/** `conflictVocab`: idioms whose negation blocks nothing ("can't wait for Friday", "no worries"). */
const IDIOMS =
  /\b(?:can't wait|cannot wait|can not wait|can't believe|no worries|no problem|not a problem|never mind|don't worry|no rush|no hurry)\b/g;

/**
 * Statements that the action is done already: paying, sending or filing again is the mistake. When it was done does
 * not matter, unlike a block's dates.
 */
const DONE =
  /\b(?:already (?:been |[a-z]+ed\b|paid|sent|done|bought|got)|was paid|we paid|been paid|paid in full|payment sent|was sent on|been sent|been submitted|by mistake|nothing (?:further|more) (?:is )?owed|auto-?renew(?:al)? (?:is )?on)\b/gi;

/** Statements that a matter is clear: lifted, restored, unchanged, allowed, still on. */
const CLEARS = new RegExp(
  `\\b(?:${[
    "lifted|restored|reinstated|resolved|unchanged|no changes?|not changed",
    "approved for|cleared (?:it )?for|cleared to|clear to|is clear|all clear|is fine",
    "are fine|fine by me|all good|works for|happy (?:from|to|with)|permits?|permitted|allows?|allowed to",
    "may be (?:shared|used)|can be (?:shared|used)|can go ahead|good to go|no (?:current )?conflict|no restrictions?",
    "no open|no need|negative|came back clear|eat(?:ing)? everything|as usual|as normal|as planned|went fine",
    "extended|renewed|back at|back from|valid (?:to|until)|signed off|countersigned|approved\\b|keeps? [a-z]+ing (?:to|as)",
    "(?:with |at )?no (?:charge|fee|penalty|cost)|free of charge|without (?:a |any )?(?:charge|fee|penalty)",
  ].join("|")})\\b`,
  "gi",
);

/**
 * Words that say a matter stands as it was: a clearance only before any block in the sentence ("the booking stands"),
 * a confirmation of the block after one ("the freeze remains in place until 9 Nov", "freeze 4-9 Nov still holds").
 */
const REAFFIRMS =
  /\b(?:stands|holds|still (?:on|valid|good|works|active|in place)|remains?|stays? (?:the same|active|on|open|valid|at|in place|unchanged)|active)\b/gi;

/**
 * Every list a statement's marks are read from (`analysis`), without and with `conflictVocab`, as one regex each
 * (D1723): a sentence none of them matches has no mark of any kind, so its ten or so `matchAll` passes are skipped.
 * Built from the lists themselves, so they cannot drift apart; `conflict-memo.test.ts` checks the union against them.
 */
export const MARK_LISTS: readonly [readonly RegExp[], readonly RegExp[]] = [
  [BLOCKS, MOVES, CLEARS, REAFFIRMS, DONE, STANDING],
  [BLOCKS, BLOCKS_MORE, BLOCKS_OBJECT, MOVES, CLEARS, CLEARS_MORE, REAFFIRMS, DONE, STANDING, STANDING_MORE],
];
/** `MARK_LISTS` as one case-insensitive, non-global test each (no `lastIndex` to carry between sentences). */
const MARKED = MARK_LISTS.map((res) => new RegExp(res.map((re) => `(?:${re.source})`).join("|"), "i"));
/** Whether a statement (lower-cased) holds a word of any mark list (`MARKED`); exported for tests. */
export const anyMark = (s: string, vocab: boolean): boolean => MARKED[vocab ? 1 : 0]!.test(s);

/** Words before a mark that negate it ("not approved", "no longer active"). */
const NEGATION = /(?:\b(?:not|no|never|without|nothing)|n't)\s+(?:[a-z]+\s+)?$/;

/** A condition opened and not closed before a word ("until it is", "unless approved", "once lifted"). */
const CONDITION = /\b(?:until|unless|once|if|when|pending|till|before)\b[^,:]*$/;

/** A change to what the request assumes is as usual: only a conflict when the request assumes it. */
const CHANGES =
  /\b(?:goes (?:up )?from|going up|increas[a-z]*|rises?|new (?:address|plan|price|form|process)|moved in|changed? to|now (?:at|lives?|goes|costs?)|replaced by|instead)\b/gi;
const ROUTINE = /\b(?:same|usual|as before|as always|like last (?:time|year)|regular|normal|again|their place)\b/i;

/** Date words that say what a date is to the statement around it. */
const STARTS = new Set(["from", "since", "after", "starting", "effective"]);
const ENDS = new Set(["until", "till", "through", "thru", "to", "not before"]);
const LIMITS = new Set([
  "by",
  "before",
  "expires",
  "expire",
  "expired",
  "expiring",
  "ends",
  "end",
  "ended",
  "due",
  "deadline",
  "lapsed",
  "lapses",
  "valid to",
  "valid until",
  "no later than",
]);

/** A day and month, optionally a year, optionally after a weekday and a date word. */
const MON = MONTH.replace("(", "(?:");
const DATED = new RegExp(
  `\\b(?<word>from|since|after|starting|effective|not before|until|till|through|thru|to|by|before|expires|expire|` +
    `expired|expiring|ends|end|ended|due|deadline|lapsed|lapses|valid to|valid until|no later than|on|the)?` +
    `(?<on> on)?\\s?` +
    `(?<wd>${WEEKDAY})?(?:(?<d1>\\d{1,2})(?:st|nd|rd|th)?(?: of)? (?<m1>${MON})(?:,? (?<y1>\\d{4}))?|` +
    `(?<m2>${MON}) (?<d2>\\d{1,2})(?:st|nd|rd|th)?(?:,? (?<y2>\\d{4}))?|(?<m3>${MON}) (?<y3>\\d{4}))\\b`,
  "g",
);
/** "6–9 Nov", "Friday 20 to Monday 23 November": a range whose first day borrows the second's month. */
const RANGE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)? ?(?:-|to|until|till|and) ?(?:${WEEKDAY})?(\\d{1,2})(?:st|nd|rd|th)? ${MONTH}(?:,? (\\d{4}))?`,
  "g",
);
/** "26 Oct to 6 Nov", "30 Oct - 2 Nov": two whole dates. */
const PAIR = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)? ${MONTH}(?:,? (\\d{4}))? ?(?:-|to|until|till) ?(?:${WEEKDAY})?(\\d{1,2})(?:st|nd|rd|th)? ` +
    `${MONTH}(?:,? (\\d{4}))?`,
  "g",
);
/** A sentence that sets a deadline: "by" (or "before") then a time or a day, "due", "deadline". */
const DEADLINE =
  /\b(?:(?:by|before|no later than) (?:\d|end|close|eod|cob|the end|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b)|deadline|due)/;
/** A limit word and a bare year ("valid to 2036"). */
const YEAR_LIMIT = /\b(valid to|valid until|expires|expiring|until|till|through)\s(20\d\d)\b/g;

/** `conflictVocab`: "back 9 Nov", "back on 9 November": the day someone returns. */
const BACK_DATED = new RegExp(`\\bback (?:on )?(\\d{1,2})(?:st|nd|rd|th)? ${MONTH}`, "g");
/** `conflictVocab`: a day of the month alone after a date word ("till the 10th"), no month after it. */
const ORDINAL = new RegExp(
  `\\b(from|since|after|until|till|through|thru|by|before|back|on)(?: on)? the (\\d{1,2})(?:st|nd|rd|th)\\b(?! of)(?! ${MONTH})`,
  "g",
);
/** `conflictVocab`: a weekday after an end word ("until Sunday", "back Thursday", "by Friday"), no date after it. */
const WEEKDAY_END =
  /\b(until|till|through|thru|back|by|before)(?: on)? ((?:mon|tues|wednes|thurs|fri|satur|sun)day)\b(?!,? \d)/g;

/**
 * What every month-reading pattern above needs (D1883): a figure (with its ordinal suffix and "of") then a month's
 * first three letters, or those letters, more letters and a figure. Wider than any of them, so a sentence it does not
 * match gives none of their matches.
 */
const MONTH_DATE =
  /\d(?:st|nd|rd|th)?(?: of)? (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d/;

/**
 * `datesOf` as tests read it: `prefilter` false runs every pattern on every sentence, as before D1883 (the
 * differential test in `conflict-memo.test.ts`).
 */
export function datesFor(s: string, now: number, vocab: boolean, anchor: number | null, prefilter: boolean): Dates {
  return datesOf(s, now, vocab, anchor, prefilter);
}

/** One sentence's dated statements. */
interface Dates {
  spans: { from: string; to: string }[];
  limits: string[];
}

/** The request's frame: its days, amounts and references (`Frame`). */
export function frameOf(
  raw: string,
  days: Iterable<string> | null,
  now: number,
  names: string[] = [],
  vocab = false,
): Frame {
  const text = raw.slice(0, 2_000).replace(/[\u2013\u2014]/g, "-");
  const named = days !== null && [...days].length > 0;
  const refs = refsOf(text, vocab);
  // Names as names: capitalised words, at most four (an entity run can be a quoted subject line).
  const lower = names
    .filter((n) => NAME.test(n.trim()))
    .map((n) => n.trim().toLowerCase())
    .map((n) => (vocab ? n.split(/\s+/).map(unpossess).join(" ") : n));
  const nameTies = new Set<string>([
    ...lower.flatMap((n) => n.split(/\s+/)).filter((w) => w.length > 1),
    ...refs.filter((r) => r.noun === "").map((r) => `${r.kind}-${r.value}`),
  ]);
  const wordTies = new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? [])
      .map((w) => (vocab ? unpossess(w) : w))
      .filter((w) => !UNTIED.test(w))
      .map(stem),
  );
  return {
    days: named ? [...days!].sort() : [iso(now)],
    named,
    amounts: amountsOf(text, true),
    refs,
    routine: ROUTINE.test(text),
    names: lower,
    nameTies,
    wordTies,
    vocab,
  };
}

/** A name as a name: capitalised words, at most four. */
const NAME = /^[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){0,3}$/u;

/**
 * Request words that tie nothing: days and times, the verbs and courtesies requests start with, and words any
 * message holds.
 */
const UNTIED = new RegExp(
  `^(?:${MON}|(?:mon|tues|wednes|thurs|fri|satur|sun)day|today|tonight|tomorrow|yesterday|week|weekend|month|year|` +
    `morning|afternoon|evening|night|next|this|that|these|those|last|then|than|with|from|into|about|over|after|` +
    `before|until|please|could|would|should|will|can't|can|need|needs|want|wants|like|know|make|take|give|send|` +
    `email|tell|reply|book|schedule|arrange|check|confirm|find|look|help|thanks|thank|also|just|some|somewhere|` +
    `nice|good|great|what|when|where|which|while|there|here|have|been|they|them|their|your|yours|ours|mine|` +
    `around|keep|sure|okay|asap|soon|quick|again|still|anything|everything|something|nothing|every|other|` +
    `said|says|plan|plans|time|times|date|dates|today's|ahead|back|it's|let's|i'll|we'll|let)$`,
);

/**
 * What an item says about a request's frame (`Frame`): `conflict`, `clear` or `none`. Sentences are read in order;
 * one about a date or an amount decides for the sentences after it that only repeat its point ("… while Robert is
 * away"), and a clearing statement anywhere after a blocking one wins ("was blocked, but … the date holds").
 *
 * What depends on the item alone (its statements, their marks, its words and references) is read once per item and
 * vocabulary (`analyse`); what depends on the request (ties, dates, amounts, the twin check) is read here each time.
 */
export function assess(
  frame: Frame,
  item: ContextItem,
  now: number,
  extraTies?: ReadonlySet<string>,
  quietSkipped = true,
): Verdict {
  // A consequence probe's find (`consequence.ts`) is tied to the request by its action class's own words: "freeze"
  // and "production" tie a release request that says neither. Plural "s" dropped, as for the request's own words.
  const extra = extraTies ? new Set([...extraTies].map(stem)) : null;
  const V = frame.vocab === true;
  const a = analyse(item, V);
  // A message from someone the request names speaks for them: its "I" is them ("I'm vegetarian" from Sam).
  const fromNamed = a.sender !== "" && frame.names.some((n) => n.split(/\s+/).every((w) => a.sender.includes(w)));
  // A statement is tied to the request when it holds one of its words, or speaks in the first person from someone
  // it names. Only a tied statement's conflict is the request's ("travel over £500 needs pre-approval" in a mail
  // from Oskar is no conflict with lunch with Oskar). A request that names someone ties by name only: another
  // company's overdue invoice shares its words, not its names. A chat line's speaker ("[09:14] Lars: …") is who says
  // it, like a message's sender.
  const isNamed = (who: string) => frame.names.some((n) => n.split(/\s+/).every((w) => who.includes(w)));
  const ties = frame.names.length > 0 ? [frame.nameTies] : [frame.nameTies, frame.wordTies];
  if (extra) ties.push(extra);
  const tied = (t: Tie) => {
    if (t.words.some((w) => ties.some((x) => x.has(w)))) return true;
    return (fromNamed || (t.speaker !== null && isNamed(t.speaker))) && t.firstPerson;
  };
  // A sibling reference: the item is about Q2 where the request says Q3, another invoice than the one named.
  if (frame.refs.length > 0 && twin(frame.refs, refsFor(a, V && hasDomain(frame)))) return "clear";
  // `conflictVocab`: a relative date ("until Monday", "till the 10th") counts from when the item was written, not
  // from the request: "back Monday" sent on 1 Oct meant 5 Oct. With no known date it is read as no date.
  const anchor = a.anchor;
  let state: Verdict = "none";
  // Whether a statement behind the current conflict is tied to the request.
  let tiedConflict = false;
  // A conflict read from a date, an amount, a thing done or a standing constraint is firm: only a clearing
  // statement about the same matter (sharing a word with it) undoes it. "Passport expires 2 Nov" stands after
  // "driving licence renewed 2024"; "SOC 2 report expired 30 Sep" falls to "the renewed report was accepted".
  let firm: Set<string> | null = null;
  // Cleared by a date: the block is about other days.
  let elsewhere = false;
  const conflict = (st: Statement, isFirm: boolean, money = false) => {
    // A conflict on an amount is tied by the amount itself; a statement is also tied by the sentence before it, or by
    // the item's title, naming what it is about ("Rebecca Stone (Soylent Foods)". "Status: no longer at …").
    // With `conflictVocab`, a table's row is not tied by the row above it: that is another record.
    const t = money || tied(tieOf(st, V)) || (!(V && st.s.startsWith("|")) && tied(tieOf(before, V))) || titled;
    tiedConflict = state === "conflict" ? tiedConflict || t : t;
    state = "conflict";
    if (isFirm) firm = wordsFor(st);
    if (V && t) conflictWords = wordsFor(st);
  };
  // A clearance is a near-miss twin's mark only where something could have blocked: after a blocking statement in
  // the item, or in words that say a block is gone ("lifted", "back from leave", "unchanged"). "Happy to jump on a
  // call" clears nothing.
  let blockSeen = false;
  // `conflictVocab`: the words of the last tied conflicting statement. A table's row about another party ("| Pied Piper
  // | Approved |" after "| Aperture Labs | Suspended |") does not undo a conflict tied to the one the request names:
  // a row clears only when it is tied to the request too, or shares a word with the conflicting statement. (In prose
  // a clearance need not repeat the name: "SSO was blocked, but the cert came through and the date holds".)
  let conflictWords: Set<string> | null = null;
  const clear = (st: Statement) => {
    const s = st.s;
    if (!blockSeen && !REVERSAL.test(s) && !(V && REVERSAL_MORE.test(s))) return;
    if (firm && ![...wordsFor(st)].some((w) => firm!.has(w))) return;
    if (V && s.startsWith("|") && state === "conflict" && tiedConflict && frame.names.length > 0 && conflictWords) {
      const cw: Set<string> = conflictWords;
      if (!tied(tieOf(st, V)) && ![...wordsFor(st)].some((w) => cw.has(w))) return;
    }
    state = "clear";
    firm = null;
    conflictWords = null;
    elsewhere = false;
  };
  const titled = tied(a.title);
  // A statement that holds one of the request's own words other than a name (`BLOCKS_OBJECT`).
  const objectTied = (st: Statement) => objectWordsOf(st).some((w) => frame.wordTies.has(w) && !frame.nameTies.has(w));
  // The statement before the one read, read itself or not: it ties the one after it by naming what it is about.
  let before: Statement = NO_STATEMENT;
  const statements = a.statements;
  // With no amount in the request and no routine to change, a statement with no mark and no date changes nothing
  // below: only the others are read (`activeOf`, D1935). Most of an item's statements are such.
  const active = quietSkipped && frame.amounts.length === 0 && !frame.routine ? activeOf(a) : null;
  const count = active ? active.length : statements.length;
  for (let j = 0; j < count; j++) {
    const i = active ? active[j]! : j;
    const st = statements[i]!;
    before = i > 0 ? statements[i - 1]! : NO_STATEMENT;
    if (st.skip) continue;
    const s = st.s;
    const money = amountVerdict(frame, s);
    if (money === "conflict") conflict(st, true, true);
    else if (money === "clear") [state, firm] = ["clear", null];
    if (money !== "none") continue;
    const blocked =
      V && st.objectBlocks.length > 0 && objectTied(st) ? [...st.blocked, ...st.objectBlocks] : st.blocked;
    // The marks' extremes by loops, not spreads into `Math.max` (D1889): a statement's lists are nearly always empty,
    // and each spread made an array a statement a request.
    const lastBlock = maxOf(blocked, -1);
    // A reaffirming word after a block or move in the sentence confirms it, so it clears only before the first.
    const firstBlock = minOf(st.moves, minOf(blocked, Number.MAX_SAFE_INTEGER));
    const lastClear = maxBelow(st.reaffirms, firstBlock, maxOf(st.clears, -1));
    // Something done already, or a standing constraint (an allergy, a confidentiality): when does not matter, and
    // a clearing word after it in the same sentence undoes it ("tested for coeliac and it's negative").
    // So is a change to what the request assumes is as usual ("same as usual" against "goes from £1650 to £1710").
    const lastDone = frame.routine ? maxOf(changesOf(st), st.lastDone) : st.lastDone;
    const lastMove = maxOf(st.moves, -1);
    if (lastBlock >= 0 || lastDone >= 0 || lastMove >= 0) blockSeen = true;
    if (lastDone > lastClear) conflict(st, true);
    else if (lastClear > Math.max(lastBlock, lastMove)) {
      // A clearing statement with a date of its own ("EHIC valid to 2029") is about its own matter.
      if (!(firm && st.dated && dateVerdict(frame, st, now, false, V, anchor) !== "none")) clear(st);
    } else {
      const dated = st.dated ? dateVerdict(frame, st, now, lastBlock >= 0, V, anchor) : "none";
      if (dated === "conflict") conflict(st, true);
      else if (lastMove >= 0) {
        // Moved: unless the request acts on the new day, it acts on the old one. Days after "from" are the old ones.
        const fresh = datesOf(s.replace(/\bfrom (?:[a-z]+,? )?\d{1,2}(?:st|nd|rd|th)? [a-z]+/g, " "), now, V, anchor);
        // The day it moved to is the end of what is read as a span ("to Friday 30 October").
        const onNew = frame.named && fresh.spans.some((sp) => frame.days.includes(sp.to));
        if (onNew) clear(st);
        else conflict(st, false);
      } else if (dated === "clear") {
        // A block over other days clears; a date with no block only says later blocks are about other days.
        if (lastBlock >= 0) clear(st);
        elsewhere = true;
      }
      // A block with no date of its own repeats a dated one before it ("… while Robert is away").
      else if (lastBlock >= 0 && !firm && !elsewhere) conflict(st, false);
    }
  }
  // (`state` is set in the closures above, which narrowing does not see.)
  const verdict = state as Verdict;
  return verdict === "conflict" && !tiedConflict ? "none" : verdict;
}

/** What ties a statement to a request (`assess`'s `tied`): its words, and who says it in the first person. */
interface Tie {
  /** Its distinct words, stemmed (and with `conflictVocab` without a possessive), its speaker's left out. */
  words: string[];
  /** A chat line's speaker ("[09:14] lars nilsen: "), or null. */
  speaker: string | null;
  /** Whether it speaks in the first person. */
  firstPerson: boolean;
}

/**
 * One statement of an item as `assess` reads it, with the marks of every pattern list in it: they depend on the
 * statement alone. `blocked`, `clears` and `lastDone` follow the vocabulary the analysis was made for.
 */
interface Statement {
  /** The statement, lower case, an ended restriction read as lifted and (`conflictVocab`) its idioms blanked. */
  s: string;
  /** Not read: too short, boilerplate or (`conflictVocab`) a courtesy. It still ties the statement after it. */
  skip: boolean;
  /** The marks below are `EMPTY_MARKS` when there are none, as almost always (`kept`). */
  blocked: readonly number[];
  /** `BLOCKS_OBJECT`'s marks, which block only in a statement holding one of the request's words. */
  objectBlocks: readonly number[];
  moves: readonly number[];
  clears: readonly number[];
  reaffirms: readonly number[];
  /** The last mark of a thing done or a standing constraint, -1 for none. */
  lastDone: number;
  /**
   * Whether it may state a date (`datesOf`): every date form holds a digit but a weekday after an end word ("until
   * Sunday", `conflictVocab` only). Without one, `dateVerdict` is "none" whatever the request and the day.
   */
  dated: boolean;
  /** Read on first use (`tieOf`, `wordsFor`, `objectWordsOf`, `changesOf`): most statements never need them. */
  tie?: Tie;
  words?: Set<string>;
  objectWords?: string[];
  changes?: number[];
  /** Its date patterns' matches (`planDates`), read on its first dated verdict. */
  dates?: DatePlan;
}

/**
 * The one array every statement without a mark of some kind holds (D136). An analysis is cached for as long as its
 * item (`ANALYSES`), and nearly every mark array is empty (99.9% on the bench workload): a fresh `[]` each was about
 * half the cache's heap. Frozen, since it is shared by every item; the marks are only read, spread and filtered.
 */
const EMPTY_MARKS: readonly number[] = Object.freeze([]);

/** A statement's marks as kept in its analysis: `EMPTY_MARKS` for none. */
const kept = (marks: number[]): readonly number[] => (marks.length > 0 ? marks : EMPTY_MARKS);

/** A statement that is not read (`Statement.skip`). */
const skipped = (s: string): Statement => ({
  s,
  skip: true,
  blocked: EMPTY_MARKS,
  objectBlocks: EMPTY_MARKS,
  moves: EMPTY_MARKS,
  clears: EMPTY_MARKS,
  reaffirms: EMPTY_MARKS,
  lastDone: -1,
  dated: false,
});

/** The largest of `xs` and `from` (`Math.max(from, ...xs)`). */
function maxOf(xs: readonly number[], from: number): number {
  let m = from;
  for (let i = 0; i < xs.length; i++) if (xs[i]! > m) m = xs[i]!;
  return m;
}

/** The smallest of `xs` and `from` (`Math.min(from, ...xs)`). */
function minOf(xs: readonly number[], from: number): number {
  let m = from;
  for (let i = 0; i < xs.length; i++) if (xs[i]! < m) m = xs[i]!;
  return m;
}

/** The largest of `from` and the `xs` below `bound` (`Math.max(from, ...xs.filter((x) => x < bound))`). */
function maxBelow(xs: readonly number[], bound: number, from: number): number {
  let m = from;
  for (let i = 0; i < xs.length; i++) if (xs[i]! < bound && xs[i]! > m) m = xs[i]!;
  return m;
}

/** What the first statement of an item has before it. Frozen: it is shared by every item, so nothing is noted on it. */
const NO_STATEMENT: Statement = Object.freeze({
  ...skipped(""),
  tie: Object.freeze({ words: [], speaker: null, firstPerson: false }),
});

/** An item as `assess` reads it for one vocabulary (`analyse`). */
interface Analysis {
  /** The sender in its `From:` line, lower case, or "". */
  sender: string;
  /** The item's title as a statement's tie. */
  title: Tie;
  statements: Statement[];
  /** When the item was written (`sentAt`), read only with `conflictVocab`. */
  anchor: number | null;
  /** The text the references are read from (title and compacted text). */
  whole: string;
  /** Its references, without and with domains (`refsOf`), read on first use. */
  refs: [Ref[] | undefined, Ref[] | undefined];
  /** The statements `assess` reads when the request has no amount and no routine (`activeOf`), read on first use. */
  active?: Int32Array;
}

/**
 * The analyses of items, per item object and vocabulary ([without, with] `conflictVocab`). Held weakly: an entry
 * lives as long as the item it reads (a cache's stored copy), and is about that item's text alone, so it is no
 * state of any tenant. The fields an analysis reads are kept beside it: an item whose text, title or date changed in
 * place is read again, so a stale analysis is never served.
 */
const ANALYSES = new WeakMap<ContextItem, AnalysisEntry>();

interface AnalysisEntry {
  /**
   * The text it was read from, or null for a packed item, whose text cannot change (its getter reads fixed bytes):
   * checking it would decompress the text on every read of the entry, and holding it would keep a decoded copy (D1930).
   */
  text: string | null;
  title: string;
  updatedAt: number | undefined;
  views: [Analysis | undefined, Analysis | undefined];
  /**
   * `gateOf`'s two readings of the item, each read on first use: bit 0 set once `mayConstrain` was read and bit 1
   * its answer, bits 2 and 3 the same for `arrangedVisit` (D1880).
   */
  gate: number;
}

/** The item's entry in `ANALYSES`, a fresh one when its text, title or date changed in place. */
function entryOf(item: ContextItem): AnalysisEntry {
  let e = ANALYSES.get(item);
  // A packed item's text is never read here: an object is packed or plain for life, and a packed one's bytes are fixed.
  const packed = isPacked(item);
  if (!e || (!packed && e.text !== item.text) || e.title !== item.title || e.updatedAt !== item.updatedAt) {
    e = {
      text: packed ? null : item.text,
      title: item.title,
      updatedAt: item.updatedAt,
      views: [undefined, undefined],
      gate: 0,
    };
    ANALYSES.set(item, e);
  }
  return e;
}

/**
 * An item read for `assess` with or without `conflictVocab` (`vocab`), once per item object and vocabulary. Exported
 * for tests only (`conflict.test.ts` checks what an analysis keeps).
 */
export function analyse(item: ContextItem, vocab: boolean): Analysis {
  const e = entryOf(item);
  const k = vocab ? 1 : 0;
  return (e.views[k] ??= analysis(item, vocab, e.views[1 - k]));
}

/**
 * `analyse` without its memo or the marks' prefilter (`MARKED`): every list read on every sentence, as before D1723.
 * For tests only (the differential test in `conflict-memo.test.ts`).
 */
export function analyseUnfiltered(item: ContextItem, vocab: boolean): Analysis {
  return analysis(item, vocab, undefined, false);
}

/**
 * `analyse`'s work: `other` is the item's analysis for the other vocabulary, whose item-only parts are shared.
 * `prefilter` skips the mark lists on a sentence that none of them matches (`MARKED`, D1723).
 */
function analysis(item: ContextItem, V: boolean, other: Analysis | undefined, prefilter = true): Analysis {
  const blocks = V ? [BLOCKS, BLOCKS_MORE] : [BLOCKS];
  const clears = V ? [CLEARS, CLEARS_MORE] : [CLEARS];
  const standing = V ? [STANDING, STANDING_MORE] : [STANDING];
  const marksOf = (x: string, res: RegExp[], blocking: boolean) => res.flatMap((re) => marks(x, re, blocking));
  const sender = other?.sender ?? /^from:\s*([^<\n]{2,80})/im.exec(item.text.slice(0, 2_000))?.[1]?.toLowerCase() ?? "";
  // The message's own words: no headers, greetings, signature, confidentiality footer or notification boilerplate
  // ("This email and any attachments are confidential" is no constraint on anything).
  const whole =
    other?.whole ??
    `${item.title}. ${compactText(item.text.slice(0, MAX_TEXT).replace(HEADERS, ""), NO_FOCUS, MAX_TEXT)}`;
  const body = whole.toLowerCase().replace(/[–—]/g, "-");
  const statements: Statement[] = [];
  // `conflictVocab`: a table's rows are statements of their own ("| Aperture Labs | Suspended |" and "| Pied Piper |
  // Approved |"), also when the text was flattened onto one line (a row ends where the next begins: "| |").
  for (const sentence of body.split(V ? SENTENCES_ROWS : SENTENCES)) {
    // A restriction that has ended is lifted: "the minimum term ended on 30 Jun" frees the request, unlike "the
    // passport expired on 30 Sep", where what ended is the thing the request needs.
    let s = sentence.trim().replace(RESTRICTION_ENDED, "$1 lifted");
    // `conflictVocab`: a sign-off courtesy is no statement ("happy to jump on a call"), and an idiom is no block
    // ("can't wait for Friday").
    if (s.length < 3 || BOILER.test(s) || (V && COURTESY.test(s))) {
      statements.push(skipped(s));
      continue;
    }
    if (V) s = s.replace(IDIOMS, (m) => " ".repeat(m.length));
    // Most sentences hold no mark word at all: one test of every list at once, and none of their passes.
    const marked = !prefilter || anyMark(s, V);
    statements.push({
      s,
      skip: false,
      blocked: marked ? kept(marksOf(s, blocks, true)) : EMPTY_MARKS,
      objectBlocks: V && marked ? kept(marks(s, BLOCKS_OBJECT, true)) : EMPTY_MARKS,
      moves: marked ? kept(marks(s, MOVES, true)) : EMPTY_MARKS,
      clears: marked ? kept(marksOf(s, clears, false)) : EMPTY_MARKS,
      reaffirms: marked ? kept(marks(s, REAFFIRMS, false)) : EMPTY_MARKS,
      lastDone: marked ? Math.max(-1, ...marks(s, DONE, true), ...marksOf(s, standing, true)) : -1,
      // `search` ignores the shared list's global `lastIndex`.
      dated: /\d/.test(s) || (V && s.search(WEEKDAY_END) >= 0),
    });
  }
  return {
    sender,
    title: tieIn(item.title.toLowerCase(), V),
    statements,
    anchor: V ? sentAt(item) : null,
    whole,
    refs: other?.refs ?? [undefined, undefined],
  };
}

/**
 * The indices of an analysis's statements that can change `assess`'s verdict for a request with no amount and no
 * routine: read, and with a mark of some kind or a date (D1935). Any other statement leaves every variable of
 * `assess`'s loop as it was (its marks are empty, its `lastDone` -1 and its date verdict "none"); the statement before
 * one read is still `statements[i - 1]`, read or not.
 */
function activeOf(a: Analysis): Int32Array {
  if (a.active) return a.active;
  const out: number[] = [];
  for (let i = 0; i < a.statements.length; i++) {
    const st = a.statements[i]!;
    if (st.skip) continue;
    const marked =
      st.blocked.length > 0 ||
      st.objectBlocks.length > 0 ||
      st.moves.length > 0 ||
      st.clears.length > 0 ||
      st.reaffirms.length > 0 ||
      st.lastDone >= 0;
    if (marked || st.dated) out.push(i);
  }
  return (a.active = Int32Array.from(out));
}

/** `assess` reading every statement, as before D1935, for tests (`opt-round4.test.ts`). */
export function assessEvery(frame: Frame, item: ContextItem, now: number, extraTies?: ReadonlySet<string>): Verdict {
  return assess(frame, item, now, extraTies, false);
}

/** An analysis's references (`refsOf`), with domains or without, read once. */
function refsFor(a: Analysis, domains: boolean): Ref[] {
  const k = domains ? 1 : 0;
  return (a.refs[k] ??= refsOf(a.whole, domains));
}

/** What ties a line to a request (`Tie`): with `vocab`, a word's possessive is dropped ("leila's" ties "leila"). */
function tieIn(line: string, vocab: boolean): Tie {
  const said = SPEAKER.exec(line);
  const s = said ? line.slice(said[0].length) : line;
  const words = new Set((s.match(/[a-z][a-z0-9'-]{1,}/g) ?? []).map((w) => stem(vocab ? unpossess(w) : w)));
  return { words: [...words], speaker: said ? said[1]! : null, firstPerson: FIRST_PERSON.test(s) };
}

const tieOf = (st: Statement, vocab: boolean): Tie => (st.tie ??= tieIn(st.s, vocab));
const wordsFor = (st: Statement): Set<string> => (st.words ??= wordsOf(st.s));
const changesOf = (st: Statement): number[] => (st.changes ??= marks(st.s, CHANGES, true));
const objectWordsOf = (st: Statement): string[] =>
  (st.objectWords ??= (st.s.match(/[a-z][a-z0-9'-]{1,}/g) ?? []).map((w) => stem(unpossess(w))));

/** Where a statement ends: a sentence's end, a line, a "but", a chat line's time. */
const SENTENCES = /[.!?;\n]+\s|\n+|,? but |\s(?=\[\d{1,2}:\d{2}\])/;
/** `conflictVocab`: and a table row's end. */
const SENTENCES_ROWS = /[.!?;\n]+\s|\n+|,? but |\s(?=\[\d{1,2}:\d{2}\])|\|\s+(?=\|)/;

/** A chat line's time and speaker ("[09:14] lars nilsen: "). */
const SPEAKER = /^\[\d{1,2}:\d{2}\]\s?([^:\n]{2,40}):\s?/;
const FIRST_PERSON = /\b(?:i|i'm|im|i've|i'll|i'd|my|me|we|we're|we've|our|us)\b/;

/** Words that say a block is gone or never applied. */
const REVERSAL =
  /\b(?:lifted|restored|reinstated|resolved|unchanged|no changes?|not changed|back (?:at|from)|extended|renewed|still (?:on|valid|good)|stands|holds|cleared (?:it )?for|cleared to|clear to|approved for|no (?:current )?conflict|no restrictions?|no open|no need|eat(?:ing)? everything|came back clear|negative|went fine|is fine again)\b/;

/** A restriction, then a word saying it is over. */
const RESTRICTION_ENDED =
  /\b((?:minimum |notice |lock-?in |contract |initial |fixed )?(?:term|period|freeze|hold|embargo|ban|suspension|moratorium|restrictions?|blackout|exclusivity|lock-?(?:in|up)|commitment|probation)(?: (?:on|of|for|in) [a-z-]+(?: [a-z-]+)?)?) (?:has |have |had )?(?:now )?(?:ended|expired|lapsed|finished|ran out|run out|is over|was over)\b/g;

/** Footers and notices that say nothing about the matter ("Please do not reply to this email"). */
const BOILER =
  /\b(?:do not reply|don't reply|no-?reply|automated (?:message|email)|you are receiving|you're receiving|notification (?:settings|preferences)|unsubscribe|intended recipient|confidentiality notice|legally privileged|this email and any attachments)\b/;

/** Whether an item names an identifier the request names ("INV-5842"): then it is about the same thing. */
export function namesRef(frame: Frame, item: ContextItem): boolean {
  const ids = frame.refs.filter((r) => r.noun === "");
  if (ids.length === 0) return false;
  const said = refsOf(`${item.title} ${item.text}`.slice(0, MAX_TEXT), frame.vocab === true && hasDomain(frame));
  return ids.some((a) => said.some((r) => r.kind === a.kind && r.value === a.value && r.noun === a.noun));
}

/** Words too common to tie two statements to one matter. */
const COMMON = new Set(
  "this that with from have will been their they them your were what when then than also only into about after before until over just still there here these those which would could should".split(
    " ",
  ),
);
/** Dates are not a matter: "October" in two sentences does not make them about one thing. */
const DATE_WORD = new RegExp(`^(?:${MON}|(?:mon|tues|wednes|thurs|fri|satur|sun)day)$`);

/** The words of a statement that can tie it to another about the same matter. */
function wordsOf(s: string): Set<string> {
  // Five-letter stems, so "allergy" and "allergic" are one matter: a clearance that says "not allergic" undoes the
  // conflict read from "the allergy results". A wrong tie can only clear, which errs toward silence.
  return new Set(
    (s.match(/[a-z][a-z0-9-]{3,}/g) ?? [])
      .filter((w) => !COMMON.has(w) && !DATE_WORD.test(w))
      .map((w) => w.slice(0, 5)),
  );
}

/**
 * Positions of a pattern's matches that are not negated just before ("not approved", "no restrictions" read as
 * clearing, "never blocked"). A blocking phrase that is a negation itself ("do not", "no longer") stands as it is.
 */
function marks(s: string, re: RegExp, blocking: boolean): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(re)) {
    const at = m.index!;
    const self = blocking && /^(?:no|not|never|do|does|don|dont|must|may|can|should|will|won|nobody)\b/.test(m[0]);
    if (!self && NEGATION.test(s.slice(Math.max(0, at - 24), at))) continue;
    // A clearing word in a condition is not a statement: "do not commit dates until the MSA is countersigned".
    if (!blocking && CONDITION.test(s.slice(Math.max(0, at - 48), at))) continue;
    out.push(at);
  }
  return out;
}

/**
 * A sentence's dated verdict. With a blocking statement: `conflict` when a span it states covers a day the request
 * acts on or a deadline or expiry falls before one, else `clear` (it is about other days). Without one: a deadline
 * before the request's days is still a conflict ("evidence by 29 Oct" against "next week"); one after them, or a
 * stated day or span that misses every day the request names, is `clear` (the caller reads that as "about other
 * days", not as a clearance). `none` when the sentence states no date.
 */
function dateVerdict(
  frame: Frame,
  st: Statement,
  now: number,
  blocked: boolean,
  vocab: boolean,
  anchor: number | null,
): Verdict {
  // The statement's patterns are read once (`planDates`, kept on it); only the days they name are worked out again
  // from `now` (D1932). Before, every request ran every date pattern over every dated statement of every candidate.
  let plan = st.dates;
  if (!plan || plan.vocab !== vocab || plan.anchor !== anchor) plan = st.dates = planDates(st.s, vocab, anchor);
  const d = replayDates(plan, now);
  if (d.spans.length === 0 && d.limits.length === 0) return "none";
  const late = d.limits.some((l) => frame.days.some((day) => day > l));
  const covered = d.spans.some((sp) => frame.days.some((day) => day >= sp.from && day <= sp.to));
  if (blocked) return late || covered ? "conflict" : "clear";
  if (d.limits.length > 0) return late ? "conflict" : "clear";
  return frame.named && !covered ? "clear" : "none";
}

/**
 * Whether a sentence (lower case) states something that stops, moves or settles an action (`BLOCKS`, `MOVES`,
 * `DONE`, `STANDING`).
 */
export function constrains(s: string): boolean {
  // Most sentences match none of the four: one search each (no match objects) answers them. `search` ignores the
  // shared lists' global `lastIndex`.
  if (s.search(BLOCKS) < 0 && s.search(MOVES) < 0 && s.search(DONE) < 0 && s.search(STANDING) < 0) return false;
  return (
    marks(s, BLOCKS, true).length > 0 ||
    marks(s, MOVES, true).length > 0 ||
    marks(s, DONE, true).length > 0 ||
    marks(s, STANDING, true).length > 0
  );
}

/**
 * Words that may state a limit or condition on an action though no verdict reads one ("withdrawals aren't possible
 * before maturity", "transfers are capped at", "pending approval"). Read only to open `readerGate`, so it errs wide.
 */
const GUARD_WORDING =
  /\b(?:must|has to|have to|limit(?:ed|s)?|capped|maximum|minimum|deadline|matur(?:es|ity)|locked|lock-?in|restrict(?:ed|ions?)?|pending|awaiting|notice period|penalt(?:y|ies)|not (?:yet|until))\b/;

/**
 * Whether a text (lower case) may state a constraint, in any of the verdict paths' words (`constrains`, the
 * `conflictVocab` lists) or the guard's own (`GUARD_WORDING`), ignoring idioms ("can't wait"). Wider than any verdict:
 * `readerGate` reads the request's candidates with it.
 */
export function mayConstrain(s: string): boolean {
  const t = s.slice(0, MAX_TEXT).replace(IDIOMS, " ");
  // `search` ignores the shared lists' global `lastIndex`.
  return constrains(t) || [BLOCKS_MORE, BLOCKS_OBJECT, STANDING_MORE, GUARD_WORDING].some((re) => t.search(re) >= 0);
}

/**
 * `readerGate`'s reading of an item's own words (D1880): whether its title and text, lower case, may state a
 * constraint (`mayConstrain`) or, with `visits` (`readerGateVisits`), an arranged visit (`arrangedVisit`). Both depend
 * on the item alone, and a request's candidates are mostly the last request's, so each is read once per item object
 * and kept on its `ANALYSES` entry (dropped with it when the text, title or date changes in place). Before, every
 * request lower-cased each candidate's text and ran about a dozen lists over it: 14% of `pipeline.bench.ts`'s CPU.
 */
export function gateOf(item: ContextItem, visits: boolean): boolean {
  const e = entryOf(item);
  let g = e.gate;
  let text: string | undefined;
  if ((g & 1) === 0) {
    text = `${item.title}. ${item.text}`.toLowerCase();
    g |= mayConstrain(text) ? 3 : 1;
  }
  if ((g & 2) === 0 && visits && (g & 4) === 0) {
    text ??= `${item.title}. ${item.text}`.toLowerCase();
    g |= arrangedVisit(text) ? 12 : 4;
  }
  e.gate = g;
  return (g & 2) !== 0 || (visits && (g & 8) !== 0);
}

/**
 * A visit someone has booked for the user ("i've booked the engineer, he'll come thursday between 8 and 12") or a
 * request that someone be in ("make sure someone's in?"): it binds the user's time though no constraint word says so.
 * The booking verb and the visit must share a sentence, within 60 characters. Read only by
 * `readerGateVisits` (R3-19, D124) to open `readerGate`.
 */
const BOOKED_VISIT =
  /\b(?:booked|arranged|scheduled|organi[sz]ed)\b[^.!?]{0,60}?\b(?:he|she|they|someone)(?:['\u2019]ll| will) (?:come|arrive|visit|call round|be round)\b/;
const BE_IN = /\bmake sure (?:someone['\u2019]s|someone is|you['\u2019]re|you are) (?:in|home|around)\s*(?:[.,;:!?]|$)/;

/** Whether a text (lower case) states an arranged visit or asks that someone be in (`BOOKED_VISIT`, `BE_IN`). */
export function arrangedVisit(s: string): boolean {
  const t = s.slice(0, MAX_TEXT);
  return t.search(BOOKED_VISIT) >= 0 || t.search(BE_IN) >= 0;
}

/**
 * The spans and limits a sentence states (`Dates`). With `vocab`, relative dates ("until Sunday", "till the 10th")
 * count from `anchor`, when the item was written; with no anchor they are not read.
 */
function datesOf(s: string, now: number, vocab = false, anchor: number | null = null, prefilter = true): Dates {
  const spans: { from: string; to: string }[] = [];
  const limits: string[] = [];
  // Every pattern that reads a month (`RANGE`, `PAIR`, `DATED`, `BACK_DATED`) needs a figure before a month's name or
  // one after it (`MONTH_DATE`, D1883): most dated statements hold only a time or a reference ("ref OPS-412").
  const monthed = !prefilter || MONTH_DATE.test(s);
  // Ranges first ("6-9 nov", "26 oct to 6 nov"); their text is blanked so their end is not read again as "until".
  let rest = !monthed
    ? s
    : s.replace(RANGE, (r, d1: string, d2: string, m: string, y: string | undefined) => {
        const from = dayOf(Number(d1), m, y, now);
        const to = dayOf(Number(d2), m, y, now);
        const end = from && to && !y ? after(from, to) : to;
        if (from && end && from <= end) spans.push({ from, to: end });
        return " ".repeat(r.length);
      });
  if (monthed)
    rest = rest.replace(PAIR, (r, ...g: (string | undefined)[]) => {
      const from = dayOf(Number(g[0]), g[1]!, g[2], now);
      const to = dayOf(Number(g[3]), g[4]!, g[5], now);
      // Each end's year is the one nearest now: in July, "20 Dec - 5 Jan" is 20 Dec this year to 5 Jan next.
      const end = from && to && !g[5] ? after(from, to) : to;
      if (from && end && from <= end) spans.push({ from, to: end });
      return " ".repeat(r.length);
    });
  // "Must be uploaded by 17:00 on Monday 26 October": a day in a sentence that sets a deadline is that deadline. Read
  // when a day is first taken (`rest` does not change after the blanking above).
  let deadline: boolean | undefined;
  let start: string | null = null;
  const take = (word: string, day: string, yearGiven = false) => {
    if (STARTS.has(word)) start = day;
    else if (ENDS.has(word)) {
      // "From Dec 20 to Jan 5": an end before its start, with no year said, is in the year after.
      const to = start && !yearGiven ? after(start, day) : day;
      if (to) spans.push({ from: start ?? iso(now), to });
      start = null;
    } else if (LIMITS.has(word) || (deadline ??= DEADLINE.test(rest))) limits.push(day);
    else spans.push({ from: day, to: day });
  };
  if (monthed)
    for (const m of rest.matchAll(DATED)) {
      const g = m.groups!;
      // "Expired on 30 September" is the expiry; "on" alone is a day.
      const word = g.word ?? (g.on ? "on" : "");
      // A date with no word or weekday before it ("reminder from legal (20 Oct)") is when something was written, not
      // a span a statement holds for.
      if (!word && !g.wd) continue;
      const day = g.d1
        ? dayOf(Number(g.d1), g.m1!, g.y1, now)
        : g.d2
          ? dayOf(Number(g.d2), g.m2!, g.y2, now)
          : lastOfMonth(g.m3!, g.y3!);
      if (day) take(word, day, Boolean(g.y1 ?? g.y2 ?? g.y3));
    }
  for (const m of rest.matchAll(YEAR_LIMIT)) take(m[1]!, `${m[2]}-12-31`, true);
  if (vocab) {
    // "Back 9 Nov", "back on the 10th", "back Thursday": away until the day before. A day of the month alone ("till
    // the 10th") is the next such day; a weekday after an end word ("until Sunday") the next such weekday.
    const end = (word: string, day: string | null) => {
      if (!day) return;
      if (word === "back") take("until", iso(Date.parse(`${day}T00:00:00Z`) - DAY));
      else take(word, day);
    };
    if (monthed) for (const m of rest.matchAll(BACK_DATED)) end("back", dayOf(Number(m[1]), m[2]!, undefined, now));
    if (anchor !== null) {
      for (const m of rest.matchAll(ORDINAL)) end(m[1]!, nextMonthDay(Number(m[2]), anchor));
      for (const m of rest.matchAll(WEEKDAY_END)) end(m[1]!, nextWeekday(m[2]!, anchor));
    }
  }
  // A start with no end: from then on ("pausing headcount from 19 Oct until Q1 planning").
  if (start) spans.push({ from: start, to: "9999-12-31" });
  return { spans, limits };
}

/** What a date word makes of its day in `datesOf`'s `take`: a span's start or end, a limit, or a day of its own. */
type Role = 0 | 1 | 2 | 3;
const ROLE_START = 0;
const ROLE_END = 1;
const ROLE_LIMIT = 2;
const ROLE_DAY = 3;

/**
 * One match of `datesOf`'s patterns, in the order it reads them, with what does not depend on `now` read already.
 * `Span`: a range or pair's two ends (`d1` of `m1`/`y1` to `d2` of `m2`/`y2`). `Take`: a dated day for `take`, the day
 * itself when it does not depend on `now` (`day`), else `d1` of `m1`/`y1`. `Back`: "back 9 Nov", the day before
 * `d1` of `m1` as an end.
 */
type DateOp =
  | { k: 0; d1: number; m1: string; y1: string | undefined; d2: number; m2: string; y2: string | undefined }
  | { k: 1; role: Role; yearGiven: boolean; day: string | null; d1: number; m1: string; y1: string | undefined }
  | { k: 2; d1: number; m1: string };

/** A statement's date matches (`planDates`) for one vocabulary and anchor: `replayDates` gives `datesOf`'s answer. */
interface DatePlan {
  vocab: boolean;
  anchor: number | null;
  ops: DateOp[];
}

const NO_DATE_OPS: DateOp[] = [];

/**
 * `datesOf(s, now, vocab, anchor)`'s pattern work, which depends on the sentence alone (D1932): the ranges and pairs
 * blanked, every date pattern's matches in the order `datesOf` reads them, the deadline test and the days that do not
 * depend on `now` (a bare year's end, a month's last day, a day counted from `anchor`). `replayDates` works out the
 * rest. `datesOf` stays as the reference (`opt-round4.test.ts` fuzzes the two against each other).
 */
function planDates(s: string, vocab: boolean, anchor: number | null): DatePlan {
  const ops: DateOp[] = [];
  const monthed = MONTH_DATE.test(s);
  let rest = s;
  if (monthed) {
    rest = s.replace(RANGE, (r, d1: string, d2: string, m: string, y: string | undefined) => {
      ops.push({ k: 0, d1: Number(d1), m1: m, y1: y, d2: Number(d2), m2: m, y2: y });
      return " ".repeat(r.length);
    });
    rest = rest.replace(PAIR, (r, ...g: (string | undefined)[]) => {
      ops.push({ k: 0, d1: Number(g[0]), m1: g[1]!, y1: g[2], d2: Number(g[3]), m2: g[4]!, y2: g[5] });
      return " ".repeat(r.length);
    });
  }
  let deadline: boolean | undefined;
  const roleOf = (word: string): Role =>
    STARTS.has(word)
      ? ROLE_START
      : ENDS.has(word)
        ? ROLE_END
        : LIMITS.has(word) || (deadline ??= DEADLINE.test(rest))
          ? ROLE_LIMIT
          : ROLE_DAY;
  const fixed = (word: string, day: string | null, yearGiven: boolean) => {
    if (day) ops.push({ k: 1, role: roleOf(word), yearGiven, day, d1: 0, m1: "", y1: undefined });
  };
  if (monthed) {
    for (const m of rest.matchAll(DATED)) {
      const g = m.groups!;
      const word = g.word ?? (g.on ? "on" : "");
      if (!word && !g.wd) continue;
      const yearGiven = Boolean(g.y1 ?? g.y2 ?? g.y3);
      if (g.d1) ops.push({ k: 1, role: roleOf(word), yearGiven, day: null, d1: Number(g.d1), m1: g.m1!, y1: g.y1 });
      else if (g.d2)
        ops.push({ k: 1, role: roleOf(word), yearGiven, day: null, d1: Number(g.d2), m1: g.m2!, y1: g.y2 });
      else fixed(word, lastOfMonth(g.m3!, g.y3!), yearGiven);
    }
  }
  for (const m of rest.matchAll(YEAR_LIMIT)) fixed(m[1]!, `${m[2]}-12-31`, true);
  if (vocab) {
    const end = (word: string, day: string | null) => {
      if (!day) return;
      if (word === "back") fixed("until", iso(Date.parse(`${day}T00:00:00Z`) - DAY), false);
      else fixed(word, day, false);
    };
    if (monthed) for (const m of rest.matchAll(BACK_DATED)) ops.push({ k: 2, d1: Number(m[1]), m1: m[2]! });
    if (anchor !== null) {
      for (const m of rest.matchAll(ORDINAL)) end(m[1]!, nextMonthDay(Number(m[2]), anchor));
      for (const m of rest.matchAll(WEEKDAY_END)) end(m[1]!, nextWeekday(m[2]!, anchor));
    }
  }
  return { vocab, anchor, ops: ops.length > 0 ? ops : NO_DATE_OPS };
}

/** `datesOf`'s answer at `now` from a statement's plan (`planDates`): the same spans and limits, in the same order. */
function replayDates(plan: DatePlan, now: number): Dates {
  const spans: { from: string; to: string }[] = [];
  const limits: string[] = [];
  const ops = plan.ops;
  if (ops.length === 0) return { spans, limits };
  let start: string | null = null;
  const take = (role: Role, day: string, yearGiven: boolean) => {
    if (role === ROLE_START) start = day;
    else if (role === ROLE_END) {
      const to = start && !yearGiven ? after(start, day) : day;
      if (to) spans.push({ from: start ?? iso(now), to });
      start = null;
    } else if (role === ROLE_LIMIT) limits.push(day);
    else spans.push({ from: day, to: day });
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.k === 0) {
      const from = dayOf(op.d1, op.m1, op.y1, now);
      const to = dayOf(op.d2, op.m2, op.y2, now);
      const end = from && to && !op.y2 ? after(from, to) : to;
      if (from && end && from <= end) spans.push({ from, to: end });
    } else if (op.k === 1) {
      const day = op.day ?? dayOf(op.d1, op.m1, op.y1, now);
      if (day) take(op.role, day, op.yearGiven);
    } else {
      const day = dayOf(op.d1, op.m1, undefined, now);
      if (day) take(ROLE_END, iso(Date.parse(`${day}T00:00:00Z`) - DAY), false);
    }
  }
  if (start) spans.push({ from: start, to: "9999-12-31" });
  return { spans, limits };
}

/** `datesOf` at each of `nows` from one plan of the sentence, as a cached statement is read, for tests. */
export function datesByPlan(s: string, nows: readonly number[], vocab: boolean, anchor: number | null): Dates[] {
  const plan = planDates(s, vocab, anchor);
  return nows.map((now) => replayDates(plan, now));
}

/** A limit on an amount: a threshold ("above £40,000", "over 10%") or a cap ("up to 20%", "capped at $5k"). */
const LIMIT =
  /\b(above|over|exceeds?|exceeding|more than|greater than|in excess of|up to|at most|most (?:[a-z']+ ){0,6}is|maximum(?: of)?|max|no more than|capped at|cap of|limit of)\s?([£€$]?\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn)\b)?\s?%?)/g;

/**
 * Whether an item states a limit on an amount ("travel over £500 needs pre-approval") that a request committing no
 * amount cannot be set against: then whether it binds the request is unknown, and with no model it is not raised
 * on its class's words alone (`consequenceProbe`).
 */
export function unmeasuredLimit(frame: Frame, item: ContextItem): boolean {
  if (frame.amounts.length > 0) return false;
  const text = `${item.title}. ${item.text}`.slice(0, MAX_TEXT).toLowerCase();
  for (const m of text.matchAll(LIMIT)) if (/[£€$%]/.test(m[2]!)) return true;
  return false;
}

/**
 * Amounts set against a limit the sentence states: above a threshold ("above £40,000 … two quotes are required",
 * "discounts above 10% need CFO sign-off") or a cap ("up to 20%", "the most we can offer is 8%") is a conflict, at or
 * under it clears. `none` when the request commits no amount in the sentence's unit or the sentence states no limit.
 */
function amountVerdict(frame: Frame, s: string): Verdict {
  if (frame.amounts.length === 0) return "none";
  let verdict: Verdict = "none";
  for (const m of s.matchAll(LIMIT)) {
    const [limit] = amountsOf(m[2]!, false);
    if (!limit) continue;
    const mine = frame.amounts.filter((a) => a.unit === limit.unit);
    if (mine.length === 0) continue;
    if (mine.some((a) => a.value > limit.value)) return "conflict";
    verdict = "clear";
  }
  return verdict;
}

/**
 * Money and percentages in a text. A bare number is none. With `perHead`, "15 people … £85 a head" adds the total
 * (£1,275), which is what a limit on an event's cost is set against.
 */
function amountsOf(text: string, perHead: boolean): Amount[] {
  const out: Amount[] = [];
  const t = text.toLowerCase();
  for (const m of t.matchAll(/([£€$])\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|bn)?\b|\b(\d+(?:\.\d+)?)\s?%/g)) {
    if (m[4]) out.push({ unit: "%", value: Number(m[4]) });
    else out.push({ unit: m[1]!, value: Number(m[2]!.replace(/,/g, "")) * scale(m[3]) });
  }
  if (perHead) {
    const people = /\b(\d{1,4})\s(?:people|guests|persons|attendees|covers|heads|of us)\b/.exec(t);
    const each = /([£€$])\s?(\d[\d,]*(?:\.\d+)?)\s(?:a|per|each)\s(?:head|person|cover|guest)\b/.exec(t);
    if (people && each) out.push({ unit: each[1]!, value: Number(people[1]) * Number(each[2]!.replace(/,/g, "")) });
  }
  return out;
}

const scale = (s: string | undefined) => (s === "k" ? 1_000 : s === "m" ? 1_000_000 : s === "bn" ? 1e9 : 1);

/**
 * References a text names: identifiers (letters, an optional hyphen, digits: "INV-5842", "SOW-123") and nouns
 * qualified by a quarter, a half, a month or a year ("Q3 report", "October invoice", "2027 roadmap").
 */
function refsOf(text: string, domains = false): Ref[] {
  const out: Ref[] = [];
  // An identifier: two to six letters, a hyphen or not, two digits or more ("INV-5842", "SOW-123", "PO4471").
  for (const m of text.matchAll(/\b([A-Za-z]{2,6})-?(\d{2,9})\b/g)) {
    const kind = m[1]!.toLowerCase();
    // A time ("pm"), an ordinal, a unit or a year's prefix is not a reference.
    if (/^(am|pm|st|nd|rd|th|gb|mb|kb|px|bn|no|ref|fy|cy|utc|gmt|bst|cet|est|pst)$/.test(kind)) continue;
    out.push({ kind, value: m[2]!, noun: "" });
  }
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(new RegExp(`\\b(q[1-4]|h[12]|${MON}|20\\d\\d)(?:'s)? ([a-z]{4,})\\b`, "g"))) {
    const q = m[1]!;
    const kind = /^q\d$/.test(q) ? "quarter" : /^h\d$/.test(q) ? "half" : /^\d/.test(q) ? "year" : "month";
    out.push({ kind, value: kind === "month" ? q.slice(0, 3) : q, noun: m[2]! });
  }
  // `conflictVocab`: a domain is an identifier too ("renew northwind-events.com" is not "northwind-promo.com"). Not
  // an address's domain ("@northwind.co") nor a host inside a longer name or path.
  if (domains) for (const m of lower.matchAll(DOMAIN)) out.push({ kind: "domain", value: m[1]!, noun: "" });
  return out;
}

/** Whether a request names a domain: only then is an item's text searched for domains (the scan is not free). */
const hasDomain = (frame: Frame) => frame.refs.some((r) => r.kind === "domain");

/** A domain name: labels and a common top-level domain, not after "@", "/", "." or a word character. */
const DOMAIN =
  /(?<![@/.\w-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|uk|dev|app|ai|eu|de|fr|nl|us|info|biz))(?![\w-]|\.\w)/g;

/**
 * Whether an item is about a sibling of a reference the request names: the same kind and noun with another value,
 * and never the requested one ("Q2 report" for "Q3 report", "INV-5825" for "INV-5842").
 */
function twin(asked: Ref[], said: Ref[]): boolean {
  for (const a of asked) {
    const same = (r: Ref) => r.kind === a.kind && r.noun === a.noun;
    if (said.some((r) => same(r) && r.value === a.value)) continue;
    if (said.some((r) => same(r) && r.value !== a.value)) return true;
  }
  return false;
}

/** The ISO day for a day and month, the year given or the one nearest `now`. */
function dayOf(day: number, month: string, year: string | undefined, now: number): string | null {
  const mi = MONTHS.indexOf(month.slice(0, 3));
  if (mi < 0 || day < 1 || day > 31) return null;
  // "31 Feb" is no day (Date.UTC would roll it to 3 Mar); 29 Feb is a day only in a leap year.
  const real = (t: number) => new Date(t).getUTCDate() === day;
  if (year) {
    const t = Date.UTC(Number(year), mi, day);
    return real(t) ? iso(t) : null;
  }
  const y = new Date(now).getUTCFullYear();
  let best = 0;
  for (const c of [y - 1, y, y + 1]) {
    const t = Date.UTC(c, mi, day);
    if (real(t) && (best === 0 || Math.abs(t - now) < Math.abs(best - now))) best = t;
  }
  return best === 0 ? null : iso(best);
}

/** An end day not before `start`: an ISO day before it moves to the year after (null if that day does not exist). */
function after(start: string, end: string): string | null {
  if (end >= start) return end;
  const next = `${Number(end.slice(0, 4)) + 1}${end.slice(4)}`;
  return iso(Date.parse(`${next}T00:00:00Z`)) === next ? next : null;
}

/** The last day of a month of a year ("October 2027" as a limit means its end). */
function lastOfMonth(month: string, year: string): string | null {
  const mi = MONTHS.indexOf(month.slice(0, 3));
  if (mi < 0) return null;
  return new Date(Date.UTC(Number(year), mi + 1, 1) - DAY).toISOString().slice(0, 10);
}

/** A word without its plural "s" ("releases" ties to "release"); short words as they are. */
const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** When an item was written: its `Date:` header, else its `updatedAt`; null when neither is known. */
export function sentAt(item: ContextItem): number | null {
  const m = /^date:\s*([^\n]{0,60})$/im.exec(item.text.slice(0, 600));
  // Read as UTC when it names no zone (`parseWhen`), so the answer does not depend on the host's zone.
  const t = m ? parseWhen(m[1]!.replace(/,/g, "")) : NaN;
  if (Number.isFinite(t)) return t;
  return item.updatedAt ?? null;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A word without a possessive ("leila's" is "leila", "mum's" is "mum"). */
const unpossess = (w: string) => w.replace(/['\u2019]s$/, "").replace(/['\u2019]$/, "");

/** The next day (today included) whose day of the month is `day`; null if none within two months. */
function nextMonthDay(day: number, now: number): string | null {
  const d = new Date(now);
  for (let k = 0; k < 3; k++) {
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, day);
    if (new Date(t).getUTCDate() === day && iso(t) >= iso(now)) return iso(t);
  }
  return null;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** The next such weekday, today included. */
function nextWeekday(name: string, now: number): string | null {
  const want = WEEKDAYS.indexOf(name.slice(0, 3));
  if (want < 0) return null;
  const today = new Date(now).getUTCDay();
  return iso(now + ((want - today + 7) % 7) * DAY);
}
