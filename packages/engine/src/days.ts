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

/** An ordinal that counts something other than a day of the month: "5th floor", "20th anniversary", "3rd time". */
const NOT_A_DAY =
  /^\s*(?:floor|anniversary|birthday|time|century|edition|place|grade|year|week|month|day|street|avenue|ave|st|quarter|person|attempt|round|draft|version|of\s+(?:the\s+)?(?:year|month))\b/;

/**
 * `text` with each bare day of the month given its month: "the 20th" becomes "20 November" (the next 20th on or after
 * today), "Monday the 9th" becomes "Monday 9 November" (the next 9th that is a Monday, within four months). An
 * ordinal that already has its month, or counts something else, is left as written. Bounded: the first 8 ordinals.
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
  // English ordinals ("20th"), Swedish ("12:e", "1:a"), and a German or Scandinavian day after its article ("am 12.").
  const re = /\b(\d{1,2})(?:(st|nd|rd|th)\b|:[ea]\b)|\b(?:am|den|dem)\s+(\d{1,2})\.(?=\s|$)/g;
  for (const m of lower.matchAll(re)) {
    if (++n > 8) break;
    const day = Number(m[1] ?? m[3]);
    if (day < 1 || day > 31) continue;
    const at = m.index!;
    const end = at + m[0].length;
    const after = lower.slice(end, end + 24);
    const before = lower.slice(Math.max(0, at - 24), at);
    // Already a date: "20th of November", "November 20th".
    if (new RegExp(String.raw`^(?:\s+of)?\s+${MONTH}\b`).test(after)) continue;
    if (new RegExp(String.raw`\b${MONTH}\s+(?:the\s+)?$`).test(before)) continue;
    if (NOT_A_DAY.test(after)) continue;
    const wd = new RegExp(String.raw`\b(${WEEKDAY}),?\s+(?:the\s+)?$`).exec(before);
    const want = wd ? WEEKDAYS.findIndex((w) => w.startsWith(wd[1]!.slice(0, 3))) : -1;
    let found = -1;
    for (let k = 0; k < 4 && found < 0; k++) {
      const d = Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() + k, day);
      if (new Date(d).getUTCDate() !== day || d < today) continue;
      if (want >= 0 && new Date(d).getUTCDay() !== want) continue;
      found = d;
    }
    // A weekday that no coming such date falls on: the ordinal stands, the weekday is the request's slip.
    if (found < 0 && want >= 0) {
      for (let k = 0; k < 2 && found < 0; k++) {
        const d = Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() + k, day);
        if (new Date(d).getUTCDate() === day && d >= today) found = d;
      }
    }
    if (found < 0) continue;
    const digits = m[3] !== undefined ? at + m[0].indexOf(m[3]) : at;
    // "Monday the 9th" is written "Monday 9 November": `timeWindow` then reads the date, not the coming Monday.
    const lead = text.slice(last, digits);
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
/** What every span `coversDay` reads holds: a dash or arrow, or a word that opens or joins a range. */
const SPAN_HINT = /[–—→-]|\b(?:to|until|till|through|thru)\b/;
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

/**
 * Whether `text` spans one of `days` ("YYYY-MM-DD") without writing it: between the two dates of a range, or between
 * the item's own day (`updatedAt`, ms; none: no open range) and the date an "until" names. Spans of at most
 * `MAX_SPAN_DAYS`; a day the text writes itself is `namesDay`'s to find, not this.
 */
export function coversDay(text: string, days: ReadonlySet<string>, updatedAt?: number): boolean {
  if (days.size === 0 || !/\d/.test(text)) return false;
  const lower = text.slice(0, 4000).toLowerCase();
  // A range needs a connector or an "until": most dated texts end here, before any date is parsed.
  if (!SPAN_HINT.test(lower)) return false;
  const dates = datesOf(lower);
  if (dates.length === 0) return false;
  const want: number[] = [];
  for (const d of days) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d);
    if (m) want.push((Number(m[1]) - 1) * 32 + Number(m[2]));
  }
  const inside = (from: number, to: number) => {
    const len = ahead(from, to);
    if (len < 1 || len > MAX_SPAN_DAYS) return false;
    return want.some((w) => {
      const off = ahead(from, w);
      return off > 0 && off < len;
    });
  };
  for (let i = 0; i + 1 < dates.length; i++) {
    const a = dates[i]!;
    const b = dates[i + 1]!;
    if (b.at - a.end <= 24 && BETWEEN.test(lower.slice(a.end, b.at)) && inside(a.key, b.key)) return true;
  }
  if (updatedAt !== undefined && Number.isFinite(updatedAt)) {
    const u = new Date(updatedAt);
    const from = u.getUTCMonth() * 32 + u.getUTCDate();
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i]!;
      // An open range, not the second date of a closed one (read above).
      if (i > 0 && d.at - dates[i - 1]!.end <= 24 && BETWEEN.test(lower.slice(dates[i - 1]!.end, d.at))) continue;
      if (UNTIL.test(lower.slice(Math.max(0, d.at - 40), d.at)) && inside(from, d.key)) return true;
    }
  }
  return false;
}
