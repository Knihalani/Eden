/**
 * `packetWhy` (F3, trial): why an item a packet hands over bears on the request, said in Eden's own fixed words with no
 * model. The request's days (`Cue.time`, D44) and the time it asks to fill (`requestedSpan`) are set against the
 * item's own dates and times: an event's `meta.start`, the dates its text writes ("Thursday 29 Oct", "2 Nov – 6 Nov",
 * "weekly from 20 October until 8 December" on "Tuesdays") and its clock times ("14:00–17:30"). Only a positive
 * finding is said: "Thu 29 Oct 14:00–17:30, overlapping the request's 16:40 on that day". A different day says
 * nothing, so the note never argues an item away.
 *
 * The note is built only from numbers, weekday and month names and fixed words: no source text reaches it, so it
 * cannot carry an instruction (D11, D19), and it stays a line of data inside the envelope. Bounded input: the head of
 * the item's text, at most `MAX_DATES` dates and `MAX_TIMES` times an item.
 */
import type { ContextItem } from "@eden/protocol";
import { startDay, type TimeWindow } from "./grounding";
import { endMinutes, requestedSpan, startMinutes } from "./probes";

const DAY = 86_400_000;
/** The head of an item's text read for dates and times: where an event's or a notice's own when is written. */
const HEAD_CHARS = 1_500;
const MAX_DATES = 8;
const MAX_TIMES = 6;
/** A written range of days longer than this is not read as one (a term, a contract): its days say little. */
const MAX_RANGE_DAYS = 120;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const YEAR = String.raw`(?:,?\s+(\d{4}))?`;
/** "29 Oct", "29th of October 2026", optionally after a weekday. */
const DAY_FIRST = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+${MONTH}\b${YEAR}`, "gi");
/** "Oct 29", "October 29th, 2026". */
const MONTH_FIRST = new RegExp(String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?\b${YEAR}`, "gi");
/** What joins two dates into a range: a dash, "to", "until", "till", "through". */
const JOIN =
  /^\s*(?:\(?all day\)?\s*)?(?:[-–—]|to|until|till|thru|through)\s*(?:(?:mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(?:day)?\.?,?\s*)?$/i;
/** Days written as one range in one month: "21–31 Dec", "2-8 November". */
const DAY_RANGE = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s*[-–—]\s*(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH}\b${YEAR}`,
  "gi",
);
/** A clock range: "14:00–17:30", "9am-5pm", "08:40 to 08:55". */
const CLOCK_RANGE =
  /(?<![\[\d:])\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:[-–—]|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?![\]:])/gi;
/** One clock time with minutes or a meridiem, not a chat line's "[07:00]" stamp. */
const CLOCK = /(?<![\[\d:])\b(?:(\d{1,2}):(\d{2})\s*(am|pm)?|(\d{1,2})\s*(am|pm))\b(?![\]:\d])/gi;
/** A recurring weekday: "Tuesdays", "every Tuesday". */
const RECURRING =
  /\b(?:every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s)\b/gi;
/** A date the item says no longer holds: "moved from 13 Nov", "was 5 Nov", "originally Tuesday 3 Nov". */
const FORMER =
  /\b(?:(?:moved|rescheduled|changed|postponed|brought forward|pushed back)\s+from|was|previously|originally|formerly)\s+(?:on\s+)?(?:[a-z]+day,?\s+)?(?:the\s+)?$/i;
/** An item marked off or put back: its dates are no clash with anything. */
const CALLED_OFF = /\b(?:cancel+ed|called off|postponed|withdrawn|no longer (?:happening|going ahead|on))\b/i;
/** A mail's own header lines: when it was sent is not when anything happens. */
const HEADER_LINE = /^(?:from|to|cc|bcc|date|sent|subject|reply-to):[^\n]*$/gim;

/** A time of day an item takes, in minutes from midnight; `point` when only its start is written. */
interface Span {
  from: number;
  to: number;
  point?: boolean;
}

/** A day span an item names: from and to as UTC day starts (ms), and the weekdays it recurs on, if it says. */
interface Days {
  from: number;
  to: number;
  weekdays?: ReadonlySet<number>;
}

/** What the request names and what the item says of its own when. */
export interface WhyInput {
  /** The request's days (`Cue.time`); without days nothing is said. */
  time: TimeWindow | null;
  /** The request's own text, for the time of day it names. */
  raw: string;
  /** The user's UTC offset (minutes). */
  offset: number;
  /** The request's clock (ms), for the year of a date written without one. */
  now: number;
}

const dayStart = (key: string) => Date.parse(`${key}T00:00:00Z`);
const dayLabel = (ms: number) => {
  const d = new Date(ms);
  return `${WD_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MON_SHORT[d.getUTCMonth()]}`;
};
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** The text an item's when is read from: its title and the head of its text, mail header lines out. */
function whenText(item: ContextItem): string {
  return `${item.title}\n${item.text.slice(0, HEAD_CHARS)}`.replace(HEADER_LINE, " ");
}

/** A date written without a year: the nearest such date to `now` (this year's, else next or last year's). */
function dateOf(day: number, month: number, year: string | undefined, now: number): number | null {
  if (month < 0 || day < 1 || day > 31) return null;
  const y = year ? Number(year) : new Date(now).getUTCFullYear();
  let at = Date.UTC(y, month, day);
  if (!year) {
    if (at < now - 182 * DAY) at = Date.UTC(y + 1, month, day);
    else if (at > now + 182 * DAY) at = Date.UTC(y - 1, month, day);
  }
  return new Date(at).getUTCDate() === day ? at : null;
}

/** Whether the date at `at` in `text` follows words saying it no longer holds ("moved from", "was"). */
function former(text: string, at: number): boolean {
  // A weekday written before the date belongs to it: "was Tuesday 3 Nov".
  return FORMER.test(text.slice(Math.max(0, at - 40), at));
}

/** The dates an item's text writes, in order, with where each ends (to join ranges). */
function writtenDates(text: string, now: number): { at: number; start: number; end: number }[] {
  const out: { at: number; start: number; end: number }[] = [];
  // "21–31 Dec": two dates, the first in the second's month, joined by its dash (a range to `itemDays`).
  for (const m of text.matchAll(DAY_RANGE)) {
    const month = MONTHS.indexOf(m[3]!.slice(0, 3).toLowerCase());
    const a = dateOf(Number(m[1]), month, m[4], now);
    const b = dateOf(Number(m[2]), month, m[4], now);
    if (a === null || b === null || b <= a || former(text, m.index!)) continue;
    const dash = m[0].search(/[-–—]/);
    out.push({ at: a, start: m.index!, end: m.index! + dash });
    out.push({ at: b, start: m.index! + dash + 1, end: m.index! + m[0].length });
  }
  const inRange = (i: number) => out.some((d) => i >= d.start && i < d.end);
  for (const m of text.matchAll(DAY_FIRST)) {
    if (inRange(m.index!) || inRange(m.index! + m[0].length - 1)) continue;
    const at = dateOf(Number(m[1]), MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()), m[3], now);
    // "may" and "march" are verbs too: a bare "2 may" is no date unless an ordinal or "of" makes it one.
    if (former(text, m.index!)) continue;
    if (at !== null && !(/^(may|mar)/i.test(m[2]!) && /^\d+\s+ma/i.test(m[0]))) {
      out.push({ at, start: m.index!, end: m.index! + m[0].length });
    }
  }
  for (const m of text.matchAll(MONTH_FIRST)) {
    if ((/^(may|mar)/i.test(m[1]!) && !/(st|nd|rd|th)\b/i.test(m[0])) || former(text, m.index!)) continue;
    const at = dateOf(Number(m[2]), MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()), m[3], now);
    if (at !== null && !out.some((d) => m.index! < d.end && m.index! + m[0].length > d.start)) {
      out.push({ at, start: m.index!, end: m.index! + m[0].length });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out.slice(0, MAX_DATES);
}

/** The day spans an item names: its start's day, and its text's dates, two joined by a dash or "until" a range. */
export function itemDays(item: ContextItem, offset: number, now: number): Days[] {
  const out: Days[] = [];
  const start = startDay(item, offset);
  const text = whenText(item);
  const dates = writtenDates(text, now);
  const recurring = new Set<number>();
  for (const m of text.matchAll(RECURRING)) recurring.add(WEEKDAYS.indexOf((m[1] ?? m[2])!.toLowerCase()));
  for (let i = 0; i < dates.length; i++) {
    const a = dates[i]!;
    const b = dates[i + 1];
    if (b && b.at > a.at && b.at - a.at <= MAX_RANGE_DAYS * DAY && JOIN.test(text.slice(a.end, b.start))) {
      // "weekly from 20 October until 8 December" on "Tuesdays": the range's Tuesdays only.
      out.push({ from: a.at, to: b.at, ...(recurring.size ? { weekdays: recurring } : {}) });
      i++;
      continue;
    }
    out.push({ from: a.at, to: a.at });
  }
  if (start) {
    // An event's start says when it is: of what its text writes, only a range holding that day counts (its leave
    // "26 Oct to 18 Jan"); other dates there are its history or its notes ("moved from 13 Nov", "deadline 2 Nov").
    const at = dayStart(start);
    const held = out.filter((d) => d.from <= at && at <= d.to && d.from !== d.to);
    return held.length ? held : [{ from: at, to: at }];
  }
  return out;
}

/** The times of day an item says it takes, in minutes from midnight: its start (with its end) and its text's. */
export function itemSpans(item: ContextItem): Span[] {
  const out: Span[] = [];
  const add = (from: number, to: number, point = false) => {
    if (to > from && to - from <= 16 * 60 && !out.some((s) => s.from === from && s.to === to)) {
      out.push(point ? { from, to, point } : { from, to });
    }
  };
  const start = startMinutes(item);
  // An all-day event's midnight start is no time of day. Its end is the first later time its text gives, if any.
  if (start !== null && !(start === 0 && /\ball[- ]day\b/i.test(item.text))) {
    const end = endMinutes(item, start);
    add(start, end, end === start + 60 && !item.text.includes(hhmm(end)));
  }
  const text = whenText(item);
  const clock = (h: string, m: string | undefined, half: string | undefined) => {
    let hour = Number(h);
    if (hour > 23 || Number(m ?? 0) > 59) return null;
    if (half?.toLowerCase() === "pm" && hour < 12) hour += 12;
    if (half?.toLowerCase() === "am" && hour === 12) hour = 0;
    return hour * 60 + Number(m ?? 0);
  };
  const ranged: [number, number][] = [];
  for (const m of text.matchAll(CLOCK_RANGE)) {
    if (out.length >= MAX_TIMES) break;
    // A range needs minutes or a meridiem on one end: "2-8 Nov" and "5-a-side" are no times.
    if (!(m[2] || m[3] || m[5] || m[6])) continue;
    const from = clock(m[1]!, m[2], m[3] ?? m[6]);
    const to = clock(m[4]!, m[5], m[6] ?? m[3]);
    if (from === null || to === null) continue;
    add(from, to);
    ranged.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(CLOCK)) {
    if (out.length >= MAX_TIMES) break;
    if (ranged.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
    const at = m[1] !== undefined ? clock(m[1], m[2], m[3]) : clock(m[4]!, undefined, m[5]);
    if (at !== null) add(at, at + 60, true);
  }
  return out;
}

/** Whether a day span holds the day `at` (a UTC day start), on its recurring weekdays when it names them. */
const holds = (d: Days, at: number) =>
  d.from <= at && at <= d.to && (!d.weekdays || d.weekdays.has(new Date(at).getUTCDay()));

/**
 * Eden's note on why an item bears on the request, or undefined when its dates do not meet the request's days. Fixed
 * words, numbers and day and month names only (never the item's or the request's text).
 */
export function whyNote(item: ContextItem, input: WhyInput): string | undefined {
  const asked = input.time?.days ?? new Set<string>();
  // Called off or put back: its dates clash with nothing (the item still speaks for itself).
  if (CALLED_OFF.test(item.title) || CALLED_OFF.test(item.text.slice(0, 400))) return undefined;
  // The request's own written ranges ("21–31 December", "2 Nov to 8 Nov"), which `timeWindow` reads as their last day.
  const ranges = itemDays({ id: "", sourceId: "", ref: "", title: "", text: input.raw }, 0, input.now).filter(
    (d) => d.from !== d.to,
  );
  const days = [...asked].map(dayStart).filter((x) => Number.isFinite(x));
  for (const r of ranges) for (let at = r.from; at <= r.to && days.length < 64; at += DAY) days.push(at);
  if (days.length === 0) return undefined;
  days.sort((a, b) => a - b);
  const spans = itemDays(item, input.offset, input.now);
  let met: { day: number; span: Days } | undefined;
  for (const span of spans) {
    // A range the item writes exactly as the request does repeats the request (a cover sheet listing it as pending):
    // the request's own words, not something in its way.
    if (span.from !== span.to && ranges.some((r) => r.from === span.from && r.to === span.to)) continue;
    // A request over more than a few days (a stay, "next week") meets every one-day item in it: only an item that
    // itself spans days (leave, a closure, a freeze) says something about the whole of it.
    if (span.from === span.to && days.length > 3) continue;
    const day = days.find((x) => holds(span, x));
    if (day !== undefined) {
      met = { day, span };
      break;
    }
  }
  if (!met) return undefined;
  const ranged = met.span.from !== met.span.to;
  const when = ranged
    ? `runs ${dayLabel(met.span.from)} to ${dayLabel(met.span.to)}${met.span.weekdays ? ", weekly" : ""}, ` +
      `which takes in the request's ${dayLabel(met.day)}`
    : `dated ${dayLabel(met.day)}, a day the request names`;
  const want = requestedSpan(input.raw);
  const times = want && !ranged ? itemSpans(item) : [];
  if (want && times.length > 0) {
    const hit = times.find((t) => t.from < want.to && t.to > want.from);
    // Both say a time of day and they miss each other: the same day is no clash, and a note would invite one.
    if (!hit) return undefined;
    const theirs = hit.point ? hhmm(hit.from) : `${hhmm(hit.from)}-${hhmm(hit.to)}`;
    const ours = want.to - want.from === 90 ? hhmm(want.from) : `${hhmm(want.from)}-${hhmm(want.to)}`;
    return `${when}; its ${theirs} overlaps the request's ${ours}`;
  }
  return when;
}
