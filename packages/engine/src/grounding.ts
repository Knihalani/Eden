/**
 * Grounding: whether a cached item is about the people and the time a request names, read from the item's structure
 * (who takes part, when it happens) rather than from the words it shares with the request (D44).
 *
 * - People: a connector reports an item's participants in `meta.people` (attendees, sender, recipients), as
 *   "Display Name <email>" entries. A full name in the request matches a participant by identity: every word of it in
 *   the display name, or in the email address (dana lee, dana@danalee.io). An event's title naming the person as a
 *   phrase counts too ("Robin Hale and Dana Lee"): calendar titles name the other party.
 * - Time: relative and explicit dates in the request ("this Sunday", "tomorrow", "next week", "12 November") resolve
 *   against the event's own clock to a set of days; an item whose `meta.start` falls on one of them is in the window.
 *   "The next X" asks for the earliest upcoming one.
 *
 * Dates are compared as calendar days: an item's day is the date in its own start timestamp (its own offset), the
 * request's days are UTC days of the event's clock. Near midnight in a far timezone this can be a day off.
 */
import type { ContextItem } from "@eden/protocol";

const DAY = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;

export interface TimeWindow {
  /** Calendar days the request names, as YYYY-MM-DD. Empty when it names none but asks for the next one. */
  days: Set<string>;
  /** "The next X", "upcoming": the earliest one at or after now is meant. */
  next: boolean;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The days a request names, relative to `now` (ms); null when it names no time. Spans of at most 14 days. */
export function timeWindow(text: string, now: number): TimeWindow | null {
  const t = text.toLowerCase();
  const today = now - (now % DAY);
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
  if (/\b(this |the )?weekend\b/.test(t)) {
    const sat = (6 - weekday + 7) % 7;
    add(today + (weekday === 0 ? 0 : sat) * DAY, weekday === 0 ? 1 : 2);
  }
  for (const m of t.matchAll(
    /\b(this|next|on|coming)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g,
  )) {
    // The next such day; today only when the request says "this" or nothing ("on Friday" said on a Friday is today).
    let ahead = (WEEKDAYS.indexOf(m[2]!) - weekday + 7) % 7;
    if (ahead === 0 && m[1] === "next") ahead = 7;
    add(today + ahead * DAY);
  }
  const explicit = [
    ...t.matchAll(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+${MONTH}\b`, "g")),
    ...[...t.matchAll(new RegExp(String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "g"))].map((m) => [
      m[0],
      m[2],
      m[1],
    ]),
  ];
  for (const m of explicit) {
    const day = Number(m[1]);
    const month = MONTHS.indexOf(String(m[2]).slice(0, 3));
    if (month < 0 || day < 1 || day > 31) continue;
    // The nearest such date: this year's, unless it is more than half a year gone, then next year's.
    const year = new Date(today).getUTCFullYear();
    let at = Date.UTC(year, month, day);
    if (at < today - 182 * DAY) at = Date.UTC(year + 1, month, day);
    add(at);
  }
  const next =
    /\b(next|upcoming|soonest)\b(?!\s+(week|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b)/.test(
      t,
    );
  if (days.size === 0 && !next) return null;
  return { days, next };
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

const words = (s: string): string[] => s.toLowerCase().match(/\p{L}+/gu) ?? [];

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
    const letters = at.replace(/[^a-z]/g, "");
    if (letters && name.every((w) => w.length >= 3 && letters.includes(w))) return true;
  }
  // A calendar title names the other party: "Robin Hale and Dana Lee", "Globex <> Robin".
  if (!email && startDay(item) !== null) {
    const title = words(item.title).join(" ");
    if (` ${title} `.includes(` ${name.join(" ")} `)) return true;
  }
  return false;
}

/**
 * Whether the request's entities share a word of three or more letters with an event's title ("Globex" in "Globex
 * Ventures" and "Globex <> Robin").
 */
export function sharesTitleName(entities: string[], item: ContextItem): boolean {
  const title = new Set(words(item.title).filter((w) => w.length >= 3));
  return entities.some((e) => words(e).some((w) => w.length >= 3 && title.has(w)));
}
