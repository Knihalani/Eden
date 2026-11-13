/**
 * Grounding: whether a cached item is about the people and the time a request names, read from the item's structure
 * (who takes part, when it happens) rather than from the words it shares with the request (D44).
 *
 * - People: a connector reports an item's participants in `meta.people` (attendees, sender, recipients), as
 *   "Display Name <email>" entries. A full name in the request matches a participant by identity: every word of it in
 *   the display name, or an address made from the name (dana.lee@, dlee@, danalee@, or dana@ on a domain named for
 *   them). Never a substring of an address: "Mark Hall" is not marketing@townhall.org. An event's title naming the
 *   person as a phrase counts too ("Robin Hale and Dana Lee"): calendar titles name the other party.
 * - Time: relative and explicit dates in the request ("this Sunday", "tomorrow", "next week", "12 November", "last
 *   Friday") resolve against the event's clock, in the user's own UTC offset, to a set of days; an item whose
 *   `meta.start` falls on one of them is in the window. "The next X" asks for the earliest upcoming one. A range
 *   ("12–14 November", "30 November to 4 December", "from 2 Nov until 9 Nov") is every day in it, up to
 *   `RANGE_MAX_DAYS`; a longer one is its two ends (D1773).
 *
 * Dates are compared as calendar days: an item's day is the date in its own start timestamp (its own offset), the
 * request's days are days at the user's offset (`userOffset`: the offset most of their events carry). A start in UTC
 * at a user with another offset is read at the user's offset (`dayOf`: connectors that write instants in UTC); an
 * event stored in another non-zero offset than the user's keeps its own day, so it can be a day off.
 */
import type { ContextItem } from "@eden/protocol";

const DAY = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
/** Month names that are also verbs ("I may 2 …", "march 5 miles"): dates only with an ordinal, "of" or "on". */
const VERB_MONTHS = new Set(["may", "mar", "march"]);
/**
 * "The next X" asks for an event only when X is one: "the next Priya Raman talk", "my upcoming meetings", "what's next
 * on my calendar". "Your next payment", "what's next for our product", "next quarter" name no event.
 */
const NEXT_EVENT =
  /\b(next|upcoming|soonest)\s+(?:[\w'’-]+\s+){0,3}?(meetings?|calls?|lunch(es)?|dinners?|breakfasts?|coffees?|drinks|1:1s?|one-on-ones?|appointments?|catch-?ups?|syncs?|standups?|sessions?|talks?|events?|visits?|flights?|trips?|interviews?|classes|class|demos?|workshops?|webinars?|games?|matches|match|concerts?|shows?|part(y|ies)|on (my |the )?(calendar|schedule|agenda|diary))(?=\W|$)/;
/**
 * A past verb governing a weekday ("we met on Monday", "what happened on Monday", "I met them Friday"): that weekday
 * is the last one. Anywhere else ("Was the meeting moved to Friday?") a weekday is the coming one.
 */
const PAST_BEFORE = /\b(met|happened|had|was|were|went|spoke|called|saw|did)\s+(?:[\w'’-]+\s+)?(on\s+)?$/;

export interface TimeWindow {
  /** Calendar days the request names, as YYYY-MM-DD. Empty when it names none but asks for the next one. */
  days: Set<string>;
  /** "The next X", "upcoming": the earliest one at or after now is meant. */
  next: boolean;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The days a request names, relative to `now` (ms) at the user's UTC offset (`offsetMinutes`); null when it names no
 * time. Spans of at most 14 days.
 */
export function timeWindow(text: string, now: number, offsetMinutes = 0): TimeWindow | null {
  const t = text.toLowerCase();
  const local = now + offsetMinutes * 60_000;
  const today = local - (((local % DAY) + DAY) % DAY);
  const days = new Set<string>();
  const add = (start: number, n = 1) => {
    for (let i = 0; i < Math.min(n, 14); i++) days.add(dayKey(start + i * DAY));
  };
  const weekday = new Date(today).getUTCDay();
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) add(today);
  if (/\btomorrow\b/.test(t)) add(today + DAY);
  if (/\byesterday\b/.test(t)) add(today - DAY);
  const untilSunday = (7 - weekday) % 7;
  if (/\bthis week\b/.test(t)) add(today, untilSunday + 1);
  if (/\bnext week\b/.test(t)) add(today + (untilSunday + 1) * DAY, 7);
  if (/\blast week\b/.test(t)) add(today - (weekday === 0 ? 13 : weekday + 6) * DAY, 7);
  // This weekend's Saturday (today on a Saturday; on a Sunday, today is the weekend's last day).
  const sat = today + ((6 - weekday + 7) % 7) * DAY;
  if (/\bnext weekend\b/.test(t)) add(weekday === 0 ? sat : sat + 7 * DAY, 2);
  else if (/\b(this |the )?weekend\b/.test(t) && !/\blast weekend\b/.test(t)) {
    add(weekday === 0 ? today : sat, weekday === 0 ? 1 : 2);
  }
  for (const m of t.matchAll(
    /\b(this|next|on|coming|last|past|previous)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g,
  )) {
    const target = WEEKDAYS.indexOf(m[2]!);
    // A weekday written with its date ("Wednesday 4 November", "Wednesday, Nov 4") is that date, not the coming one.
    if (
      new RegExp(String.raw`^,?\s+(\d{1,2}(st|nd|rd|th)?(\s+of)?\s+${MONTH}|${MONTH}\s+\d{1,2})\b`).test(
        t.slice(m.index! + m[0].length),
      )
    ) {
      continue;
    }
    const before = t.slice(0, m.index! + m[0].length - m[2]!.length);
    const ago = m[1] === "last" || m[1] === "past" || m[1] === "previous";
    if (ago || (m[1] !== "next" && m[1] !== "coming" && PAST_BEFORE.test(before))) {
      // The last such day before today ("last Friday", "we met on Monday").
      add(today - ((weekday - target + 7) % 7 || 7) * DAY);
      continue;
    }
    // The next such day; today only when the request says "this" or nothing ("on Friday" said on a Friday is today).
    let ahead = (target - weekday + 7) % 7;
    if (ahead === 0 && m[1] === "next") ahead = 7;
    add(today + ahead * DAY);
  }
  // Ranges first (D1773): every day of "12–14 November", not the 14th alone. Their text is blanked for the dates
  // below, so a range's end is not read again on its own with another year ("12 November 2027 to 14 November").
  const { ranges, rest } = dayRanges(t, today);
  for (const r of ranges) {
    if (r.n <= RANGE_MAX_DAYS) add(r.start, r.n);
    else for (const at of [r.start, r.start + (r.n - 1) * DAY]) add(at);
  }
  // Dates in either order, with an optional year: "12 November", "the 3rd of January 2027", "Nov 5th".
  const YEAR = String.raw`(?:,?\s+(\d{4}))?`;
  const explicit = [
    ...[
      ...rest.matchAll(
        new RegExp(String.raw`\b(on |by |from |until )?(\d{1,2})(st|nd|rd|th)?(\s+of)?\s+${MONTH}\b${YEAR}`, "g"),
      ),
    ].map((m) => ({ day: m[2]!, month: m[5]!, year: m[6], firm: !!(m[1] || m[3] || m[4]), dayFirst: true })),
    ...[
      ...rest.matchAll(
        new RegExp(String.raw`\b(on |by |from |until )?${MONTH}\s+(\d{1,2})(st|nd|rd|th)?\b${YEAR}`, "g"),
      ),
    ].map((m) => ({ day: m[3]!, month: m[2]!, year: m[5], firm: !!(m[1] || m[4]), dayFirst: false })),
  ];
  for (const e of explicit) {
    const day = Number(e.day);
    const month = MONTHS.indexOf(e.month.slice(0, 3));
    if (month < 0 || day < 1 || day > 31) continue;
    if (VERB_MONTHS.has(e.month) && !e.firm) continue; // "the 2 may be late" names no date
    // A number before a short month needs a firm cue too: "2 dec ideas" names no date, "on 2 Dec" does.
    if (e.dayFirst && e.month.length <= 4 && !["june", "july"].includes(e.month) && !e.firm) continue;
    // The year said, else the nearest such date: this year's, unless more than half a year gone, then next year's.
    const year = e.year ? Number(e.year) : new Date(today).getUTCFullYear();
    let at = Date.UTC(year, month, day);
    if (!e.year && at < today - 182 * DAY) at = Date.UTC(year + 1, month, day);
    if (new Date(at).getUTCDate() !== day) continue; // "31st of February" is no date
    add(at);
  }
  const asksNext = NEXT_EVENT.test(t);
  if (days.size === 0 && !asksNext) return null;
  return { days, next: asksNext };
}

/**
 * The longest range a request's days take whole (D1773): two weeks, the window's own span cap (`add`). A longer range
 * ("approve leave 1–31 December") is read as its two ends, so a month's leave never puts a month of days into the
 * lookup's timed items, the conflict frame or the day seats (which take at most `DAY_SEAT_DAYS` days, D1402).
 */
export const RANGE_MAX_DAYS = 14;

const ORDINAL = String.raw`(st|nd|rd|th)?`;
/** A weekday written before a range's date ("Monday 30 November to Friday 4 December"), long or short. */
const RANGE_WEEKDAY = String.raw`(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|rsday|urday|sday)?\.?,?\s+)?`;
/** A range's separator: a dash, or a word ("and" only after "between", checked where it matches). */
const RANGE_SEP = String.raw`\s*(–|—|-|to|through|thru|until|till|and)\s*`;
/**
 * Not inside a word, a number, an identifier or an amount ("INV-12-14", "v2-14", "1.12-14", "£12-14", "$10-20"): a
 * range starts on its own.
 */
const RANGE_START = String.raw`(?<![\p{L}\p{N}_.:/£$€¥-])`;
const RANGE_LEAD = String.raw`(from |between |for |on |by )?`;
const RANGE_YEAR = String.raw`(?:,?\s+(\d{4}))?`;
/** A day that is an hour ("Nov 10-11 am", "Nov 3 to 5 pm", "3-4h", "10:00", "3.30"): no range. */
const NOT_TIME = String.raw`(?!\s*(?:[ap]\.?m\b|h\b|hrs?\b|:|\.\d))`;
const DAY_NUM = String.raw`(\d{1,2})(?!\d)${ORDINAL}${NOT_TIME}`;
/** A move governs "from … to": "move my dentist from 10 to 12 November" names two days, not the days between. */
const MOVED =
  /\b(?:move[sd]?|moving|reschedul(?:e[sd]?|ing)|push(?:e[sd]|ing)?|shift(?:s|ed|ing)?|chang(?:e[sd]?|ing)|postpon(?:e[sd]?|ing)|br(?:ing|ought|ings) forward)\b[^.;!?\n]{0,60}$/;
/** Leads that make a lone date firm (the single-date reader's `on`/`by`/`from`/`until`; "for" and "between" do not). */
const FIRM_LEADS = new Set(["from", "on", "by"]);

/** One range as a shape read it: each end's day, month and year (as written), the lead, separator, ordinals. */
interface RangeParts {
  lead: string;
  d1: string;
  o1: boolean;
  m1: string;
  y1?: string | undefined;
  sep: string;
  d2: string;
  o2: boolean;
  m2: string;
  y2?: string | undefined;
  /** "of" between a day and its month ("the 10th to 16th of November"). */
  of: boolean;
  /** The first day stands bare, before a separator (the one-month day-first shape): it could be a count or version. */
  bare: boolean;
  /** Which end is written day first (for the short-month rule): the first, the second, both. */
  dayFirst: [boolean, boolean];
}

/**
 * The four shapes, most specific first: two months day first ("30 November to 4 December"), two months month first
 * ("Nov 30 to Dec 2"), one month day first ("12–14 November", "the 10th to 16th of November"), one month month first
 * ("November 12–14"). The mixed order ("Nov 12 to 14 December") is none of them: its dates are read one by one.
 */
const RANGES: readonly { re: RegExp; read: (m: RegExpMatchArray) => RangeParts }[] = [
  {
    re: new RegExp(
      String.raw`${RANGE_START}${RANGE_LEAD}${RANGE_WEEKDAY}(?:the\s+)?${DAY_NUM}(\s+of)?\s+${MONTH}\b${RANGE_YEAR}` +
        String.raw`${RANGE_SEP}${RANGE_WEEKDAY}(?:the\s+)?${DAY_NUM}(\s+of)?\s+${MONTH}\b${RANGE_YEAR}`,
      "gu",
    ),
    read: (m) => ({
      lead: (m[1] ?? "").trim(),
      d1: m[2]!,
      o1: !!m[3],
      m1: m[5]!,
      y1: m[6],
      sep: m[7]!,
      d2: m[8]!,
      o2: !!m[9],
      m2: m[11]!,
      y2: m[12],
      of: !!(m[4] || m[10]),
      bare: false,
      dayFirst: [true, true],
    }),
  },
  {
    re: new RegExp(
      String.raw`${RANGE_START}${RANGE_LEAD}${RANGE_WEEKDAY}${MONTH}\s+${DAY_NUM}${RANGE_YEAR}${RANGE_SEP}` +
        String.raw`${RANGE_WEEKDAY}${MONTH}\s+${DAY_NUM}${RANGE_YEAR}`,
      "gu",
    ),
    read: (m) => ({
      lead: (m[1] ?? "").trim(),
      m1: m[2]!,
      d1: m[3]!,
      o1: !!m[4],
      y1: m[5],
      sep: m[6]!,
      m2: m[7]!,
      d2: m[8]!,
      o2: !!m[9],
      y2: m[10],
      of: false,
      bare: false,
      dayFirst: [false, false],
    }),
  },
  {
    re: new RegExp(
      String.raw`${RANGE_START}${RANGE_LEAD}${RANGE_WEEKDAY}(?:the\s+)?${DAY_NUM}${RANGE_SEP}${RANGE_WEEKDAY}` +
        String.raw`(?:the\s+)?${DAY_NUM}(\s+of)?\s+${MONTH}\b${RANGE_YEAR}`,
      "gu",
    ),
    read: (m) => ({
      lead: (m[1] ?? "").trim(),
      d1: m[2]!,
      o1: !!m[3],
      sep: m[4]!,
      d2: m[5]!,
      o2: !!m[6],
      m1: m[8]!,
      m2: m[8]!,
      y2: m[9],
      of: !!m[7],
      bare: true,
      dayFirst: [true, true],
    }),
  },
  {
    re: new RegExp(
      String.raw`${RANGE_START}${RANGE_LEAD}${RANGE_WEEKDAY}${MONTH}\s+${DAY_NUM}${RANGE_SEP}(\d{1,2})(?!\d)${ORDINAL}` +
        String.raw`${NOT_TIME}(?!\s*${MONTH}\b)(?![\p{L}\p{N}])${RANGE_YEAR}`,
      "gu",
    ),
    read: (m) => ({
      lead: (m[1] ?? "").trim(),
      m1: m[2]!,
      d1: m[3]!,
      o1: !!m[4],
      sep: m[5]!,
      d2: m[6]!,
      o2: !!m[7],
      m2: m[2]!,
      // m[8] is the month the lookahead refused (a lookahead's group is numbered too).
      y2: m[9],
      of: false,
      bare: true,
      dayFirst: [false, false],
    }),
  },
];

const AFTER_MONTH_DAY = /^,?\s+\d{1,2}(?!\d)/;
const BEFORE_MONTH = new RegExp(String.raw`\b${MONTH}\.?\s*$`);
const short = (month: string) => month.length <= 4 && month !== "june" && month !== "july";

/** Whether a shape's match reads as a range of days (the rules `dayRanges` lists), before its dates are checked. */
function readsAsRange(r: RangeParts, text: string, at: number, end: number): boolean {
  const word = /^[a-z]/.test(r.sep);
  if (r.sep === "and" && r.lead !== "between") return false;
  // A bare first number before a word ("Postgres 12 to 14 November", "node 18 to 20 November") is a version or a
  // count unless a lead or an ordinal says it is a day.
  if (word && r.bare && !r.lead && !r.o1) return false;
  // As a lone date: "May" and "March" need a firm cue anywhere, a short month after its day needs one too ("2-3 dec
  // ideas", "plan for 3-5 may change"): an ordinal, "of", or a firm lead.
  const firm = r.o1 || r.o2 || r.of || FIRM_LEADS.has(r.lead);
  if ((VERB_MONTHS.has(r.m1) || VERB_MONTHS.has(r.m2)) && !firm) return false;
  if (((r.dayFirst[0] && short(r.m1)) || (r.dayFirst[1] && short(r.m2))) && !firm) return false;
  // The one-month day-first shape must not start right after a month ("Nov 12 to 14 December").
  if (r.bare && r.dayFirst[0] && BEFORE_MONTH.test(text.slice(Math.max(0, at - 12), at))) return false;
  // A day-first month followed by a day number is a month-first date ("1-2 Nov 12", "£12-14 November 20").
  if (r.dayFirst[1] && !r.y2 && AFTER_MONTH_DAY.test(text.slice(end, end + 8))) return false;
  // A reschedule names its two days, not the days between.
  if (r.lead === "from" || word) {
    const clause = text.slice(Math.max(0, at - 80), at);
    if (MOVED.test(clause)) return false;
  }
  return true;
}

/**
 * The day ranges a lower-cased request writes, each as its first day (ms, UTC midnight) and its length in days, and
 * the text with every range blanked (`rest`), for the single-date reader. Bounded input (the caller's text); each
 * shape is one linear pass, and the blanked text is built once a shape. Not ranges, read as before: a separator word
 * after a bare number with no lead or ordinal (versions, counts), "and" without "between", "May"/"March" or a short
 * month after its day without a firm cue, a number before or after the range that makes it part of something else
 * (an amount, an identifier, a month-first date, an hour), a mixed order ("Nov 12 to 14 December"), a reschedule
 * ("move it from 10 to 12 November"), and a span whose end is not after its start or whose day does not exist.
 */
function dayRanges(text: string, today: number): { ranges: { start: number; n: number }[]; rest: string } {
  const ranges: { start: number; n: number }[] = [];
  let t = text;
  for (const shape of RANGES) {
    const parts: string[] = [];
    let last = 0;
    for (const m of t.matchAll(shape.re)) {
      const at = m.index!;
      const end = at + m[0].length;
      const r = shape.read(m);
      if (!readsAsRange(r, t, at, end)) continue;
      const span = rangeOf(r, today);
      if (!span) continue;
      ranges.push(span);
      parts.push(t.slice(last, at), " ".repeat(m[0].length));
      last = end;
    }
    if (last > 0) t = parts.join("") + t.slice(last);
  }
  return { ranges, rest: t };
}

/**
 * A range's first day and length, or null when it is no range. The year: as said; with none, the end's nearest year
 * (this year's, unless more than half a year gone, as a lone date reads) and the start's that year or the one before
 * when its month comes later ("28 December to 3 January", said on 2 January, is the days just gone and tomorrow).
 * A range that crosses a year only by that rule and is longer than `RANGE_MAX_DAYS` is no range: its days are read
 * one by one.
 */
function rangeOf(r: RangeParts, today: number): { start: number; n: number } | null {
  const m1 = MONTHS.indexOf(r.m1.slice(0, 3));
  const m2 = MONTHS.indexOf(r.m2.slice(0, 3));
  const d1 = Number(r.d1);
  const d2 = Number(r.d2);
  if (m1 < 0 || m2 < 0) return null;
  const said1 = r.y1 ? Number(r.y1) : undefined;
  const said2 = r.y2 ? Number(r.y2) : undefined;
  let y2: number;
  if (said2 !== undefined) y2 = said2;
  else if (said1 !== undefined) y2 = said1 + (m2 < m1 ? 1 : 0);
  else {
    y2 = new Date(today).getUTCFullYear();
    if (Date.UTC(y2, m2, d2) < today - 182 * DAY) y2 += 1;
  }
  const y1 = said1 ?? (m1 > m2 ? y2 - 1 : y2);
  const valid = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).getUTCDate() === d;
  if (!valid(y1, m1, d1) || !valid(y2, m2, d2)) return null;
  const start = Date.UTC(y1, m1, d1);
  const end = Date.UTC(y2, m2, d2);
  if (end <= start) return null;
  const n = Math.round((end - start) / DAY) + 1;
  if (said1 === undefined && said2 === undefined && y1 !== y2 && n > RANGE_MAX_DAYS) return null;
  return { start, n };
}

/**
 * The day an item starts on, or null when it has no `meta.start`: its own day, or for a start in UTC its day at the
 * user's `offset` (minutes, `ItemCache.offsetOf`), as `dayOf` reads it.
 */
export function startDay(item: ContextItem, offset = 0): string | null {
  const s = item.meta?.start;
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? dayOf(s, offset) : null;
}

/**
 * The YYYY-MM-DD a start is on for a user at `offset` (minutes). A start that carries a non-zero offset is on its own
 * day (the date it was written with): the event's own zone says which day it is. A start in UTC ("Z", "+00:00") at a
 * user whose calendar carries another offset is a connector writing instants, not the user's day: 23:30Z on the 6th
 * is the 7th at +01:00, so its day is read at the user's offset. A zone-less start or a bare date is wall-clock and
 * keeps its date. Otherwise its first ten characters (the caller checks they are a date).
 */
export function dayOf(start: string, offset: number): string {
  if (offset !== 0 && offsetOf(start) === 0) {
    const t = parseWhen(start);
    if (!Number.isNaN(t)) return new Date(t + offset * 60_000).toISOString().slice(0, 10);
  }
  return start.slice(0, 10);
}

/** When an item starts (ms, `parseWhen`), or NaN. */
export function startMs(item: ContextItem): number {
  const s = item.meta?.start;
  return s ? parseWhen(s) : Number.NaN;
}

/**
 * A trailing zone: "Z" (any case, RFC 3339), "+01:00" or "-0700" right after a time (so the year in "14-Oct-2026" is
 * no offset), or a name ("UTC", "GMT+1", "GMT+0100", an RFC 2822 zone); an optional "(comment)" after it.
 */
const HAS_ZONE =
  /(?:\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)|\b(?:UTC?|GMT|[ECMP][SD]T)(?:\s*[+-]\d{1,2}(?::?\d{2})?)?)(?:\s*\([^)]*\))?\s*$/i;
/** Any zone token anywhere (looser than HAS_ZONE): a string with one is never re-read as UTC wall-clock. */
const ANY_ZONE = /\d[zZ]\b|\b(?:UTC?|GMT|[ECMP][SD]T)\b|\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*[+-]\d{1,2}(?::?\d{2})?/i;
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * A date or date-time string as ms, read the same on every host: a string with no zone is UTC (the sim writes its
 * headers so, and `startDay` reads a start's own day), not the server process's local zone, which `Date.parse` uses
 * for zone-less date-times and for "14 Oct 2026". A string with a zone, and an ISO bare date (UTC by spec), are left
 * to `Date.parse`. NaN when it does not parse. Off the fast path: per item, where a date is read.
 */
export function parseWhen(s: string): number {
  const t = s.trim();
  if (t === "" || HAS_ZONE.test(t)) return Date.parse(t);
  if (ISO_LOCAL.test(t)) return Date.parse(`${t.replace(" ", "T")}Z`);
  if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(t)) return Date.parse(t);
  const utc = Date.parse(`${t} GMT`);
  if (Number.isFinite(utc)) return utc;
  // A form the suffix breaks. A zone token the patterns above missed: the instant is already fixed, keep it.
  if (ANY_ZONE.test(t)) return Date.parse(t);
  // No zone at all: read it locally, then take its wall-clock fields as UTC.
  const local = new Date(Date.parse(t));
  if (Number.isNaN(local.getTime())) return Number.NaN;
  return Date.UTC(
    local.getFullYear(),
    local.getMonth(),
    local.getDate(),
    local.getHours(),
    local.getMinutes(),
    local.getSeconds(),
    local.getMilliseconds(),
  );
}

/** The UTC offset (minutes) a start timestamp carries: "Z" is 0, "+01:00" is 60; null for none or a bare date. */
export function offsetOf(start: string): number | null {
  if (/Z$/i.test(start)) return 0;
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(start);
  if (!m || !/T/.test(start)) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** The offset most of a user's timestamps carry (their calendar's zone), or 0 when none does. */
export function userOffset(starts: Iterable<string>): number {
  const count = new Map<number, number>();
  for (const s of starts) {
    const o = offsetOf(s);
    if (o !== null) count.set(o, (count.get(o) ?? 0) + 1);
  }
  let best = 0;
  let n = 0;
  for (const [o, c] of count) if (c > n || (c === n && o !== 0 && best === 0)) [best, n] = [o, c];
  return best;
}

const words = (s: string): string[] => s.toLowerCase().match(/\p{L}+/gu) ?? [];

/** Whether an email address is one made from this name: dana.lee@, dlee@, danalee@, or dana@danalee.example. */
function addressOf(name: string[], address: string): boolean {
  const [local = "", domain = ""] = address.split("@");
  const parts = local.split(/[^a-z]+/).filter(Boolean);
  const first = name[0]!;
  const last = name.at(-1)!;
  if (name.every((w) => parts.includes(w))) return true;
  const flat = parts.join("");
  if (flat === first + last || flat === first[0]! + last || flat === last + first) return true;
  // A personal domain: the first name at a domain named for the whole name or the surname.
  const label = domain.split(".")[0]!.replace(/[^a-z]/g, "");
  return flat === first && (label === first + last || label === last);
}

/** Whether a person the request names (a full name of two or more words, or an email address) takes part in `item`. */
export function namesParticipant(entity: string, item: ContextItem): boolean {
  const email = /^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(entity) ? entity.toLowerCase() : null;
  const name = words(entity);
  if (!email && name.length < 2) return false; // One name ("Sam") is too common to stand for a person.
  for (const entry of (item.meta?.people ?? "").split(/[;\n]/)) {
    const at = entry.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0]?.toLowerCase() ?? "";
    if (email) {
      if (at === email) return true;
      continue;
    }
    const display = words(entry.replace(at, ""));
    if (name.every((w) => display.includes(w))) return true;
    if (at && addressOf(name, at)) return true;
  }
  // A calendar title names the other party: "Robin Hale and Dana Lee".
  if (!email && startDay(item) !== null) {
    const title = words(item.title).join(" ");
    if (` ${title} `.includes(` ${name.join(" ")} `)) return true;
  }
  return false;
}

/**
 * The words of the names of `item`'s participants (`meta.people`, addresses left out): "Elena Ivanova <elena@…>"
 * gives "elena" and "ivanova". A request's word that is one of them names a person, not an occasion, even when no
 * capital marked it as a name ("the agenda with elena").
 */
export function participantWords(item: ContextItem): Set<string> {
  const out = new Set<string>();
  for (const entry of (item.meta?.people ?? "").split(/[;\n]/)) {
    for (const w of words(entry.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ""))) out.add(w);
  }
  return out;
}

/** Title words too common to say which event is meant ("Weekly mentoring", "Team all hands"). */
const COMMON_TITLE = new Set(
  "weekly daily monthly team sync meeting meetings call calls chat update updates report review standup stand steps next all hands session sessions catch check office hours lunch dinner coffee drinks plan plans project projects notes intro talk".split(
    " ",
  ),
);

/**
 * How an event's title names what the request names: "whole" when it holds an entity's every word in order
 * ("Priya Raman talk" for "Priya Raman"), "word" when it only shares one uncommon word of three or more letters
 * ("Globex" in "Globex Ventures" and "Globex <> Robin"), else null.
 */
export function titleNames(entities: string[], item: ContextItem): "whole" | "word" | null {
  const title = words(item.title);
  const joined = ` ${title.join(" ")} `;
  if (entities.some((e) => words(e).length > 0 && joined.includes(` ${words(e).join(" ")} `))) return "whole";
  const set = new Set(title.filter((w) => w.length >= 3 && !COMMON_TITLE.has(w)));
  return entities.some((e) => words(e).some((w) => set.has(w))) ? "word" : null;
}
