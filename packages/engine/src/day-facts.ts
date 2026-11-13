/**
 * `ItemCache.dated`'s per-item date facts (D1721): what `coversDay` and `namesDay` read of an item's text, read once
 * and kept as a number or a few small integers, so a request that names a day checks each item against its facts
 * instead of inflating, lower-casing and regex-scanning its text again (the scan read up to 20,000 texts a request;
 * the decode memo holds 256, so it thrashed: about a fifth of the funnel's CPU).
 *
 * The facts depend on the item's title and text alone, never on the request: the days a request names are checked
 * against them at query time (`dayFactsClass`), with `coversDay`'s own span arithmetic (`coversSpans`).
 * `day-facts.test.ts` fuzzes them against the functions they replace.
 *
 * Keys are `month * 32 + day` (0-383); the ordinal mask has bit `day - 1` set for each day written as a bare ordinal
 * ("the 5th"). Two forms, so an item costs no heap of its own in the common case (a mail's one date line):
 * - a number, when the text writes no span and names at most two days: `mask + 2^31 (key1 + 1) + 2^40 (key2 + 1)`
 *   (0 there is "none"; 49 bits, an exact double, held unboxed in the entry's slot); 0 is "no fact";
 * - else a `Uint16Array`, runs each led by its length: [closed ends (from, to pairs), open ends, named days, mask lo,
 *   mask hi].
 */
import { coversSpans, spanFactsOf } from "./days";

/** What the scan reads of an item: its title and text, this many characters of them (as `ItemCache.dated` did). */
export const DATED_CHARS = 4_000;

export type DayFacts = number | Uint16Array;

const MONTH3 = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const K1 = 2 ** 31;
const K2 = 2 ** 40;

/*
 * `dayPattern`'s five forms (settle.ts) with the day and month left open, so one pass finds every day a text names in
 * each form. Each is the per-day regex with `{day}` read as a run of digits and `{month}` as the three-letter name;
 * a capture is kept only when it is how that form writes the day: `String(day)` (no leading zero) for the first four,
 * two digits for `dd.mm`, and the ordinal's own suffix for the third. The two figure forms can overlap ("5/03/04"
 * names 5 March and 3 April), so they match in a lookahead: every position is tried, nothing consumed. The other
 * three cannot overlap themselves: each match starts on a digit run or a month at a word boundary and ends at one.
 */
/** "5 March", "5th of mar", "5 marketing" (`{month}[a-z]*` takes any word on the month's three letters). */
const DAY_MONTH = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+${MONTH3}[a-z]*\b`, "g");
/** "March 5", "mar 5th". */
const MONTH_DAY = new RegExp(String.raw`\b${MONTH3}[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "g");
/** "5th", "21st": the day alone, with its own ordinal suffix. */
const ORDINAL_DAY = /\b(\d{1,2})(st|nd|rd|th)\b/g;
/** "5/03", "05/03", "010/11": `\b0?{day}/{mm}\b`. */
const SLASH = /(?=\b(0?)(\d{1,2})\/(\d{2})\b)/g;
/** "05.03": `\b{dd}\.{mm}\b`. */
const DOTTED = /(?=\b(\d{2})\.(\d{2})\b)/g;

const ordinal = (d: number) =>
  d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th";

/** A day written as `dayPattern` writes it: its digits with no leading zero, 1-31; else 0. */
function plainDay(digits: string): number {
  const d = Number(digits);
  return d >= 1 && d <= 31 && String(d) === digits ? d : 0;
}

/** The days (keys, ascending) `lower` names in `dayPattern`'s forms, and the mask of days written as an ordinal. */
function namedOf(lower: string): { keys: number[]; mask: number } {
  const keys = new Set<number>();
  let mask = 0;
  for (const m of lower.matchAll(DAY_MONTH)) {
    const d = plainDay(m[1]!);
    if (d) keys.add(MONTHS.indexOf(m[2]!) * 32 + d);
  }
  for (const m of lower.matchAll(MONTH_DAY)) {
    const d = plainDay(m[2]!);
    if (d) keys.add(MONTHS.indexOf(m[1]!) * 32 + d);
  }
  for (const m of lower.matchAll(ORDINAL_DAY)) {
    const d = plainDay(m[1]!);
    if (d && m[2] === ordinal(d)) mask |= 1 << (d - 1);
  }
  for (const m of lower.matchAll(SLASH)) {
    const d = plainDay(m[2]!);
    const month = Number(m[3]);
    if (d && month >= 1 && month <= 12) keys.add((month - 1) * 32 + d);
  }
  for (const m of lower.matchAll(DOTTED)) {
    const d = Number(m[1]);
    const month = Number(m[2]);
    if (d >= 1 && d <= 31 && month >= 1 && month <= 12) keys.add((month - 1) * 32 + d);
  }
  return { keys: [...keys].sort((a, b) => a - b), mask: mask >>> 0 };
}

/**
 * The date facts of an item's title and text: the spans `coversDay` reads (closed ranges, open "until" ends) and the
 * days `namesDay` finds, read from the first `DATED_CHARS` characters lower-cased, as `ItemCache.dated` read them.
 */
export function dayFactsOf(title: string, text: string): DayFacts {
  const lower = `${title}\n${text}`.slice(0, DATED_CHARS).toLowerCase();
  // No digit, no date: most chat lines and short notes end here.
  if (!/\d/.test(lower)) return 0;
  const span = spanFactsOf(lower);
  const { keys, mask } = namedOf(lower);
  if (span === null && keys.length <= 2) {
    return mask + (keys.length > 0 ? K1 * (keys[0]! + 1) : 0) + (keys.length > 1 ? K2 * (keys[1]! + 1) : 0);
  }
  const closed = span?.closed ?? [];
  const open = span?.open ?? [];
  const out = new Uint16Array(5 + closed.length + open.length + keys.length);
  let at = 0;
  out[at++] = closed.length;
  for (let i = 0; i < closed.length; i++) out[at++] = closed[i]!;
  out[at++] = open.length;
  for (let i = 0; i < open.length; i++) out[at++] = open[i]!;
  out[at++] = keys.length;
  for (const k of keys) out[at++] = k;
  out[at++] = mask & 0xffff;
  out[at] = mask >>> 16;
  return out;
}

/** Whether a key is a real month's day (1-31): only those are named here, and a time window gives only those. */
const real = (w: number) => w >= 0 && w < 12 * 32 && (w & 31) !== 0;

/** `namesDay` over number-form facts. */
function namesPacked(f: number, want: readonly number[]): boolean {
  const mask = f % K1;
  const k1 = Math.floor(f / K1) % 512;
  const k2 = Math.floor(f / K2);
  for (const w of want) {
    if (!real(w)) continue;
    if (Math.floor(mask / 2 ** ((w & 31) - 1)) % 2 === 1) return true;
    if (w + 1 === k1 || w + 1 === k2) return true;
  }
  return false;
}

/**
 * What `ItemCache.dated` makes of an item from its facts, for a request's `days` (`want`: their keys, `dayKeys`):
 * 1 when the text spans one of them (`coversDay`), else 2 when it names one (`namesDay`), else -1. `updatedAt` is the
 * item's own (ms), where an open "until" range starts.
 */
export function dayFactsClass(
  f: DayFacts,
  days: ReadonlySet<string>,
  want: readonly number[],
  updatedAt?: number,
): number {
  if (typeof f === "number") return f !== 0 && namesPacked(f, want) ? 2 : -1;
  const c = f[0]!;
  const o = f[1 + c]!;
  if (coversSpans({ closed: f.subarray(1, 1 + c), open: f.subarray(2 + c, 2 + c + o) }, days, want, updatedAt)) {
    return 1;
  }
  let at = 2 + c + o;
  const n = f[at++]!;
  const mask = (f[at + n]! | (f[at + n + 1]! << 16)) >>> 0;
  for (const w of want) {
    if (!real(w)) continue;
    if ((mask >>> ((w & 31) - 1)) & 1) return 2;
    for (let i = 0; i < n; i++) if (f[at + i] === w) return 2;
  }
  return -1;
}
