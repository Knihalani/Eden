/**
 * Trial `pushReach` (D330, docs/research/a15-retrieval.md): the days an item's text says it holds for, so the push can
 * offer an item whose stated span covers a day the request names though it shares few of the request's words ("LCY
 * closed 14–22 November" for a flight on Wednesday 18 November; "we fly to Kraków on Wednesday 28th and are back
 * Monday 9 November" for a delivery on 29 October). No model, linear in the text, bounded by `READ_CHARS`.
 */

const DAY = 86_400_000;
/** The head of an item read for its spans. */
const READ_CHARS = 1_200;
/** Spans read from one item at most. */
const MAX_SPANS = 24;
/** An open-ended span ("from Monday 2 November", "effective 1 Oct") is read as this many days long. */
const OPEN_DAYS = 60;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;
const ORD = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
const TO = String.raw`\s*(?:–|—|-|to|until|till|through|thru)\s*(?:[a-z]+day\s+)?`;
/** "14–22 November", "28 Oct – 3 Nov", "Saturday 14 to Sunday 22 November". */
const FULL_RANGE = new RegExp(String.raw`\b${ORD}\s+${MONTH}${TO}${ORD}\s+${MONTH}\b`, "g");
const SHORT_RANGE = new RegExp(String.raw`\b${ORD}${TO}${ORD}\s+${MONTH}\b`, "g");
const DAY_MONTH = new RegExp(String.raw`\b${ORD}\s+${MONTH}\b`, "g");
const MONTH_DAY = new RegExp(String.raw`\b${MONTH}\s+${ORD}\b`, "g");
/** Words before a date that make it the end of a span from now ("until 1 Dec", "before 13 November"). */
const UNTIL_BEFORE = /\b(until|till|through|before|by|ends?|expires?|lapses?)\s+(?:[a-z]+day,?\s+)?(?:the\s+)?$/;
/** ... or its start, open-ended ("from Monday 2 November", "effective 1 Oct"). */
const FROM_BEFORE = /\b(from|after|starting|effective|since)\s+(?:[a-z]+day,?\s+)?(?:the\s+)?$/;

/** A day-month as the UTC midnight nearest `now`'s year within about a year (D44's rule for a date with no year). */
function dayAt(day: number, month: string, now: number): number | null {
  const m = MONTHS.indexOf(month);
  if (m < 0 || day < 1 || day > 31) return null;
  const year = new Date(now).getUTCFullYear();
  let at = Date.UTC(year, m, day);
  if (new Date(at).getUTCDate() !== day) return null;
  if (at < now - 182 * DAY) at = Date.UTC(year + 1, m, day);
  return at;
}

/** The day spans `[first, last]` (UTC midnights, inclusive) the text states, most `MAX_SPANS`. */
export function textSpans(text: string, now: number): [number, number][] {
  const t = text.slice(0, READ_CHARS).toLowerCase();
  const out: [number, number][] = [];
  const used: [number, number][] = [];
  const inUsed = (i: number) => used.some(([a, b]) => i >= a && i < b);
  const today = now - (((now % DAY) + DAY) % DAY);
  for (const m of t.matchAll(FULL_RANGE)) {
    const a = dayAt(Number(m[1]), m[2]!, now);
    const b = dayAt(Number(m[3]), m[4]!, now);
    if (a !== null && b !== null && a <= b) {
      out.push([a, b]);
      used.push([m.index!, m.index! + m[0].length]);
    }
  }
  for (const m of t.matchAll(SHORT_RANGE)) {
    if (inUsed(m.index!)) continue;
    const a = dayAt(Number(m[1]), m[3]!, now);
    const b = dayAt(Number(m[2]), m[3]!, now);
    if (a !== null && b !== null && a <= b) {
      out.push([a, b]);
      used.push([m.index!, m.index! + m[0].length]);
    }
  }
  const single = (at: number | null, index: number) => {
    if (at === null) return;
    const before = t.slice(Math.max(0, index - 25), index);
    if (UNTIL_BEFORE.test(before)) out.push([Math.min(today, at), at]);
    else if (FROM_BEFORE.test(before)) out.push([at, at + OPEN_DAYS * DAY]);
    else out.push([at, at]);
  };
  for (const m of t.matchAll(DAY_MONTH)) if (!inUsed(m.index!)) single(dayAt(Number(m[1]), m[2]!, now), m.index!);
  for (const m of t.matchAll(MONTH_DAY)) if (!inUsed(m.index!)) single(dayAt(Number(m[2]), m[1]!, now), m.index!);
  return out.slice(0, MAX_SPANS);
}

/** Whether any span covers one of `days` (YYYY-MM-DD, as `timeWindow` gives them). */
export function coversDay(spans: readonly [number, number][], days: Iterable<string>): boolean {
  for (const d of days) {
    const at = Date.parse(`${d}T00:00:00Z`);
    if (Number.isFinite(at) && spans.some(([a, b]) => a <= at && at <= b)) return true;
  }
  return false;
}
