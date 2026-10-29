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
 *   `meta.start` falls on one of them is in the window. "The next X" asks for the earliest upcoming one.
 *
 * Dates are compared as calendar days: an item's day is the date in its own start timestamp (its own offset), the
 * request's days are days at the user's offset (`userOffset`: the offset most of their events carry). An event stored
 * in another offset than the user's can be a day off.
 */
import type { ContextItem } from "@eden/protocol";

const DAY = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
/** Month names that are also verbs ("I may 2 …", "march 5 miles"): dates only with an ordinal, "of" or "on". */
const VERB_MONTHS = new Set(["may", "mar", "march"]);
/** "next" that names no event: "next steps", "next time", "next to the station". */
const NEXT_NOT_TIME =
  /\bnext\s+(steps?|time|times|to|up|door|one|ones|thing|things|level|gen\w*|best|week|month|year|(sun|mon|tues|wednes|thurs|fri|satur)day)\b/;
/** A request about the past: a bare weekday in it is the last one, not the coming one ("what happened on Monday"). */
const PAST = /\b(met|happened|had|was|were|did|went|sent|said|told|wrote|called|spoke|ago)\b/;

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
  if (/\b(this |the )?weekend\b/.test(t) && !/\blast weekend\b/.test(t)) {
    const sat = (6 - weekday + 7) % 7;
    add(today + (weekday === 0 ? 0 : sat) * DAY, weekday === 0 ? 1 : 2);
  }
  const past = PAST.test(t);
  for (const m of t.matchAll(
    /\b(this|next|on|coming|last|past|previous)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g,
  )) {
    const target = WEEKDAYS.indexOf(m[2]!);
    if (m[1] === "last" || m[1] === "past" || m[1] === "previous" || (past && m[1] !== "next" && m[1] !== "coming")) {
      // The last such day before today ("last Friday", "we met on Monday").
      add(today - ((weekday - target + 7) % 7 || 7) * DAY);
      continue;
    }
    // The next such day; today only when the request says "this" or nothing ("on Friday" said on a Friday is today).
    let ahead = (target - weekday + 7) % 7;
    if (ahead === 0 && m[1] === "next") ahead = 7;
    add(today + ahead * DAY);
  }
  const explicit = [
    ...[
      ...t.matchAll(new RegExp(String.raw`\b(on |by |from |until )?(\d{1,2})(st|nd|rd|th)?(\s+of)?\s+${MONTH}\b`, "g")),
    ].map((m) => ({ day: m[2]!, month: m[5]!, firm: !!(m[1] || m[3] || m[4]) })),
    ...[...t.matchAll(new RegExp(String.raw`\b(on |by |from |until )?${MONTH}\s+(\d{1,2})(st|nd|rd|th)?\b`, "g"))].map(
      (m) => ({ day: m[3]!, month: m[2]!, firm: !!(m[1] || m[4]) }),
    ),
  ];
  for (const e of explicit) {
    const day = Number(e.day);
    const month = MONTHS.indexOf(e.month.slice(0, 3));
    if (month < 0 || day < 1 || day > 31) continue;
    if (VERB_MONTHS.has(e.month) && !e.firm) continue; // "the 2 may be late" names no date
    // The nearest such date: this year's, unless it is more than half a year gone, then next year's.
    const year = new Date(today).getUTCFullYear();
    let at = Date.UTC(year, month, day);
    if (at < today - 182 * DAY) at = Date.UTC(year + 1, month, day);
    add(at);
  }
  const next = /\b(next|upcoming|soonest)\b/.test(t) && !NEXT_NOT_TIME.test(t.replace(/\b(upcoming|soonest)\b/g, ""));
  const asksNext = next || /\b(upcoming|soonest)\b/.test(t);
  if (days.size === 0 && !asksNext) return null;
  return { days, next: asksNext };
}

/** The day an item starts on (its own offset), or null when it has no `meta.start`. */
export function startDay(item: ContextItem): string | null {
  const s = item.meta?.start;
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** When an item starts (ms), or NaN. */
export function startMs(item: ContextItem): number {
  const s = item.meta?.start;
  return s ? Date.parse(s) : Number.NaN;
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
