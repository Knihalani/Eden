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
 * Statements that the action is done already: paying, sending or filing again is the mistake. When it was done does
 * not matter, unlike a block's dates.
 */
const DONE =
  /\b(?:already (?:been |[a-z]+ed\b|paid|sent|done|bought|got)|was paid|we paid|been paid|paid in full|payment sent|was sent on|been sent|been submitted|by mistake|nothing (?:further|more) (?:is )?owed|auto-?renew(?:al)? (?:is )?on)\b/gi;

/** Statements that a matter is clear: lifted, restored, unchanged, allowed, still on. */
const CLEARS = new RegExp(
  `\\b(?:${[
    "lifted|restored|reinstated|resolved|unchanged|no changes?|not changed|stands|holds|still (?:on|valid|good|works)",
    "remains?|stays? (?:the same|active|on|open|valid|at|in place|unchanged)|active\\b|approved for|cleared (?:it )?for|cleared to|clear to|is clear|all clear|is fine",
    "are fine|fine by me|all good|works for|happy (?:from|to|with)|permits?|permitted|allows?|allowed to",
    "may be (?:shared|used)|can be (?:shared|used)|can go ahead|good to go|no (?:current )?conflict|no restrictions?",
    "no open|no need|negative|came back clear|eat(?:ing)? everything|as usual|as normal|as planned|went fine",
    "extended|renewed|back at|back from|valid (?:to|until)|signed off|countersigned|approved\\b|keeps? [a-z]+ing (?:to|as)",
    "(?:with |at )?no (?:charge|fee|penalty|cost)|free of charge|without (?:a |any )?(?:charge|fee|penalty)",
  ].join("|")})\\b`,
  "gi",
);

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

/** One sentence's dated statements. */
interface Dates {
  spans: { from: string; to: string }[];
  limits: string[];
}

/** The request's frame: its days, amounts and references (`Frame`). */
export function frameOf(raw: string, days: Iterable<string> | null, now: number, names: string[] = []): Frame {
  const text = raw.slice(0, 2_000).replace(/[\u2013\u2014]/g, "-");
  const named = days !== null && [...days].length > 0;
  const refs = refsOf(text);
  // Names as names: capitalised words, at most four (an entity run can be a quoted subject line).
  const lower = names.filter((n) => NAME.test(n.trim())).map((n) => n.trim().toLowerCase());
  const nameTies = new Set<string>([
    ...lower.flatMap((n) => n.split(/\s+/)).filter((w) => w.length > 1),
    ...refs.filter((r) => r.noun === "").map((r) => `${r.kind}-${r.value}`),
  ]);
  const wordTies = new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? []).filter((w) => !UNTIED.test(w)).map(stem),
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
 */
export function assess(frame: Frame, item: ContextItem, now: number): Verdict {
  // A message from someone the request names speaks for them: its "I" is them ("I'm vegetarian" from Sam).
  const sender = /^from:\s*([^<\n]{2,80})/im.exec(item.text.slice(0, 2_000))?.[1]?.toLowerCase() ?? "";
  const fromNamed = sender !== "" && frame.names.some((n) => n.split(/\s+/).every((w) => sender.includes(w)));
  // A statement is tied to the request when it holds one of its words, or speaks in the first person from someone
  // it names. Only a tied statement's conflict is the request's ("travel over £500 needs pre-approval" in a mail
  // from Oskar is no conflict with lunch with Oskar). A request that names someone ties by name only: another
  // company's overdue invoice shares its words, not its names. A chat line's speaker ("[09:14] Lars: …") is who says
  // it, like a message's sender.
  const isNamed = (who: string) => frame.names.some((n) => n.split(/\s+/).every((w) => who.includes(w)));
  const tied = (line: string) => {
    const said = SPEAKER.exec(line);
    const s = said ? line.slice(said[0].length) : line;
    const words = (s.match(/[a-z][a-z0-9'-]{1,}/g) ?? []).map(stem);
    const ties = frame.names.length > 0 ? [frame.nameTies] : [frame.nameTies, frame.wordTies];
    if (words.some((w) => ties.some((t) => t.has(w)))) return true;
    return (fromNamed || (said !== null && isNamed(said[1]!))) && FIRST_PERSON.test(s);
  };
  // The message's own words: no headers, greetings, signature, confidentiality footer or notification boilerplate
  // ("This email and any attachments are confidential" is no constraint on anything).
  const whole = `${item.title}. ${compactText(item.text.slice(0, MAX_TEXT).replace(HEADERS, ""), NO_FOCUS, MAX_TEXT)}`;
  // A sibling reference: the item is about Q2 where the request says Q3, another invoice than the one named.
  if (twin(frame.refs, refsOf(whole))) return "clear";
  const body = whole.toLowerCase().replace(/[\u2013\u2014]/g, "-");
  let state: Verdict = "none";
  // Whether a statement behind the current conflict is tied to the request.
  let tiedConflict = false;
  // A conflict read from a date, an amount, a thing done or a standing constraint is firm: only a clearing
  // statement about the same matter (sharing a word with it) undoes it. "Passport expires 2 Nov" stands after
  // "driving licence renewed 2024"; "SOC 2 report expired 30 Sep" falls to "the renewed report was accepted".
  let firm: Set<string> | null = null;
  // Cleared by a date: the block is about other days.
  let elsewhere = false;
  const conflict = (s: string, isFirm: boolean, money = false) => {
    // A conflict on an amount is tied by the amount itself; a statement is also tied by the sentence before it, or by
    // the item's title, naming what it is about ("Rebecca Stone (Soylent Foods)". "Status: no longer at …").
    const t = money || tied(s) || tied(before) || titled;
    tiedConflict = state === "conflict" ? tiedConflict || t : t;
    state = "conflict";
    if (isFirm) firm = wordsOf(s);
  };
  // A clearance is a near-miss twin's mark only where something could have blocked: after a blocking statement in
  // the item, or in words that say a block is gone ("lifted", "back from leave", "unchanged"). "Happy to jump on a
  // call" clears nothing.
  let blockSeen = false;
  const clear = (s: string) => {
    if (!blockSeen && !REVERSAL.test(s)) return;
    if (firm && ![...wordsOf(s)].some((w) => firm!.has(w))) return;
    state = "clear";
    firm = null;
    elsewhere = false;
  };
  const titled = tied(item.title.toLowerCase());
  let before = "";
  let s = "";
  for (const sentence of body.split(/[.!?;\n]+\s|\n+|,? but |\s(?=\[\d{1,2}:\d{2}\])/)) {
    before = s;
    // A restriction that has ended is lifted: "the minimum term ended on 30 Jun" frees the request, unlike "the
    // passport expired on 30 Sep", where what ended is the thing the request needs.
    s = sentence.trim().replace(RESTRICTION_ENDED, "$1 lifted");
    if (s.length < 3 || BOILER.test(s)) continue;
    const money = amountVerdict(frame, s);
    if (money === "conflict") conflict(s, true, true);
    else if (money === "clear") [state, firm] = ["clear", null];
    if (money !== "none") continue;
    const lastBlock = Math.max(-1, ...marks(s, BLOCKS, true));
    const lastClear = Math.max(-1, ...marks(s, CLEARS, false));
    // Something done already, or a standing constraint (an allergy, a confidentiality): when does not matter, and
    // a clearing word after it in the same sentence undoes it ("tested for coeliac and it's negative").
    // So is a change to what the request assumes is as usual ("same as usual" against "goes from £1650 to £1710").
    const lastDone = Math.max(
      -1,
      ...marks(s, DONE, true),
      ...marks(s, STANDING, true),
      ...(frame.routine ? marks(s, CHANGES, true) : []),
    );
    const lastMove = Math.max(-1, ...marks(s, MOVES, true));
    if (lastBlock >= 0 || lastDone >= 0 || lastMove >= 0) blockSeen = true;
    if (lastDone > lastClear) conflict(s, true);
    else if (lastClear > Math.max(lastBlock, lastMove)) {
      // A clearing statement with a date of its own ("EHIC valid to 2029") is about its own matter.
      if (!(firm && dateVerdict(frame, s, now, false) !== "none")) clear(s);
    } else {
      const dated = dateVerdict(frame, s, now, lastBlock >= 0);
      if (dated === "conflict") conflict(s, true);
      else if (lastMove >= 0) {
        // Moved: unless the request acts on the new day, it acts on the old one. Days after "from" are the old ones.
        const fresh = datesOf(s.replace(/\bfrom (?:[a-z]+,? )?\d{1,2}(?:st|nd|rd|th)? [a-z]+/g, " "), now);
        // The day it moved to is the end of what is read as a span ("to Friday 30 October").
        const onNew = frame.named && fresh.spans.some((sp) => frame.days.includes(sp.to));
        if (onNew) clear(s);
        else conflict(s, false);
      } else if (dated === "clear") {
        // A block over other days clears; a date with no block only says later blocks are about other days.
        if (lastBlock >= 0) clear(s);
        elsewhere = true;
      }
      // A block with no date of its own repeats a dated one before it ("… while Robert is away").
      else if (lastBlock >= 0 && !firm && !elsewhere) conflict(s, false);
    }
  }
  // (`state` is set in the closures above, which narrowing does not see.)
  const verdict = state as Verdict;
  return verdict === "conflict" && !tiedConflict ? "none" : verdict;
}

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
  const said = refsOf(`${item.title} ${item.text}`.slice(0, MAX_TEXT));
  return ids.some((a) => said.some((r) => r.kind === a.kind && r.value === a.value));
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
function dateVerdict(frame: Frame, s: string, now: number, blocked: boolean): Verdict {
  const d = datesOf(s, now);
  if (d.spans.length === 0 && d.limits.length === 0) return "none";
  const late = d.limits.some((l) => frame.days.some((day) => day > l));
  const covered = d.spans.some((sp) => frame.days.some((day) => day >= sp.from && day <= sp.to));
  if (blocked) return late || covered ? "conflict" : "clear";
  if (d.limits.length > 0) return late ? "conflict" : "clear";
  return frame.named && !covered ? "clear" : "none";
}

/** The spans and limits a sentence states (`Dates`). */
function datesOf(s: string, now: number): Dates {
  const spans: { from: string; to: string }[] = [];
  const limits: string[] = [];
  // Ranges first ("6-9 nov", "26 oct to 6 nov"); their text is blanked so their end is not read again as "until".
  let rest = s.replace(RANGE, (r, d1: string, d2: string, m: string, y: string | undefined) => {
    const from = dayOf(Number(d1), m, y, now);
    const to = dayOf(Number(d2), m, y, now);
    if (from && to && from <= to) spans.push({ from, to });
    return " ".repeat(r.length);
  });
  rest = rest.replace(PAIR, (r, ...g: (string | undefined)[]) => {
    const from = dayOf(Number(g[0]), g[1]!, g[2], now);
    const to = dayOf(Number(g[3]), g[4]!, g[5], now);
    if (from && to && from <= to) spans.push({ from, to });
    return " ".repeat(r.length);
  });
  // "Must be uploaded by 17:00 on Monday 26 October": a day in a sentence that sets a deadline is that deadline.
  const deadline = DEADLINE.test(rest);
  let start: string | null = null;
  const take = (word: string, day: string) => {
    if (STARTS.has(word)) start = day;
    else if (ENDS.has(word)) {
      spans.push({ from: start ?? iso(now), to: day });
      start = null;
    } else if (LIMITS.has(word) || deadline) limits.push(day);
    else spans.push({ from: day, to: day });
  };
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
    if (day) take(word, day);
  }
  for (const m of rest.matchAll(YEAR_LIMIT)) take(m[1]!, `${m[2]}-12-31`);
  // A start with no end: from then on ("pausing headcount from 19 Oct until Q1 planning").
  if (start) spans.push({ from: start, to: "9999-12-31" });
  return { spans, limits };
}

/**
 * Amounts set against a limit the sentence states: above a threshold ("above £40,000 … two quotes are required",
 * "discounts above 10% need CFO sign-off") or a cap ("up to 20%", "the most we can offer is 8%") is a conflict, at or
 * under it clears. `none` when the request commits no amount in the sentence's unit or the sentence states no limit.
 */
function amountVerdict(frame: Frame, s: string): Verdict {
  if (frame.amounts.length === 0) return "none";
  let verdict: Verdict = "none";
  for (const m of s.matchAll(
    /\b(above|over|exceeds?|exceeding|more than|greater than|in excess of|up to|at most|most (?:[a-z']+ ){0,6}is|maximum(?: of)?|max|no more than|capped at|cap of|limit of)\s?([£€$]?\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn)\b)?\s?%?)/g,
  )) {
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
function refsOf(text: string): Ref[] {
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
  return out;
}

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

/** The last day of a month of a year ("October 2027" as a limit means its end). */
function lastOfMonth(month: string, year: string): string | null {
  const mi = MONTHS.indexOf(month.slice(0, 3));
  if (mi < 0) return null;
  return new Date(Date.UTC(Number(year), mi + 1, 1) - DAY).toISOString().slice(0, 10);
}

/** A word without its plural "s" ("releases" ties to "release"); short words as they are. */
const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
