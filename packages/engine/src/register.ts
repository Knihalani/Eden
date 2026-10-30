/**
 * The standing-constraints register (`config.register`, off by default): the rules, limits and states in a user's
 * items that govern what they do next, read from structure and modality rather than from topic. "No production
 * changes from 28 Oct to 3 Nov", "discounts above 10% need CFO sign-off", "Rebecca is no longer at Soylent Foods",
 * "our portal locks at 17:00 on 26 October" each bind a later action that shares few or none of their words. An item
 * that states one is kept as a compact record (`Constraint`): its subject words, the amounts it caps, the days it
 * holds and the day after which it is too late. A request to act is checked against the user's records:
 *
 * - with a judge, a record the request conflicts with (an amount over its cap, a day inside its span or past its
 *   deadline, a standing state), or that shares a subject word and a name with it, gets a seat among the candidates;
 * - with no model, only a structural conflict about what the request is about is delivered (`judge`): an amount over
 *   a stated cap, a day inside a stated span or after a stated deadline, or a standing state of someone the request
 *   names. A decoy that differs in exactly the date, amount or state (a freeze in another week, a cap above the
 *   amount, a hold that was lifted) is rejected by the same check.
 *
 * Everything is linear in the item's head (`MAX_CHARS`): one pass to split sentences, bounded patterns per sentence.
 * Nothing calls a model, and nothing here calls a source.
 */
import type { ContextItem } from "@eden/protocol";
import { isStopword } from "./text";

/** An amount a rule caps: a currency ("£", "€", "$") or a percentage ("%"). */
export interface Limit {
  value: number;
  unit: string;
}

/** Inclusive ISO days. An open end is "0000-01-01" or "9999-12-31". */
export interface Span {
  from: string;
  to: string;
}

/** One sentence's rule or state. */
export interface Rule {
  /** The days it holds; empty when the sentence names none (it holds now). */
  spans: Span[];
  /** The last day to act ("by 26 Oct", "closes 2 Nov"); acting after it is too late. An expiry is a state instead. */
  deadline: string | null;
  /** Amounts it caps ("above €25,000", "up to 20%", "the most … is 8%"). */
  limits: Limit[];
  /** Whether it states a blocking state (left, suspended, on hold, allergic …) rather than a prohibition alone. */
  status: boolean;
  /** A state strong enough to bind a request naming its subject, with no model (`STRONG`). */
  strong: boolean;
}

/** An item's standing constraints: its rules, and the words of what they are about. */
export interface Constraint {
  rules: Rule[];
  /** It states a person's own state or a formal prohibition (`PERSONAL`, `FORMAL`): about whoever it names. */
  firm: boolean;
  /** Subject words (lower case, four letters or more) of its title and its rules' sentences. */
  terms: string[];
}

/**
 * What a sweep asks each source for (`config.registerSweepMs`): the nouns and states rules are written in, each a
 * one-word search that any search semantics answers (an all-words search, a ranked one, a substring).
 */
export const SWEEP_WORDS = ["policy", "freeze", "hold", "suspended", "leave", "approval"];

/** Characters of an item read: rules are stated early, and the scan stays linear and small. */
const MAX_CHARS = 2_000;
const PAST = "0000-01-01";
const FUTURE = "9999-12-31";

/**
 * Prohibitions: what must not be done, or not yet. A sentence stating one binds the days it names (a freeze from 28
 * Oct to 3 Nov) and, undated, binds now.
 */
const PROHIBIT =
  /\b(mustn't|must not|may not|cannot|can't|can ?not|do not|don't|should not|shouldn't|not (?:to be|allowed|permitted|movable)|never|no-go|forbidden|prohibited|strictly|confidential|not before|freeze|frozen|embargo\w*|moratorium|blackout|paus(?:e|es|ed|ing)|(?:legal|litigation) hold|on hold|is off|no longer|^no\s+(?:[\w-]+\s+){1,4}(?:until|from|during|before|without|while|unless|to be|may|can|are|is)\b)\b/i;
/** The prohibitions formal enough to bind a request naming their subject with no model ("do not tell them"). */
const FORMAL =
  /\b(must not|may not|not (?:to be|allowed|permitted)|forbidden|prohibited|no-go|(?:do not|don't) (?:share|send|forward|contact|commit|delete|edit|tell|mention|book|sign|use|invite|announce|publish|disclose|email|call))\b/i;
/** Conditions on acting: what is required first ("needs CFO sign-off", "requires two quotes", "policy"). */
const CONDITIONAL =
  /\b(must|required|requires?|needs? (?:\w+ ){0,3}(?:approval|sign-?off|countersignature|consent)|approval|sign-?off|policy)\b/i;
/** States that block or change how to act toward someone or something. */
const STATUS =
  /\b(on hold|suspended|blocked|lapsed|expire[sd]?|expiring|ended|terminated|offboarded|no longer|inactive|discontinued|retir(?:ed|ing)|cancell?ed|closed[ -]lost|withdrawn|revoked|deactivated|bounces|out of (?:the )?office|on (?:\w+ )?leave|offline|unavailable|allergic|allergy|intoleran\w*|coeliac|celiac|slips|slipped|postponed|superseded|pulled|closed|in dispute|disputed)\b/i;
/** The states that bind a request naming their subject even with no model: who has gone, what no longer works. */
const STRONG =
  /\b(suspended|blocked|lapsed|expired|terminated|offboarded|no longer|inactive|discontinued|revoked|deactivated|bounces|closed[ -]lost|allergic|allergy|coeliac|celiac|out of (?:the )?office|on (?:\w+ )?leave|on hold)\b/i;
/** A person's own state: what they cannot eat, that they have gone or are away. It is about whoever it names. */
const PERSONAL =
  /\b(allergic|allergy|intoleran\w*|coeliac|celiac|vegan|no longer at|offboarded|on (?:\w+ )?leave|out of (?:the )?office|bereave\w*|passed away)\b/i;
/** States that last once begun: a date beside one is when it began ("Closed Lost (20 Oct)", "left on 9 Oct"). */
const LASTING =
  /\b(lapsed|expired|terminated|offboarded|no longer|inactive|discontinued|revoked|deactivated|bounces|closed[ -]lost|retired|allergic|allergy|coeliac|celiac|left)\b/i;
/** Someone gone: "left Vandelay Industries", "has left the company" (a capital after it: an organisation). */
const LEFT = /\b(?:has |have |had )?left (?:the (?:company|business|team|firm)|[A-Z])/;
/**
 * Words saying a rule or state no longer holds, or never did: the hold was lifted, access restored, the report
 * accepted. Not inside a condition ("until the MSA is countersigned" is when it will end, not that it has).
 */
const COUNTER =
  /\b(lifted|restored|reinstated|renewed|cleared|approved|accepted|signed off|countersigned|resolved|back (?:at|from)|returned|remains|status: active|is active|fine again|apply again|applies again|as usual|no need|holds|stands|unchanged|no change|came through|went ahead|tested negative|negative)\b/gi;
/** A condition the counter word sits in ("until", "unless", "once", "when", "before", "if"). */
const CONDITION = /\b(until|till|unless|once|when|before|if|after|pending)\b[^.;!?]{0,80}$/i;
/** A counter word that is still required ("must be pre-approved", "needs to be cleared"), not a fact. */
const REQUIRED = /\b(must|should|needs? to|has to|have to|to be|pre-?)\s*(be\s+)?(pre-?)?$/i;
const NEGATED = /(?:\bnot|n't|\bnever|\bno|\bcannot)\s+(\w+\s+)?$/i;

/** A comparison that makes the next amount a cap. */
const CAP =
  /\b(above|over|more than|exceed(?:s|ing)?|greater than|beyond|up to|maximum(?: of)?|max|at most|no more than|capped at|cap of|limit(?:ed)? (?:of|to)|threshold(?: of)?|the most (?:\w+ ){0,6}(?:is|are))\s*$/i;
const AMOUNT = /([£€$])\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|bn)?\b|\b(\d+(?:\.\d+)?)\s?%/gi;

const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ORD = "(?:st|nd|rd|th)?";
const SEP = "\\s*(?:-|–|—|to|until|till|through|thru)\\s*";
/** "6–9 Nov", "6 to 9 November", "28 October to 3 November 2026". */
const RANGE_DM = new RegExp(
  `\\b(\\d{1,2})${ORD}(?:\\s+(?:of\\s+)?${MONTH})?(?:\\s+(\\d{4}))?${SEP}(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH}\\b(?:,?\\s+(\\d{4}))?`,
  "g",
);
/** "Nov 6–9", "Nov 6 to Nov 9". */
const RANGE_MD = new RegExp(
  `\\b${MONTH}\\s+(\\d{1,2})${ORD}${SEP}(?:${MONTH.replace("(", "(?:")}\\s+)?(\\d{1,2})${ORD}\\b`,
  "g",
);
const DATE_DM = new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH}\\b(?:,?\\s+(\\d{4}))?`, "g");
const DATE_MD = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORD}\\b(?:,?\\s+(\\d{4}))?`, "g");
/** A weekday before a date ("Thu 29 Oct", "Friday 6 to Monday 9 November"): dropped, the date says the day. */
const WEEKDAY = /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b,?\s*(?=\d)/g;
/** What the words just before a date make of it. */
const FROM =
  /\b(from|as of|since|effective(?: from)?|starting(?: with)?(?: the)?|beginning|with effect from)\s*(?:on\s+)?$/;
const UNTIL = /\b(until|till|through|thru|not before|before|back on|back|returning(?: on)?)\s*(?:on\s+)?$/;
// A time of day may sit between ("by 17:00 UK time on 26 October", "by close of business on 2 Nov").
const BY =
  /\b(by|deadline(?: is| of)?|due|closes?|locks?|(expires?|expired|expiring|expiry(?: date)?:?|valid (?:to|until|till)))(?:\s+(?:\d{1,2}(?::\d\d)?(?:am|pm)?|noon|midday|midnight|uk|gmt|bst|cet|utc|local|time|the|end|close|of|business|day|cob|eod))*\s*(?:on\s+)?$/;

/** The day a date names, as ISO: the year given, else the one that puts it nearest after `now` less two months. */
function isoDay(day: number, month: string, year: string | undefined, now: number): string | null {
  const mi = MONTHS.indexOf(month.slice(0, 3));
  if (mi < 0 || day < 1 || day > 31) return null;
  const years = year ? [Number(year)] : [-1, 0, 1].map((k) => new Date(now).getUTCFullYear() + k);
  for (const y of years) {
    const d = new Date(Date.UTC(y, mi, day));
    if (d.getUTCDate() !== day) return null;
    if (year || (d.getTime() >= now - 60 * 86_400_000 && d.getTime() <= now + 300 * 86_400_000)) {
      return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

const dayAfter = (d: string) => new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10);
const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);

/** The spans and deadline a sentence's dates give, read from the words before each date. */
function datesOf(sentence: string, now: number): { spans: Span[]; deadline: string | null } {
  const s = sentence.toLowerCase().replace(WEEKDAY, "");
  const spans: Span[] = [];
  const deadlines: string[] = [];
  const taken: [number, number][] = [];
  for (const m of s.matchAll(RANGE_DM)) {
    const to = isoDay(Number(m[4]), m[5]!, m[6], now);
    const from = isoDay(Number(m[1]), m[2] ?? m[5]!, m[3] ?? m[6], now);
    if (from && to && from <= to) spans.push({ from, to });
    taken.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of s.matchAll(RANGE_MD)) {
    if (taken.some(([a, b]) => m.index! < b && m.index! + m[0].length > a)) continue;
    const from = isoDay(Number(m[2]), m[1]!, undefined, now);
    const to = isoDay(Number(m[3]), m[1]!, undefined, now);
    if (from && to && from <= to) spans.push({ from, to });
    taken.push([m.index!, m.index! + m[0].length]);
  }
  const singles = [
    ...[...s.matchAll(DATE_DM)].map((m) => ({ at: m.index!, end: m.index! + m[0].length, d: [m[1]!, m[2]!, m[3]] })),
    ...[...s.matchAll(DATE_MD)].map((m) => ({ at: m.index!, end: m.index! + m[0].length, d: [m[2]!, m[1]!, m[3]] })),
  ];
  for (const x of singles) {
    if (taken.some(([a, b]) => x.at < b && x.end > a)) continue;
    const d = isoDay(Number(x.d[0]), x.d[1]!, x.d[2], now);
    if (!d) continue;
    const before = s.slice(Math.max(0, x.at - 32), x.at);
    const back = /\b(back(?: on)?|returning(?: on)?)\s*(?:on\s+)?$/.test(before);
    let by: RegExpExecArray | null;
    if (FROM.test(before)) spans.push({ from: d, to: FUTURE });
    else if (UNTIL.test(before)) spans.push({ from: PAST, to: back ? dayBefore(d) : d });
    else if ((by = BY.exec(before))) {
      // An expiry is a state from the day after: "expired 30 Sep" is expired now, not a deadline missed.
      if (by[2]) spans.push({ from: dayAfter(d), to: FUTURE });
      else deadlines.push(d);
    } else spans.push({ from: d, to: d });
  }
  return { spans, deadline: deadlines.sort()[0] ?? null };
}

/** The caps a sentence states: an amount after a comparison ("above €25,000", "up to 20%"). */
function limitsOf(sentence: string): Limit[] {
  const out: Limit[] = [];
  for (const m of sentence.matchAll(AMOUNT)) {
    if (!CAP.test(sentence.slice(Math.max(0, m.index! - 48), m.index!))) continue;
    const l = amountOf(m);
    if (l) out.push(l);
  }
  return out;
}

function amountOf(m: RegExpMatchArray): Limit | null {
  if (m[4] !== undefined) return { value: Number(m[4]), unit: "%" };
  const v = Number(m[2]!.replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  const k = (m[3] ?? "").toLowerCase();
  return { value: v * (k === "k" ? 1e3 : k === "m" ? 1e6 : k === "bn" ? 1e9 : 1), unit: m[1]! };
}

/** A count of people ("for 14 people", "12 guests"), and an amount per person ("£85 a head", "€40 each"). */
const HEADS = /\b(\d{1,4})\s+(?:people|persons|guests|covers|attendees|heads|staff|of us)\b/i;
const EACH = /^\s*(?:a|per|each|\/)\s*(?:head|person|guest|cover|pp)\b|^\s*(?:each|pp)\b/i;

/**
 * The amounts a request names ("15% off", "£48k", "€43,000"), and the total of one written per person for a count
 * of people ("14 people … £85 a head" is £1,190 too): a cap is on what is spent.
 */
export function amountsOf(raw: string): Limit[] {
  const out: Limit[] = [];
  const text = raw.slice(0, MAX_CHARS);
  const heads = HEADS.exec(text);
  for (const m of text.matchAll(AMOUNT)) {
    const l = amountOf(m);
    if (!l) continue;
    out.push(l);
    if (heads && l.unit !== "%" && EACH.test(text.slice(m.index! + m[0].length, m.index! + m[0].length + 16))) {
      out.push({ value: l.value * Number(heads[1]), unit: l.unit });
    }
  }
  return out;
}

/** Words that say nothing about what a rule is about. */
const PLAIN = new Set(
  (
    "today tomorrow yesterday week weeks month months year years time times days morning afternoon evening night " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april june july august " +
    "september october november december next last this that these those with from into onto have will shall " +
    "would could should must cannot anything everything something nothing anyone everyone someone nobody " +
    "thanks please hello dear regards best reminder update note heads quick just also only make sure"
  ).split(" "),
);

/** Content words of a text: lower case, four letters or more, not stopwords or plain words. */
export function wordsOf(text: string, max = 40): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[\p{L}][\p{L}'’-]{3,}/gu) ?? []) {
    const v = w.replace(/['’]s$/, "");
    if (v.length < 4 || isStopword(v) || PLAIN.has(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** Whether two words are one word's forms: the same first five letters, or a four-letter word starting the other. */
export function sameWord(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length, 5);
  return n >= 4 && a.slice(0, n) === b.slice(0, n);
}

/** Header lines (a mail's From, To, Date), and where a message's own words end: a signature, a footer, a quote. */
const HEADER = /^(from|to|cc|bcc|date|subject|reply-to|sent):/i;
const ENDS =
  /(?:^|\s)--(?:\s|$)|\bsent from my\b|\bconfidentiality notice\b|\bunsubscribe\b|\bthis (?:e-?mail|message) (?:and any|was sent|is intended)\b|^\s*on .{6,160} wrote:|^\s*>/im;

/**
 * An item's own words: no header lines, nothing after its signature or footer, no quoted thread. A footer's "this
 * email is confidential" is boilerplate, not a rule.
 */
function ownText(text: string): string {
  const end = text.search(ENDS);
  return (end >= 0 ? text.slice(0, end) : text)
    .split("\n")
    .filter((line) => !HEADER.test(line.trim()))
    .join("\n");
}

/** Whether a match at `index` in `text` is negated just before it ("not blocked", "never expired"). */
function negatedAt(text: string, index: number): boolean {
  return NEGATED.test(text.slice(Math.max(0, index - 20), index));
}

/** Whether a sentence says, outside a condition and not negated, that a rule or state no longer holds (`COUNTER`). */
function countered(sentence: string): boolean {
  for (const m of sentence.matchAll(COUNTER)) {
    const before = sentence.slice(Math.max(0, m.index! - 100), m.index!);
    if (CONDITION.test(before) || REQUIRED.test(before) || negatedAt(sentence, m.index!)) continue;
    return true;
  }
  return false;
}

/** The first match of `re` in a sentence that is not negated, or null. */
function said(re: RegExp, sentence: string): RegExpExecArray | null {
  const m = re.exec(sentence);
  return m && !negatedAt(sentence, m.index) ? m : null;
}

/**
 * The standing constraints an item states, or null: its sentences that state a prohibition (`PROHIBIT`), a condition
 * (`CONDITIONAL`), a blocking state (`STATUS`, `LEFT`) or a cap on an amount, not negated. A sentence that says it no
 * longer holds, or is followed by one about the same thing ("expired 30 Sep; the renewed report was accepted"), does
 * not count. A marked sentence with no date takes the previous sentence's ("jury service on Thu 29 Oct. Offline all
 * day."); beside a lasting state, a past date is when it began.
 */
export function constraintOf(item: ContextItem, now: number): Constraint | null {
  // Runs of spaces collapsed first: no pattern below then rescans a long run from each start.
  const sentences = `${item.title}. ${ownText(item.text.slice(0, MAX_CHARS))}`
    .replace(/[ \t\r\f\v]+/g, " ")
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter((x) => x.length >= 4);
  const today = new Date(now).toISOString().slice(0, 10);
  const rules: Rule[] = [];
  const marked: string[] = [];
  let firm = false;
  for (let i = 0; i < sentences.length && rules.length < 8; i++) {
    const sentence = sentences[i]!;
    const prohibits = said(PROHIBIT, sentence) !== null;
    const state = said(STATUS, sentence) !== null || LEFT.test(sentence);
    const limits = limitsOf(sentence);
    if (!prohibits && !state && limits.length === 0 && !said(CONDITIONAL, sentence)) continue;
    if (countered(sentence)) continue;
    const next = sentences[i + 1];
    if (next && countered(next) && wordsOf(next).some((w) => wordsOf(sentence).some((t) => sameWord(w, t)))) continue;
    let dates = datesOf(sentence, now);
    // Undated: the dates of the sentence before ("jury service on Thu 29 Oct. Offline all day."), else of the one
    // after (a title, then its details: "Change freeze. No production changes from 28 Oct to 3 Nov").
    for (const near of [sentences[i - 1], sentences[i + 1]]) {
      if (dates.spans.length > 0 || dates.deadline !== null) break;
      if (near !== undefined) dates = datesOf(near, now);
    }
    const lasting = state && (LASTING.test(sentence) || LEFT.test(sentence));
    // A lasting state's past day is when it began; a prohibition's or a condition's days only bind when it prohibits.
    const spans = dates.spans.map((x) =>
      lasting && x.from === x.to && x.to <= today ? { from: x.from, to: FUTURE } : x,
    );
    rules.push({
      spans: prohibits || state ? spans : [],
      deadline: dates.deadline,
      limits,
      status: state,
      strong: (state && (STRONG.test(sentence) || LEFT.test(sentence))) || said(FORMAL, sentence) !== null,
    });
    marked.push(sentence);
    firm ||= said(FORMAL, sentence) !== null || said(PERSONAL, sentence) !== null || LEFT.test(sentence);
  }
  if (rules.length === 0) return null;
  return { rules, firm, terms: wordsOf(`${item.title} ${marked.join(" ")}`) };
}

/** What a request brings to the check: the days it acts on (today when it names none), its amounts and words. */
export interface Act {
  days: string[];
  amounts: Limit[];
  words: string[];
  /** Whether `words` starts with the request's leading verb ("share", "send"): it says what is done, not to what. */
  lead?: boolean;
}

/**
 * How a record binds a request: an amount over its cap, a day in a span that ends, a day past its deadline, or a
 * standing state (undated, or from a day with no end: "left on 9 Oct", "expired 30 Sep", a pause "from 19 Oct").
 */
export type Conflict = "limit" | "span" | "passed" | "state";

/**
 * The structural conflict between a record and a request, or null. A rule with days binds only on those days; a
 * cap binds an amount of its unit above it; a deadline binds a day after it; a standing state binds always (the
 * caller asks for more of a link before acting on that alone: `judge`).
 */
export function conflictOf(c: Constraint, act: Act): Conflict | null {
  let state = false;
  for (const r of c.rules) {
    const on = r.spans.filter((s) => act.days.some((d) => d >= s.from && d <= s.to));
    const holds = r.spans.length === 0 || on.length > 0;
    if (holds && r.limits.some((l) => act.amounts.some((a) => a.unit === l.unit && a.value > l.value))) return "limit";
    if (r.deadline !== null && act.days.some((d) => d > r.deadline!)) return "passed";
    if (r.limits.length > 0) continue;
    if (on.some((s) => s.to !== FUTURE)) return "span";
    if (on.length > 0 || (r.spans.length === 0 && r.deadline === null && r.strong)) state = true;
  }
  return state ? "state" : null;
}

/** What the register makes of one record for one request (`judge`). */
export interface Verdict {
  conflict: Conflict | null;
  /** Delivered with no model's say: it conflicts with the request, about what the request is about. */
  binds: boolean;
  /** Worth a judge's seat: it binds, conflicts, or shares a subject or a name with the request. */
  touches: boolean;
  /** For ranking seats: binding first, then a dated or capped conflict, then a name and a word shared. */
  rank: number;
}

/**
 * How a request names what a record is about: `subject` when a person or organisation it names is in the item's
 * title or takes part in it (the record is about them), `named` when the item only mentions one.
 */
export type Naming = "subject" | "named" | null;

/**
 * A record against a request: a dated or capped conflict binds when they share a name or a subject word; a standing
 * state binds when it is about someone the request names, or names them and shares a subject word or is a person's
 * own state or a formal prohibition ("severe nut allergy", "do not share"), or shares two subject words besides the
 * request's leading verb ("access to staging … is suspended" for "get … VPN access to staging").
 */
export function judge(c: Constraint, act: Act, naming: Naming): Verdict {
  const conflict = conflictOf(c, act);
  const shared = sharedWords(c, act);
  const own = sharedWords(c, { ...act, words: act.words.slice(act.lead ? 1 : 0) });
  const dated = conflict !== null && conflict !== "state";
  const binds =
    (dated && (naming !== null || shared > 0)) ||
    (conflict === "state" && (naming === "subject" || (naming === "named" && (shared > 0 || c.firm)) || own >= 2));
  return {
    conflict,
    binds,
    touches: binds || dated || naming !== null || shared > 0,
    rank: (binds ? 4 : 0) + (dated ? 2 : 0) + (naming !== null && shared > 0 ? 1 : 0),
  };
}

/** Whether a record and a request share a subject word (`sameWord`). */
export function sharesWord(c: Constraint, act: Act): boolean {
  return sharedWords(c, act) > 0;
}

/** How many of a request's subject words a record holds (`sameWord`). */
export function sharedWords(c: Constraint, act: Act): number {
  let n = 0;
  for (const w of act.words) if (c.terms.some((t) => sameWord(w, t))) n++;
  return n;
}
