/**
 * M10's micro card tagger (lab only; docs/research/m10-cards.md, D960–D963). The trial `cardsMicro` that ran it in
 * the engine was rejected and deleted (D960): this file keeps its reader and network so the lab's export, gates and
 * parity can be re-run. The reader is what the trainers and the network share: an item's tokens, its sentences, and
 * the dates and amounts it mentions resolved to values (`readText`). The network (`MicroCardNet`) only classifies:
 * the card's kind and actions, which tokens are its entities, which date mentions are its start and end, which amount
 * is its limit, and which sentence is its statement. Every field it writes is a span or a value of the item's text.
 */
import { readFileSync } from "node:fs";
import type { ContextItem } from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import { ACTIONS, CARD_KINDS, datedOf, ownText, type Card } from "../../../../engine/src/cards";

const CARD_KIND_LIST = CARD_KINDS;
const ACTION_LIST = Object.keys(ACTIONS) as (keyof typeof ACTIONS)[];

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
  /**
   * How it was written: 0 a full date, 1 day and month, 2 a weekday or relative word, 3 a month alone (its first or
   * last day), 4 the item's own date.
   */
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
const TOKEN =
  /[£$€]|\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:k|m|bn)?%?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*%?|[^\s\p{L}\p{N}]/gu;

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
  for (const m of text.matchAll(TOKEN)) {
    if (toks.length >= MICRO_MAX_TOKENS) break;
    const at = m.index!;
    const w = m[0];
    // A day range written with a hyphen ("4-9", "2-6") is three tokens, as with a dash, so its days are read.
    const range = /^(\d{1,2})-(\d{1,2})$/.exec(w);
    if (range) {
      const d2 = at + range[1]!.length + 1;
      toks.push({ w: range[1]!, l: range[1]!, at, s: 0 }, { w: "-", l: "-", at: d2 - 1, s: 0 });
      toks.push({ w: range[2]!, l: range[2]!, at: d2, s: 0 });
    } else toks.push({ w, l: w.toLowerCase(), at, s: 0 });
  }
  if (toks.length > MICRO_MAX_TOKENS) toks.length = MICRO_MAX_TOKENS;
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
        if (day)
          out.push({ from: i, to: y !== undefined ? yi + 1 : i + 2, day, form: y !== undefined ? 0 : 1, range: 0 });
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
    if (new Date(t).getUTCDate() === d && t >= Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()))
      return iso(t);
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
      const next = toks[cur ? i + 2 : i + 1]?.l ?? "";
      if (!/^(pounds?|dollars?|euros?|gbp|usd|eur|percent|per)$/.test(next)) continue;
    }
    const k = (m[2] ?? toks[cur ? i + 2 : i + 1]?.l ?? "").toLowerCase();
    const scale = k === "k" ? 1e3 : k === "m" ? 1e6 : k === "bn" ? 1e9 : 1;
    const value = Number(m[1]!.replace(/,/g, "")) * scale;
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = m[3] ? "%" : cur;
    out.push({ from: i, to: cur ? i + 2 : i + 1, value, unit });
    if (cur) i++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The network (`MicroCardNet`): one hashed sparse linear layer per field (lab: packages/sim/lab/m10/h1_sparse.py).
// Every feature is a string hashed (CRC-32 of its UTF-8) into `buckets`; a field's logits are the sum of its rows. The
// feature strings below are the trainer's exactly: a change to one is a new weights file.

/** Where `export_h1.py` writes the weights in the lab (not committed: the model was rejected, D960). */
export const MICRO_CARDS_PATH = ".local/m10/micro-cards-v1.bin";

const KIND_NAMES = CARD_KIND_LIST;
const ACTION_NAMES_ORDER = ACTION_LIST;
const MAX_ACTIONS = 3;
const MAX_ENTITIES = 6;

interface Head {
  out: number;
  scale: Float32Array;
  bias: Float32Array;
  w: Int8Array;
}

/** Python's `str(bool)`, which the trainer's feature strings hold. */
const py = (b: boolean) => (b ? "True" : "False");
/** Code points, as Python indexes a string (an emoji is one, not two). */
const cps = (s: string) => Array.from(s);

function shape(w: string): string {
  const s = w
    .replace(/[A-Z]/g, "A")
    .replace(/[a-z]/g, "a")
    .replace(/[0-9]/g, "9")
    .replace(/(.)\1+/gu, "$1$1");
  return cps(s).slice(0, 6).join("");
}
const upper0 = (w: string) => {
  const c = cps(w)[0] ?? "";
  return c !== c.toLowerCase() && c === c.toUpperCase();
};

/** Whole days from `a` to `b` (YYYY-MM-DD). */
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

export class MicroCardNet {
  private readonly heads = new Map<string, Head>();
  readonly buckets: number;
  readonly bytes: number;
  /** Decision thresholds the trainer chose (in the file's header): P(constraint) to flag, P(action) to keep it. */
  readonly tFlag: number;
  readonly tAct: number;
  /** A token is part of an entity when P(outside) is under this (B or I, the likelier); null: the likeliest tag. */
  readonly tEnt: number | null;

  constructor(buf: Uint8Array) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!) !== "MCV1") throw new Error("micro cards: bad magic");
    const hl = dv.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + hl))) as {
      buckets: number;
      heads: { name: string; out: number }[];
      tFlag?: number;
      tAct?: number;
      tEnt?: number;
    };
    this.buckets = header.buckets;
    this.tFlag = header.tFlag ?? 0.5;
    this.tAct = header.tAct ?? 0.5;
    this.tEnt = header.tEnt ?? null;
    let at = 8 + hl;
    // Copied out so each table is aligned for its typed array, whatever the file's offsets.
    const f32 = (n: number) => {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = dv.getFloat32(at + i * 4, true);
      at += n * 4;
      return out;
    };
    for (const h of header.heads) {
      const scale = f32(h.out);
      const bias = f32(h.out);
      const n = header.buckets * h.out;
      if (at + n > buf.byteLength) throw new Error("micro cards: truncated weights");
      const w = new Int8Array(n);
      w.set(new Int8Array(buf.buffer, buf.byteOffset + at, n));
      at += n;
      this.heads.set(h.name, { out: h.out, scale, bias, w });
    }
    for (const name of ["kind", "act", "bio", "date", "amt", "stmt"]) {
      if (!this.heads.has(name)) throw new Error(`micro cards: no ${name} head`);
    }
    this.bytes = buf.byteLength;
  }

  /** The trainer's bucket: CRC-32 of the feature's UTF-8 (Bun hashes a string's UTF-8 with no copy). */
  private ids(feats: string[]): number[] {
    if (feats.length === 0) return [0];
    const out = new Array<number>(feats.length);
    for (let i = 0; i < feats.length; i++) out[i] = Bun.hash.crc32(feats[i]!) % this.buckets;
    return out;
  }

  /** A field's logits for one bag of feature strings (or their buckets). */
  private logits(name: string, feats: string[] | number[]): Float64Array {
    const h = this.heads.get(name)!;
    const acc = new Float64Array(h.out);
    const ids = typeof feats[0] === "number" ? (feats as number[]) : this.ids(feats as string[]);
    for (const id of ids) {
      const row = id * h.out;
      for (let j = 0; j < h.out; j++) acc[j] = acc[j]! + h.w[row + j]!;
    }
    for (let j = 0; j < h.out; j++) acc[j] = acc[j]! * h.scale[j]! + h.bias[j]!;
    return acc;
  }

  /** The card for a read item (`readText`), `dated` its own date or `today`'s (YYYY-MM-DD), `source` its source id. */
  card(read: ReadItem, dated: string, source: string): Card {
    const toks = read.toks;
    const lw = toks.map((t) => t.l);
    // Item heads.
    const item: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const l = lw[i]!;
      item.push(`w:${l}`, `${toks[i]!.s === 0 ? "T" : "B"}w:${l}`);
      if (i + 1 < toks.length) item.push(`bg:${l} ${lw[i + 1]}`);
      const p = cps(`<${l}>`);
      for (const n of [3, 4]) for (let k = 0; k + n <= p.length; k++) item.push(`c${n}:${p.slice(k, k + n).join("")}`);
    }
    item.push(`src:${source}`, `nd:${Math.min(read.dates.length, 5)}`, `na:${Math.min(read.amounts.length, 3)}`);
    const itemIds = this.ids(item);
    const kind = softmax(this.logits("kind", itemIds));
    // As the trainer decodes: the most likely kind; none when P(not none) is under `tFlag`; the best constraint kind
    // when none leads but P(not none) reaches it.
    let k = argmax(kind, 0);
    if (1 - kind[0]! < this.tFlag) k = 0;
    else if (k === 0) k = argmax(kind, 1);
    if (k === 0) return { kind: "none", actions: [], entities: [], statement: "" };
    const act = this.logits("act", itemIds).map(sigmoid);
    const order = [...act.keys()].sort((a, b) => act[b]! - act[a]! || a - b);
    let actions = order.filter((j) => act[j]! >= this.tAct).slice(0, MAX_ACTIONS);
    if (actions.length === 0) actions = [order[0]!];
    const card: Card = {
      kind: KIND_NAMES[k]!,
      // In the vocabulary's order: two saturated probabilities tie in one precision and not in another.
      actions: actions.sort((a, b) => a - b).map((j) => ACTION_NAMES_ORDER[j]!),
      entities: this.entities(read),
      statement: "",
    };
    // Dates: the mention most likely the start, and the one most likely the end.
    if (read.dates.length > 0) {
      const roles = read.dates.map((d) => this.logits("date", this.mention(read, d, "date", dated)).map(sigmoid));
      let si = 0;
      let ei = 0;
      roles.forEach((r, i) => {
        if (r[0]! > roles[si]![0]!) si = i;
        if (r[1]! > roles[ei]![1]!) ei = i;
      });
      if (roles[si]![0]! >= 0.5) card.start = read.dates[si]!.day;
      if (roles[ei]![1]! >= 0.5) card.end = read.dates[ei]!.day;
      if (card.start && card.end && card.end < card.start) delete card.start;
    }
    if (read.amounts.length > 0) {
      const ps = read.amounts.map((a) => sigmoid(this.logits("amt", this.mention(read, a, "amt", dated))[0]!));
      let i = 0;
      ps.forEach((p, j) => {
        if (p > ps[i]!) i = j;
      });
      if (ps[i]! >= 0.5) {
        card.limit = read.amounts[i]!.value;
        card.unit = read.amounts[i]!.unit;
      }
    }
    // The statement: the sentence the statement head scores highest, as written.
    const nsent = toks.length > 0 ? toks[toks.length - 1]!.s + 1 : 1;
    let bs = 0;
    let bv = -Infinity;
    for (let s = 0; s < nsent; s++) {
      const ws = toks.filter((t) => t.s === s).map((t) => t.l);
      const v = this.logits("stmt", [
        ...ws.map((w) => `w:${w}`),
        `pos:${Math.min(s, 5)}`,
        `len:${Math.min(Math.floor(ws.length / 5), 6)}`,
      ])[0]!;
      if (v > bv) {
        bv = v;
        bs = s;
      }
    }
    card.statement = joinTokens(toks.filter((t) => t.s === bs).map((t) => t.w)).slice(0, 160);
    return card;
  }

  private entities(read: ReadItem): string[] {
    const toks = read.toks;
    const spans: string[][] = [];
    let cur: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const f = this.tokFeats(read, i);
      const p = softmax(this.logits("bio", f));
      const tag =
        this.tEnt !== null
          ? p[0]! >= this.tEnt
            ? 0
            : p[1]! >= p[2]!
              ? 1
              : 2
          : p[1]! > p[0]! && p[1]! >= p[2]!
            ? 1
            : p[2]! > p[0]! && p[2]! > p[1]!
              ? 2
              : 0;
      if (tag === 1 || (tag === 2 && cur.length === 0)) {
        if (cur.length) spans.push(cur);
        cur = [toks[i]!.w];
      } else if (tag === 2) cur.push(toks[i]!.w);
      else {
        if (cur.length) spans.push(cur);
        cur = [];
      }
    }
    if (cur.length) spans.push(cur);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of spans) {
      const e = joinTokens(s).slice(0, 60);
      if (seen.has(e.toLowerCase())) continue;
      seen.add(e.toLowerCase());
      out.push(e);
    }
    return out.slice(0, MAX_ENTITIES);
  }

  private tokFeats(read: ReadItem, i: number): string[] {
    const toks = read.toks;
    const t = toks[i]!;
    const l = t.l;
    const lc = cps(l);
    const g = (k: number) => (k >= 0 && k < toks.length ? toks[k]!.l : "<pad>");
    return [
      `w:${l}`,
      `sh:${shape(t.w)}`,
      `p3:${lc.slice(0, 3).join("")}`,
      `s3:${lc.slice(-3).join("")}`,
      `t:${py(t.s === 0)}`,
      `w-1:${g(i - 1)}`,
      `w+1:${g(i + 1)}`,
      `w-2:${g(i - 2)}`,
      `w+2:${g(i + 2)}`,
      `sh-1:${i > 0 ? shape(toks[i - 1]!.w) : "<"}`,
      `cap:${py(upper0(t.w))}`,
      `cap-1:${i > 0 ? py(upper0(toks[i - 1]!.w)) : "x"}`,
      `cap+1:${i + 1 < toks.length ? py(upper0(toks[i + 1]!.w)) : "x"}`,
    ];
  }

  private mention(read: ReadItem, m: DateMention | AmountMention, kind: "date" | "amt", dated: string): string[] {
    const toks = read.toks;
    const f: string[] = [kind];
    const a = m.from;
    const b = m.to;
    if (a < 0) f.push("anchor");
    else {
      for (let d = 1; d < 5; d++) {
        if (a - d >= 0) f.push(`L${d}:${toks[a - d]!.l}`, `Lb:${toks[a - d]!.l}`);
        if (b - 1 + d < toks.length) f.push(`R${d}:${toks[b - 1 + d]!.l}`, `Rb:${toks[b - 1 + d]!.l}`);
      }
      f.push(`sent:${Math.min(toks[a]!.s, 4)}`, `title:${py(toks[a]!.s === 0)}`);
    }
    if (kind === "date") {
      const dm = m as DateMention;
      f.push(`form:${dm.form}`, `range:${dm.range}`);
      const delta = daysBetween(dated, dm.day);
      const v = Math.trunc(Math.sign(delta) * Math.log1p(Math.abs(delta)));
      f.push(`delta:${Math.max(-3, Math.min(3, v))}`);
      f.push(`same:${read.dates.filter((x) => x.day === dm.day).length}`);
    } else {
      const am = m as AmountMention;
      f.push(`unit:${am.unit}`, `mag:${Math.trunc(Math.log10(Math.max(1, am.value)))}`);
    }
    return f;
  }
}

function softmax(x: Float64Array): number[] {
  let m = -Infinity;
  for (const v of x) m = Math.max(m, v);
  const e = [...x].map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}
const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
/** The first index of the largest value from `from` on. */
function argmax(x: ArrayLike<number>, from: number): number {
  let best = from;
  for (let i = from + 1; i < x.length; i++) if (x[i]! > x[best]!) best = i;
  return best;
}

/** Tokens joined as written: no space before closing punctuation or after an opening one or a currency sign. */
export function joinTokens(ws: string[]): string {
  let out = "";
  for (const w of ws) {
    if (out && !/^[.,;:!?)\]'’%]/.test(w) && !/[([£$€]$/.test(out)) out += " ";
    out += w;
  }
  return out;
}

let shared: MicroCardNet | null | undefined;

/**
 * The process's network, read from `path` (default the shipped file) on first use and shared after; null when it
 * cannot be read (no file, a bad one): the card model's cards stand (fail open), and it is not read again.
 */
export function microCardNet(path = MICRO_CARDS_PATH): MicroCardNet | null {
  if (shared !== undefined && path === MICRO_CARDS_PATH) return shared;
  let net: MicroCardNet | null;
  try {
    net = new MicroCardNet(readFileSync(path));
  } catch {
    net = null;
  }
  if (path === MICRO_CARDS_PATH) shared = net;
  return net;
}

/**
 * The micro card of an item: the item as the card prompt reads it (`ownText`, its date), resolved against
 * its own date or `today`, through the network.
 */
export function microCardOf(net: MicroCardNet, item: ContextItem, today: string): Card {
  const dated = datedOf(item) || today;
  const read = readText(item.title, ownText(item), Date.parse(`${dated}T12:00:00Z`));
  const card = net.card(read, dated, item.sourceId);
  // Spans of the item's own (already redacted) text; redacted again as any card text is.
  card.entities = card.entities.map((e) => sanitizeForStore(e));
  card.statement = sanitizeForStore(card.statement);
  return card;
}
