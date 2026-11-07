import type { ContextItem } from "@eden/protocol";
import { namesParticipant, startDay } from "./grounding";

/**
 * `askNudge` (D316, D317; docs/research/a12-quality.md): whether the push's candidates settle what the request is
 * about, with no model. A request's anchors are the people and things it names (its entities) and the days it names
 * (its time window, and calendar dates written out). A candidate settles the request when it holds every kind of
 * anchor the request has: one of its entities, and (when the request names a day) one of its days. A request with no
 * anchor is never unsettled: there is nothing for the agent to pin down by asking.
 *
 * Why: A2 found the facts the push misses rank 6th–15th in its pool or in no pool at all, and that the agent's own
 * `ask_context` is the one reader of the request's meaning left since D237. D257's note made the agent skip asks and
 * lost hidden facts; this is the opposite, a nudge to ask when the packet visibly does not pin the request down.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
/** "31 October", "12–14 November", "21-23 Dec", "the 3rd of January". */
const DAY_MONTH = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s*[–—-]\s*(\d{1,2})(?:st|nd|rd|th)?)?(?:\s+of)?\s+${MONTH}\b`,
  "g",
);
/** "November 12", "Nov 5th". */
const MONTH_DAY = new RegExp(String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "g");

/** A calendar day without its year. */
export interface NamedDay {
  day: number;
  /** 0-11. */
  month: number;
}

/** The calendar dates a text names explicitly (day and month), a range's days included (at most 14). */
export function namedDays(text: string): NamedDay[] {
  const t = text.toLowerCase();
  const out: NamedDay[] = [];
  const add = (day: number, month: number) => {
    if (month < 0 || day < 1 || day > 31) return;
    if (!out.some((x) => x.day === day && x.month === month)) out.push({ day, month });
  };
  for (const m of t.matchAll(DAY_MONTH)) {
    const from = Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : from;
    const month = MONTHS.indexOf(m[3]!.slice(0, 3));
    for (let d = from; d <= Math.min(to, from + 13); d++) add(d, month);
  }
  for (const m of t.matchAll(MONTH_DAY)) add(Number(m[2]), MONTHS.indexOf(m[1]!.slice(0, 3)));
  return out;
}

const ORDINAL = (d: number) =>
  d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th";

/**
 * Whether a text names one of `days`: the day with its month either way round ("31 Oct", "October 31st"), the day as
 * an ordinal alone ("the 31st", "Friday 20th"), or day/month in figures ("31/10", "31.10").
 */
export function namesDay(text: string, days: readonly NamedDay[]): boolean {
  if (days.length === 0) return false;
  const t = text.toLowerCase();
  for (const { day, month } of days) {
    const name = String.raw`${MONTHS[month]!}[a-z]*`;
    const dd = String(day).padStart(2, "0");
    const mm = String(month + 1).padStart(2, "0");
    const re = new RegExp(
      String.raw`\b${day}(?:st|nd|rd|th)?(?:\s+of)?\s+${name}\b|\b${name}\s+${day}(?:st|nd|rd|th)?\b|\b${day}${ORDINAL(day)}\b|\b0?${day}/${mm}\b|\b${dd}\.${mm}\b`,
    );
    if (re.test(t)) return true;
  }
  return false;
}

/** What a request names, for `settles` and `anchored`. */
export interface Anchors {
  /** Its entities as the cue holds them (names, handles, quoted phrases). */
  entities: readonly string[];
  /** Its days as "YYYY-MM-DD" (the cue's time window), and the dates it writes out. */
  days: ReadonlySet<string>;
  named: readonly NamedDay[];
  /** The user's UTC offset (minutes), for an event's start day. */
  offset: number;
}

/** The anchors of a request: its entities, its time window's days, and its written dates. */
export function anchorsOf(
  entities: readonly string[],
  days: ReadonlySet<string> | null,
  raw: string,
  offset: number,
): Anchors {
  const named = namedDays(raw);
  const set = new Set(days ?? []);
  // A written date is a day too: "the 31st of October" with no window resolved still anchors the request.
  return { entities, days: set, named, offset };
}

export const hasDay = (a: Anchors) => a.days.size > 0 || a.named.length > 0;

/** The calendar days of the time window as `NamedDay`s, so an item that writes the date out ("Fri 13 Nov") matches. */
function windowDays(a: Anchors): NamedDay[] {
  const out = [...a.named];
  for (const d of a.days) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d);
    if (m) out.push({ day: Number(m[2]), month: Number(m[1]) - 1 });
  }
  return out;
}

/** Whether `item` names one of the request's entities: as a participant, or its words in the item's title or text. */
export function namesEntity(item: ContextItem, a: Anchors): boolean {
  if (a.entities.length === 0) return false;
  const text = `${item.title} ${item.text}`.toLowerCase().replace(/\s+/g, " ");
  return a.entities.some((e) => {
    if (namesParticipant(e, item)) return true;
    const w = e.toLowerCase().replace(/\s+/g, " ").trim();
    if (w.length < 2) return false;
    // On letter and number boundaries: "Harlow." and "Harlow-based" name Harlow, "Harlowe" does not.
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
  });
}

/** Whether `item` is on, or names, one of the request's days. */
export function namesRequestDay(item: ContextItem, a: Anchors): boolean {
  if (!hasDay(a)) return false;
  const start = startDay(item, a.offset);
  if (start !== null && a.days.has(start)) return true;
  return namesDay(`${item.title}\n${item.text}`, windowDays(a));
}

/**
 * Whether the request has an anchor at all and the items settle it: some item holds every kind of anchor the request
 * names (an entity when it names one, a day when it names one). True for a request with no anchor (nothing to settle).
 */
export function settles(items: readonly ContextItem[], a: Anchors): boolean {
  const wantsEntity = a.entities.length > 0;
  const wantsDay = hasDay(a);
  if (!wantsEntity && !wantsDay) return true;
  return items.some((x) => (!wantsEntity || namesEntity(x, a)) && (!wantsDay || namesRequestDay(x, a)));
}

/** Whether `item` holds any of the request's anchors (an entity or a day): what the ask's deeper look keeps. */
export function anchored(item: ContextItem, a: Anchors): boolean {
  return namesEntity(item, a) || namesRequestDay(item, a);
}

/**
 * `pushCandidatesSettled` (D400, D404): how many of `items` (in order) to hand when the request has an anchor and the
 * items settle it: the first `fewer`, extended through the first item that settles it alone. Otherwise (no anchor,
 * unsettled, `fewer` 0 or not below the count) all of them.
 */
export function settledCut(items: readonly ContextItem[], a: Anchors, fewer: number): number {
  if (fewer <= 0 || fewer >= items.length) return items.length;
  if (a.entities.length === 0 && !hasDay(a)) return items.length;
  const first = items.findIndex((x) => settles([x], a));
  return first < 0 ? items.length : Math.max(fewer, first + 1);
}
