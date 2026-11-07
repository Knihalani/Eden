import type { ContextItem } from "@eden/protocol";

/**
 * `pushCandidateLift` (trial, D266; docs/research/a2-quality.md): a no-model re-order of the push's candidate pool
 * before its first `k` are handed to the agent. The pool's own order (lexical, grounded and intent fused) stays the
 * spine: the first `LIFT_KEEP` items keep their places. Two cheap fixes follow it:
 *
 * - **One item per title.** A pool often holds a series under one title (a weekly "Focus time", four "Expense policy"
 *   mails from different senders); a repeat of a title already in the pool is skipped, so it does not take a seat a
 *   different item could have.
 * - **The request's own date.** After the kept items, up to `LIFT_DATED` items that name a calendar date the request
 *   names ("Saturday 31 October" in the request, "Sat 31 Oct" or "the 31st" in the item) move up. A planted fact about
 *   that day (a clash, a babysitter cancelling "Friday 20th") shares few other words with the request.
 *
 * Measured on train at $0 before it was built (the push's pool dumped by `hidden-funnel.ts --pool-dump`): planted items
 * in the first five 253 → 264 of 384, decoys 219 → 225, items handed unchanged.
 */
export const LIFT_KEEP = 3;
export const LIFT_DATED = 2;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
/** "31 October", "12–14 November", "21-23 Dec", "the 3rd of January". */
const DAY_MONTH = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s*[–—-]\s*(\d{1,2})(?:st|nd|rd|th)?)?(?:\s+of)?\s+${MONTH}\b`,
  "g",
);
/** "November 12", "Nov 5th". */
const MONTH_DAY = new RegExp(String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "g");

/** A calendar day without its year, as the request names it. */
export interface NamedDay {
  day: number;
  /** 0-11. */
  month: number;
}

/** The calendar dates a request names explicitly (day and month), a range's days included (at most 14). */
export function namedDays(request: string): NamedDay[] {
  const t = request.toLowerCase();
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
 * an ordinal alone ("the 31st", "Friday 20th"), or day/month in figures ("31/10").
 */
export function namesDay(text: string, days: readonly NamedDay[]): boolean {
  if (days.length === 0) return false;
  const t = text.toLowerCase();
  for (const { day, month } of days) {
    const mon = MONTHS[month]!;
    const name = String.raw`${mon}[a-z]*`;
    const dd = String(day).padStart(2, "0");
    const mm = String(month + 1).padStart(2, "0");
    const re = new RegExp(
      String.raw`\b${day}(?:st|nd|rd|th)?(?:\s+of)?\s+${name}\b|\b${name}\s+${day}(?:st|nd|rd|th)?\b|\b${day}${ORDINAL(day)}\b|\b0?${day}/${mm}\b|\b${dd}\.${mm}\b`,
    );
    if (re.test(t)) return true;
  }
  return false;
}

/** A title as a repeat is recognised: lower case, a reply's or forward's prefix off, spaces folded. */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(?:(?:re|fwd?|fw)\s*:\s*)+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The pool re-ordered as described above (`pushCandidateLift`); a repeat of a title is left out. */
export function liftCandidates<T extends { item: ContextItem }>(pool: readonly T[], request: string): T[] {
  const seen = new Set<string>();
  const distinct: T[] = [];
  for (const x of pool) {
    const key = titleKey(x.item.title);
    // An untitled item is its own: nothing to repeat.
    if (key !== "" && seen.has(key)) continue;
    seen.add(key);
    distinct.push(x);
  }
  const days = namedDays(request);
  if (days.length === 0) return distinct;
  const head = distinct.slice(0, LIFT_KEEP);
  const rest = distinct.slice(LIFT_KEEP);
  const dated: T[] = [];
  const others: T[] = [];
  for (const x of rest) {
    if (dated.length < LIFT_DATED && namesDay(`${x.item.title}\n${x.item.text}`, days)) dated.push(x);
    else others.push(x);
  }
  return [...head, ...dated, ...others];
}
