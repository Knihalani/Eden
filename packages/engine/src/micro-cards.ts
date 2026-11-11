/**
 * Micro cards (`cardsMicro`, trial, M10; docs/research/m10-cards.md): an item's card read by a small tagger at ingest,
 * with no model call and no generated text. This file holds the reading both the lab's trainer and the engine share:
 * the item's tokens, its sentences, and the dates and amounts it mentions resolved to values (`readItem`). A learned
 * network (`MicroCardNet`, below) then only classifies: the card's kind and actions, which tokens are its entities,
 * which date mentions are its start and end, which amount is its limit, and which sentence is its statement. Every
 * field it writes is a span or a value of the item's own text.
 */
import type { ContextItem } from "@eden/protocol";

/** What the reader looks at: the card prompt's own text (title, then the item's own words), at most this long. */
export const MICRO_READ_CHARS = 1_100;
/** Tokens read at most: a long item's tail rarely holds its constraint (the card prompt reads 900 characters). */
export const MICRO_MAX_TOKENS = 220;

export interface Tok {
  /** The token as written. */
  w: string;
  /** Lower case. */
  l: string;
  /** Offset in the read text. */
  at: number;
  /** Sentence number (0 is the title). */
  s: number;
}

export interface DateMention {
  /** Token range [from, to) the mention covers. */
  from: number;
  to: number;
  /** The day it names, YYYY-MM-DD. */
  day: string;
  /** How it was written: 0 a full date, 1 day and month, 2 a weekday or relative word, 3 a month alone (its last day). */
  form: number;
  /** The end of a range ("4-9 Nov": the 9th), 1; its start 2; a lone date 0. */
  range: number;
}

export interface AmountMention {
  from: number;
  to: number;
  value: number;
  unit: string;
}

export interface ReadItem {
  text: string;
  toks: Tok[];
  sentences: number;
  dates: DateMention[];
  amounts: AmountMention[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE =
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|t|tember|ober|ember)?\.?$/;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_RE = /^(sun|mon|tue|wed|thu|fri|sat)(?:day|s|sday|nesday|rsday|urday)?$/;
const DAY_MS = 86_400_000;

/** A token: a word (letters, digits, inner apostrophes, dots and hyphens), a currency sign, or one punctuation mark. */
const TOKEN = /[£$€]|\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:k|m|bn)?%?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*%?|[^\s\p{L}\p{N}]/gu;

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The day `d` of month `m` (0-11) nearest the anchor: within about half a year either side when no year is given. */
function dayNear(d: number, m: number, y: number | undefined, anchor: number): string | null {
  if (d < 1 || d > 31) return null;
  const at = (yy: number) => {
    const t = Date.UTC(yy, m, d);
    return new Date(t).getUTCDate() === d ? t : NaN;
  };
  if (y !== undefined) {
    const t = at(y);
    return Number.isFinite(t) ? iso(t) : null;
  }
  const ay = new Date(anchor).getUTCFullYear();
  let best = NaN;
  for (const yy of [ay - 1, ay, ay + 1]) {
    const t = at(yy);
    if (!Number.isFinite(t)) continue;
    // Later dates are likelier than earlier ones: a message talks about what is coming.
    const dist = t >= anchor - 120 * DAY_MS ? Math.abs(t - anchor) : Infinity;
    if (!Number.isFinite(best) || dist < Math.abs(best - anchor)) best = t;
  }
  return Number.isFinite(best) ? iso(best) : null;
}

const yearOf = (w: string | undefined) => (w && /^(19|20)\d\d$/.test(w) ? Number(w) : undefined);
const dayNum = (w: string | undefined) => {
  const m = w ? /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(w) : null;
  return m ? Number(m[1]) : NaN;
};

/**
 * The item read for the tagger: the card prompt's text (its title as sentence 0, then `own`), tokens with sentence
 * numbers, and its date and amount mentions resolved against `anchor` (when it was written, epoch ms).
 */
export function readText(title: string, own: string, anchor: number): ReadItem {
  const text = `${title.slice(0, 200)}\n${own}`.slice(0, MICRO_READ_CHARS);
  const toks: Tok[] = [];
  let s = 0;
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (toks.length >= MICRO_MAX_TOKENS) break;
    const at = m.index!;
    // A line break or a sentence end between tokens starts a new sentence.
    const gap = text.slice(last, at);
    if (toks.length > 0 && (gap.includes("\n") || /[.!?;]\s*$/.test(gap))) s++;
    const w = m[0];
    toks.push({ w, l: w.toLowerCase(), at, s });
    last = at + w.length;
    if (/^[.!?;]$/.test(w)) last = at; // the end mark itself ends the sentence: the gap after it starts the next
  }
  // Recount sentences from end marks: a "." token closes its sentence.
  let sent = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (i > 0) {
      const prev = toks[i - 1]!;
      const between = text.slice(prev.at + prev.w.length, t.at);
      if (between.includes("\n") || /^[.!?;]$/.test(prev.w)) sent++;
    }
    t.s = sent;
  }
  return { text, toks, sentences: sent + 1, dates: datesIn(toks, anchor), amounts: amountsIn(toks) };
}

/** `readText` on an item as the card prompt reads it. */
export function readItem(item: ContextItem, own: string, anchor: number): ReadItem {
  return readText(item.title, own, anchor);
}

function datesIn(toks: Tok[], anchor: number): DateMention[] {
  const out: DateMention[] = [];
  const L = (i: number) => toks[i]?.l;
  const month = (i: number) => {
    const m = MONTH_RE.exec(L(i) ?? "");
    return m ? MONTHS.indexOf(m[1]!) : -1;
  };
  for (let i = 0; i < toks.length; i++) {
    const l = toks[i]!.l;
    let m: RegExpExecArray | null;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(l))) {
      const day = dayNear(Number(m[3]), Number(m[2]) - 1, Number(m[1]), anchor);
      if (day) out.push({ from: i, to: i + 1, day, form: 0, range: 0 });
      continue;
    }
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(l))) {
      const y = Number(m[3]!.length === 2 ? `20${m[3]}` : m[3]);
      const day = dayNear(Number(m[1]), Number(m[2]) - 1, y, anchor);
      if (day) out.push({ from: i, to: i + 1, day, form: 0, range: 0 });
      continue;
    }
    const d = dayNum(l);
    if (Number.isFinite(d)) {
      // "4 Nov", "4th of November", "4 Nov 2026"; and a range's start "4-9 Nov", "4 to 9 November".
      let j = i + 1;
      if (L(j) === "of") j++;
      let mo = month(j);
      if (mo >= 0) {
        const y = yearOf(L(j + 1) === "," ? L(j + 2) : L(j + 1));
        const end = y !== undefined ? (L(j + 1) === "," ? j + 3 : j + 2) : j + 1;
        const day = dayNear(d, mo, y, anchor);
        if (day) out.push({ from: i, to: end, day, form: y !== undefined ? 0 : 1, range: 0 });
        i = end - 1;
        continue;
      }
      // A range: "4-9 Nov", "4 to 9 November", "4–9 Nov".
      const sep = L(i + 1);
      if (sep === "-" || sep === "–" || sep === "to" || sep === "until" || sep === "till" || sep === "and") {
        let k = i + 2;
        if (WEEKDAY_RE.test(L(k) ?? "")) k++;
        const d2 = dayNum(L(k));
        mo = month(k + 1);
        if (Number.isFinite(d2) && mo >= 0) {
          const y = yearOf(L(k + 2));
          const a = dayNear(d, mo, y, anchor);
          const b = dayNear(d2, mo, y, anchor);
          if (a && b) {
            out.push({ from: i, to: i + 1, day: a, form: 1, range: 2 });
            out.push({ from: k, to: y !== undefined ? k + 3 : k + 2, day: b, form: y !== undefined ? 0 : 1, range: 1 });
            i = (y !== undefined ? k + 3 : k + 2) - 1;
            continue;
          }
        }
      }
      continue;
    }
    const mo = month(i);
    if (mo >= 0 && !/^may$/.test(l)) {
      // "November 18", "Nov 18, 2026"; a month alone with a year ("November 2026") is its last day.
      const dd = dayNum(L(i + 1));
      if (Number.isFinite(dd)) {
        const yi = L(i + 2) === "," ? i + 3 : i + 2;
        const y = yearOf(L(yi));
        const day = dayNear(dd, mo, y, anchor);
        if (day) out.push({ from: i, to: y !== undefined ? yi + 1 : i + 2, day, form: y !== undefined ? 0 : 1, range: 0 });
        continue;
      }
      const y = yearOf(L(i + 1));
      if (y !== undefined) {
        out.push({ from: i, to: i + 2, day: iso(Date.UTC(y, mo, 1)), form: 3, range: 2 });
        out.push({ from: i, to: i + 2, day: iso(Date.UTC(y, mo + 1, 0)), form: 3, range: 1 });
        i++;
        continue;
      }
    }
    // A month alone: its first and last days, the nearest such month ("in January": the next January).
    if (mo >= 0 && l.length > 3) {
      const y = new Date(anchor).getUTCFullYear();
      const am = new Date(anchor).getUTCMonth();
      const yy = mo < am - 1 ? y + 1 : y;
      out.push({ from: i, to: i + 1, day: iso(Date.UTC(yy, mo, 1)), form: 3, range: 2 });
      out.push({ from: i, to: i + 1, day: iso(Date.UTC(yy, mo + 1, 0)), form: 3, range: 1 });
    }
  }
  // Second pass: weekdays, ordinals and relative days, where no date was read at or just after them.
  const taken = new Set<number>();
  for (const d of out) for (let k = d.from; k < d.to; k++) taken.add(k);
  const startsAt = new Set(out.map((d) => d.from));
  for (let i = 0; i < toks.length; i++) {
    if (taken.has(i)) continue;
    const l = toks[i]!.l;
    const wd = WEEKDAY_RE.exec(l);
    if (wd && (l.length > 3 || toks[i]!.w[0] === toks[i]!.w[0]!.toUpperCase())) {
      // A weekday before a date is that date's ("Thu 5 Nov"): the date is read on its own.
      if (startsAt.has(i + 1) || (L(i + 1) === "," && startsAt.has(i + 2))) continue;
      const want = WEEKDAYS.indexOf(wd[1]!);
      const today = new Date(anchor).getUTCDay();
      // The next such weekday after the day it was written ("by Friday" on a Friday is a week on); "next" adds a week
      // only when that weekday is still to come this week.
      let ahead = (want - today + 7) % 7 || 7;
      if (L(i - 1) === "next" && ahead < 7 && want > today) ahead += 7;
      const ord = dayNum(L(i + 1));
      if (Number.isFinite(ord) && /(st|nd|rd|th)$/.test(L(i + 1)!)) {
        const day = monthDayAfter(ord, anchor);
        if (day) out.push({ from: i, to: i + 2, day, form: 2, range: 0 });
        i++;
        continue;
      }
      out.push({ from: i, to: i + 1, day: iso(anchor + ahead * DAY_MS), form: 2, range: 0 });
      continue;
    }
    // "the 12th", "on the 20th": the next such day of the month.
    if (l === "the" && /^\d{1,2}(st|nd|rd|th)$/.test(L(i + 1) ?? "") && month(i + 2) < 0 && L(i + 2) !== "of") {
      const day = monthDayAfter(dayNum(L(i + 1)), anchor);
      if (day) out.push({ from: i, to: i + 2, day, form: 2, range: 0 });
      i++;
      continue;
    }
    // "in 7 days", "within 2 weeks".
    if ((l === "in" || l === "within") && /^\d{1,3}$/.test(L(i + 1) ?? "") && /^(days?|weeks?)$/.test(L(i + 2) ?? "")) {
      const n = Number(L(i + 1)) * (L(i + 2)!.startsWith("week") ? 7 : 1);
      out.push({ from: i, to: i + 3, day: iso(anchor + n * DAY_MS), form: 2, range: 0 });
      i += 2;
      continue;
    }
    if (l === "today" || l === "tonight" || l === "immediately" || l === "now")
      out.push({ from: i, to: i + 1, day: iso(anchor), form: 2, range: 0 });
    else if (l === "tomorrow") out.push({ from: i, to: i + 1, day: iso(anchor + DAY_MS), form: 2, range: 0 });
  }
  // The day it was written, as a mention of its own (from -1): "effective immediately", a lifted hold.
  out.push({ from: -1, to: -1, day: iso(anchor), form: 4, range: 0 });
  return out;
}

/** The next day `d` of a month on or after the anchor's day. */
function monthDayAfter(d: number, anchor: number): string | null {
  if (!(d >= 1 && d <= 31)) return null;
  const a = new Date(anchor);
  for (let k = 0; k < 3; k++) {
    const t = Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + k, d);
    if (new Date(t).getUTCDate() === d && t >= Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) return iso(t);
  }
  return null;
}

function amountsIn(toks: Tok[]): AmountMention[] {
  const out: AmountMention[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const cur = /^[£$€]$/.test(t.w) ? t.w : "";
    const n = cur ? toks[i + 1] : t;
    if (!n) continue;
    const m = /^(\d[\d,]*(?:\.\d+)?)(k|m|bn)?(%)?$/i.exec(n.l.replace(/^(\d+)\.(\d{3})$/, "$1$2"));
    if (!m) continue;
    if (!cur && !m[3] && !m[2]) {
      // A bare number counts only before a money or share word ("500 pounds", "10 percent").
      const next = toks[(cur ? i + 2 : i + 1)]?.l ?? "";
      if (!/^(pounds?|dollars?|euros?|gbp|usd|eur|percent|per)$/.test(next)) continue;
    }
    const k = (m[2] ?? toks[(cur ? i + 2 : i + 1)]?.l ?? "").toLowerCase();
    const scale = k === "k" ? 1e3 : k === "m" ? 1e6 : k === "bn" ? 1e9 : 1;
    const value = Number(m[1]!.replace(/,/g, "")) * scale;
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = m[3] ? "%" : cur;
    out.push({ from: i, to: cur ? i + 2 : i + 1, value, unit });
    if (cur) i++;
  }
  return out;
}
