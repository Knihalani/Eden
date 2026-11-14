/**
 * `pushDaySeats` (G1, D1400, trial): reading days with no model, past what `timeWindow` and `namesDay` read.
 *
 * - `datedText`: a request's bare day of the month ("on the 20th", "Monday the 9th", "den 12:e") written out with its
 *   month, so `timeWindow` reads a date where it read none, or the wrong weekday.
 * - `coversDay`: whether an item's text spans a day it never writes: a range across months ("Mon 26 Oct – Fri 6 Nov")
 *   or an open one ("suspended until Monday 2 November"), from the item's own date.
 *
 * Dates, not words: nothing here matches the request's vocabulary against the item's.
 */

const DAY = 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY = String.raw`(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?`;

/**
 * What may follow a day of the month: the end of the clause, or one of these words. Any other word after an ordinal
 * makes it a count ("the 3rd party vendor", "the 2nd invoice", "a 1st class ticket", "the 5th floor").
 */
const AFTER_DAY =
  /^\s*(?:$|[,.;:!?)\]–—-]|(?:at|in|on|by|for|to|from|and|or|but|so|then|if|when|is|was|works|would|will|please|morning|afternoon|evening|night|after|before|until|till|instead|rather|around|about|next|this|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b)/;
/** What follows a range's first day: a separator and a dated day ("–14th November", "to 16th of November"). */
const RANGE_ON = new RegExp(
  String.raw`^\s*(?:–|—|-|to|through|thru|until|till|and)\s*(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+${MONTH}\b`,
);
/** What must stand before a bare day of the month: a date's preposition or "the", a weekday, or both. */
const BEFORE_DAY = new RegExp(
  String.raw`(?:\b(?:on|by|for|until|till|before|after|from|of|to)\s+(?:the\s+)?|\bthe\s+|\b${WEEKDAY},?\s+(?:the\s+)?)$`,
);
/** A past tense before the ordinal ("what happened on the 9th", "we agreed on the 5th"): not a coming day. */
const PAST =
  /\b(?:met|happened|had|was|were|went|spoke|called|saw|did|agreed|said|sent|paid|got|came|left|told|decided|arrived)\b[^.!?\n]{0,40}$/;

/**
 * `text` with each bare day of the month given its month: "the 20th" becomes "20 November" (the next 20th on or after
 * today), "Monday the 9th" becomes "Monday 9 November" (the next 9th that is a Monday, within four months). Only an
 * ordinal that reads as a date is rewritten: a date's preposition, "the" or a weekday before it, the end of the
 * clause or a time word after it, and no past tense before it (a past day is `timeWindow`'s to read, as written).
 * One that already has its month is left as written. Bounded: the first 8 ordinals.
 */
export function datedText(text: string, now: number, offsetMinutes = 0): string {
  if (!/\d/.test(text)) return text;
  const local = now + offsetMinutes * 60_000;
  const today = local - (((local % DAY) + DAY) % DAY);
  const t0 = new Date(today);
  const lower = text.toLowerCase();
  let out = "";
  let last = 0;
  let n = 0;
  // English ordinals ("20th"); Swedish after its article ("den 12:e"); a German day after its article ("am 12."),
  // never after "I" ("I am 30.").
  const re =
    /\b(\d{1,2})(st|nd|rd|th)\b|\b(?:den|på|till)\s+(\d{1,2}):[ea]\b|(?<!\bi\s)\b(?:am|dem)\s+(\d{1,2})\.(?=\s|$)/g;
  for (const m of lower.matchAll(re)) {
    if (++n > 8) break;
    const english = m[1] !== undefined;
    const digits = english ? m[1]! : (m[3] ?? m[4])!;
    const day = Number(digits);
    if (day < 1 || day > 31) continue;
    const at = m.index! + m[0].indexOf(digits);
    const end = m.index! + m[0].length;
    const after = lower.slice(end, end + 24);
    const before = lower.slice(Math.max(0, at - 24), at);
    // Already a date: "20th of November", "November 20th".
    if (new RegExp(String.raw`^(?:\s+of)?\s+${MONTH}\b`).test(after)) continue;
    if (new RegExp(String.raw`\b${MONTH}\s+(?:the\s+)?$`).test(before)) continue;
    // A range's first day ("the 12th–14th November", "the 10th to 16th of November"): `timeWindow` reads the range
    // with its month (D1773); given the next 12th's month here, its end would fall in another year.
    if (RANGE_ON.test(lower.slice(end, end + 48))) continue;
    if (english && (!BEFORE_DAY.test(before) || !AFTER_DAY.test(after))) continue;
    if (PAST.test(lower.slice(Math.max(0, at - 80), at))) continue;
    const wd = new RegExp(String.raw`\b(${WEEKDAY}),?\s+(?:the\s+)?$`).exec(before);
    const want = wd ? WEEKDAYS.findIndex((w) => w.startsWith(wd[1]!.slice(0, 3))) : -1;
    let found = -1;
    for (let k = 0; k < 4 && found < 0; k++) {
      const d = Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() + k, day);
      if (new Date(d).getUTCDate() !== day || d < today) continue;
      if (want >= 0 && new Date(d).getUTCDay() !== want) continue;
      found = d;
    }
    // A weekday that no coming such date falls on: the text stands as written (`timeWindow` reads the weekday).
    if (found < 0) continue;
    // "Monday the 9th" is written "Monday 9 November": `timeWindow` then reads the date, not the coming Monday.
    const lead = text.slice(last, at);
    out += `${wd ? lead.replace(/\bthe\s+$/i, "") : lead}${day} ${MONTH_NAMES[new Date(found).getUTCMonth()]!}`;
    last = end;
  }
  return last === 0 ? text : out + text.slice(last);
}

interface Dated {
  /** Day of the year's key: month * 32 + day. */
  key: number;
  at: number;
  end: number;
}

const DATE = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(${MONTH})\b|\b(${MONTH})\s+(\d{1,2})(?:st|nd|rd|th)?\b`,
  "g",
);
/** What stands between a range's two dates: "–", "to", "until", an optional year before and weekday after. */
const BETWEEN = new RegExp(
  String.raw`^,?(?:\s+\d{4})?\s*(?:[–—→-]|to|until|till|through|thru)\s*(?:${WEEKDAY}\.?,?\s+)?$`,
);
/** An open range's lead: "until", "till", "through", "up to", with "at least" and a weekday allowed after it. */
const UNTIL = new RegExp(
  String.raw`\b(?:until|till|through|thru|up to|to)\s+(?:at least\s+)?(?:and including\s+)?(?:${WEEKDAY}\.?,?\s+)?(?:the\s+)?$`,
);
/**
 * What every span `coversDay` reads holds: a month followed by a range's connector ("26 Oct – 6 Nov", "30 Oct to
 * Fri 6 Nov"), or an open range's lead followed by a day ("until Monday 2 November"). Most dated texts (a mail's
 * `Date:` line, an event's start) hold neither and end here, before any date is parsed.
 */
const SPAN_BY_MONTH = String.raw`${MONTH}(?:,?\s+\d{4})?\s*(?:[–—→-]|(?:to|until|till|through|thru)\b)`;
const SPAN_BY_LEAD = String.raw`\b(?:until|till|through|thru|up to|to)\s+(?:at least\s+)?(?:and including\s+)?(?:${WEEKDAY}\.?,?\s+)?(?:the\s+)?\d{1,2}\b`;
const SPAN_HINT = new RegExp(`${SPAN_BY_MONTH}|${SPAN_BY_LEAD}`);
/**
 * `SPAN_HINT`'s two alternatives apart (D1916). The first, a month and a range's connector, is sticky and tried only
 * where one of the months' first three letters stands (`spanHinted`): every one of `MONTH`'s alternatives begins with
 * them, so a match can start nowhere else, and tried at every position it was three quarters of the hint's cost (12
 * alternatives a position). `SPAN_HINT` stays as their union, the reference of `day-facts.test.ts`.
 */
const SPAN_MONTH = new RegExp(SPAN_BY_MONTH, "y");
const SPAN_LEAD = new RegExp(SPAN_BY_LEAD);

/** Whether `SPAN_HINT` matches `lower` (D1916): its month alternative at the months' starts, its lead anywhere. */
export function spanHinted(lower: string): boolean {
  for (const m of MONTHS) {
    for (let i = lower.indexOf(m); i >= 0; i = lower.indexOf(m, i + 1)) {
      SPAN_MONTH.lastIndex = i;
      if (SPAN_MONTH.test(lower)) return true;
    }
  }
  return SPAN_LEAD.test(lower);
}

/** `SPAN_HINT` read as one pattern, as before D1916 (for its differential test). */
export function spanHintedByPattern(lower: string): boolean {
  return SPAN_HINT.test(lower);
}

/** The longest span read as one: a term, a course of medicine, a closure. Longer ones name two separate dates. */
const MAX_SPAN_DAYS = 62;

/** The dates `text` writes with a month, in order, at most 24. */
function datesOf(lower: string): Dated[] {
  const out: Dated[] = [];
  for (const m of lower.matchAll(DATE)) {
    const day = Number(m[1] ?? m[4]);
    const month = MONTHS.indexOf((m[2] ?? m[3])!.slice(0, 3));
    if (month < 0 || day < 1 || day > 31) continue;
    out.push({ key: month * 32 + day, at: m.index!, end: m.index! + m[0].length });
    if (out.length >= 24) break;
  }
  return out;
}

/** Days from `a` to `b` (keys), going forward through a year's end: 20 Dec to 5 Jan is 16. */
function ahead(a: number, b: number): number {
  const at = (k: number) => Date.UTC(2027, k >> 5, k & 31);
  const d = Math.round((at(b) - at(a)) / DAY);
  return d < 0 ? d + 365 : d;
}

/** The spans a text writes, as `coversDay` reads them: closed ranges (pairs of keys) and open "until" ends (keys). */
export interface SpanFacts {
  /** Each range's two dates in turn: from, to, from, to, ... */
  closed: ArrayLike<number>;
  open: ArrayLike<number>;
}

/**
 * The spans `text` writes, whatever day is asked (`coversDay`'s reading of the text, kept per item by `day-facts.ts`,
 * D1721): null when it writes none. Reads the first 4,000 characters, lower-cased.
 */
export function spanFactsOf(text: string): SpanFacts | null {
  if (!/\d/.test(text)) return null;
  const lower = text.slice(0, 4000).toLowerCase();
  if (!spanHinted(lower)) return null;
  const dates = datesOf(lower);
  if (dates.length === 0) return null;
  const closed: number[] = [];
  const open: number[] = [];
  // Whether dates i - 1 and i are a closed range's two ends, by what stands between them.
  const joined = (i: number) =>
    i > 0 && dates[i]!.at - dates[i - 1]!.end <= 24 && BETWEEN.test(lower.slice(dates[i - 1]!.end, dates[i]!.at));
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i]!;
    if (joined(i)) closed.push(dates[i - 1]!.key, d.key);
    // An open range, not the second date of a closed one (read above).
    else if (UNTIL.test(lower.slice(Math.max(0, d.at - 40), d.at))) open.push(d.key);
  }
  return closed.length === 0 && open.length === 0 ? null : { closed, open };
}

/** `days` ("YYYY-MM-DD") as keys, `month * 32 + day`. */
export function dayKeys(days: ReadonlySet<string>): number[] {
  const out: number[] = [];
  for (const d of days) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d);
    if (m) out.push((Number(m[1]) - 1) * 32 + Number(m[2]));
  }
  return out;
}

/** Whether a wanted day (`want`, keys) lies strictly inside the span from `from` to `to`, of 1-`MAX_SPAN_DAYS` days. */
function inside(from: number, to: number, want: readonly number[]): boolean {
  const len = ahead(from, to);
  if (len < 1 || len > MAX_SPAN_DAYS) return false;
  return want.some((w) => {
    const off = ahead(from, w);
    return off > 0 && off < len;
  });
}

/**
 * `coversDay` over a text's spans (`spanFactsOf`): `want` is `dayKeys(days)`, `updatedAt` the item's own day (ms).
 */
export function coversSpans(
  spans: SpanFacts | null,
  days: ReadonlySet<string>,
  want: readonly number[],
  updatedAt?: number,
): boolean {
  if (spans === null || days.size === 0) return false;
  const { closed, open } = spans;
  for (let i = 0; i + 1 < closed.length; i += 2) if (inside(closed[i]!, closed[i + 1]!, want)) return true;
  if (open.length === 0) return false;
  // An open range runs from the item's own day, so only an item written within the span's reach of a wanted day
  // (last year's "closed until 2 November" covers nothing now).
  const near =
    updatedAt !== undefined &&
    Number.isFinite(updatedAt) &&
    [...days].some((d) => {
      const gap = Date.parse(d) - updatedAt;
      return gap > -DAY && gap <= (MAX_SPAN_DAYS + 1) * DAY;
    });
  if (!near) return false;
  const u = new Date(updatedAt!);
  const from = u.getUTCMonth() * 32 + u.getUTCDate();
  for (let i = 0; i < open.length; i++) if (inside(from, open[i]!, want)) return true;
  return false;
}

/**
 * Whether `text` spans one of `days` ("YYYY-MM-DD") without writing it: between the two dates of a range, or between
 * the item's own day (`updatedAt`, ms; none: no open range) and the date an "until" names. Spans of at most
 * `MAX_SPAN_DAYS`; a day the text writes itself is `namesDay`'s to find, not this.
 */
export function coversDay(text: string, days: ReadonlySet<string>, updatedAt?: number): boolean {
  if (days.size === 0) return false;
  return coversSpans(spanFactsOf(text), days, dayKeys(days), updatedAt);
}
