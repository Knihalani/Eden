import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { ItemCache } from "./cache";
import { dayFactsClass, dayFactsOf, DATED_CHARS } from "./day-facts";
import { coversDay, dayKeys } from "./days";

/*
 * D1721: `ItemCache.dated` reads each item's date facts (`day-facts.ts`) where it read the text with `coversDay` and
 * `dayNamer`. The oracle below is those two functions as they stood before (days.ts and settle.ts at main 6e20a0c07,
 * copied), with the scan's own reading of the text; every check compares the facts' answer with it.
 */

const DAY = 86_400_000;
const O_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const O_MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const O_WEEKDAY = String.raw`(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?`;
const O_DATE = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(${O_MONTH})\b|\b(${O_MONTH})\s+(\d{1,2})(?:st|nd|rd|th)?\b`,
  "g",
);
const O_BETWEEN = new RegExp(
  String.raw`^,?(?:\s+\d{4})?\s*(?:[–—→-]|to|until|till|through|thru)\s*(?:${O_WEEKDAY}\.?,?\s+)?$`,
);
const O_UNTIL = new RegExp(
  String.raw`\b(?:until|till|through|thru|up to|to)\s+(?:at least\s+)?(?:and including\s+)?(?:${O_WEEKDAY}\.?,?\s+)?(?:the\s+)?$`,
);
const O_SPAN_HINT = new RegExp(
  String.raw`${O_MONTH}(?:,?\s+\d{4})?\s*(?:[–—→-]|(?:to|until|till|through|thru)\b)` +
    String.raw`|\b(?:until|till|through|thru|up to|to)\s+(?:at least\s+)?(?:and including\s+)?(?:${O_WEEKDAY}\.?,?\s+)?(?:the\s+)?\d{1,2}\b`,
);

function oDatesOf(lower: string) {
  const out: { key: number; at: number; end: number }[] = [];
  for (const m of lower.matchAll(O_DATE)) {
    const day = Number(m[1] ?? m[4]);
    const month = O_MONTHS.indexOf((m[2] ?? m[3])!.slice(0, 3));
    if (month < 0 || day < 1 || day > 31) continue;
    out.push({ key: month * 32 + day, at: m.index!, end: m.index! + m[0].length });
    if (out.length >= 24) break;
  }
  return out;
}

function oAhead(a: number, b: number): number {
  const at = (k: number) => Date.UTC(2027, k >> 5, k & 31);
  const d = Math.round((at(b) - at(a)) / DAY);
  return d < 0 ? d + 365 : d;
}

function oracleCovers(text: string, days: ReadonlySet<string>, updatedAt?: number): boolean {
  if (days.size === 0 || !/\d/.test(text)) return false;
  const lower = text.slice(0, 4000).toLowerCase();
  if (!O_SPAN_HINT.test(lower)) return false;
  const dates = oDatesOf(lower);
  if (dates.length === 0) return false;
  const want: number[] = [];
  for (const d of days) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d);
    if (m) want.push((Number(m[1]) - 1) * 32 + Number(m[2]));
  }
  const inside = (from: number, to: number) => {
    const len = oAhead(from, to);
    if (len < 1 || len > 62) return false;
    return want.some((w) => {
      const off = oAhead(from, w);
      return off > 0 && off < len;
    });
  };
  for (let i = 0; i + 1 < dates.length; i++) {
    const a = dates[i]!;
    const b = dates[i + 1]!;
    if (b.at - a.end <= 24 && O_BETWEEN.test(lower.slice(a.end, b.at)) && inside(a.key, b.key)) return true;
  }
  const near =
    updatedAt !== undefined &&
    Number.isFinite(updatedAt) &&
    [...days].some((d) => {
      const gap = Date.parse(d) - updatedAt;
      return gap > -DAY && gap <= 63 * DAY;
    });
  if (near) {
    const u = new Date(updatedAt!);
    const from = u.getUTCMonth() * 32 + u.getUTCDate();
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i]!;
      if (i > 0 && d.at - dates[i - 1]!.end <= 24 && O_BETWEEN.test(lower.slice(dates[i - 1]!.end, d.at))) continue;
      if (O_UNTIL.test(lower.slice(Math.max(0, d.at - 40), d.at)) && inside(from, d.key)) return true;
    }
  }
  return false;
}

const O_ORDINAL = (d: number) =>
  d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th";

function oDayPattern({ day, month }: { day: number; month: number }): RegExp {
  const name = String.raw`${O_MONTHS[month]!}[a-z]*`;
  const dd = String(day).padStart(2, "0");
  const mm = String(month + 1).padStart(2, "0");
  return new RegExp(
    String.raw`\b${day}(?:st|nd|rd|th)?(?:\s+of)?\s+${name}\b|\b${name}\s+${day}(?:st|nd|rd|th)?\b|\b${day}${O_ORDINAL(day)}\b|\b0?${day}/${mm}\b|\b${dd}\.${mm}\b`,
  );
}

/** The old scan's class for one item: 1 spans a day, 2 names one, -1 neither. */
function oracleClass(title: string, body: string, days: ReadonlySet<string>, updatedAt?: number): number {
  const named: { day: number; month: number }[] = [];
  for (const d of days) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d);
    if (m) named.push({ day: Number(m[2]), month: Number(m[1]) - 1 });
  }
  const res = named.map(oDayPattern);
  const text = `${title}\n${body}`.slice(0, 4000).toLowerCase();
  if (!/\d/.test(text)) return -1;
  return oracleCovers(text, days, updatedAt) ? 1 : res.some((re) => re.test(text)) ? 2 : -1;
}

const factsClass = (title: string, body: string, days: ReadonlySet<string>, updatedAt?: number) =>
  dayFactsClass(dayFactsOf(title, body), days, dayKeys(days), updatedAt);

/** A small seeded generator (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text dense in date-like tokens, near-misses and the joints the regexes read (boundaries, suffixes, separators). */
function fuzzText(r: () => number): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const MON = [
    "jan",
    "January",
    "feb",
    "Feb.",
    "mar",
    "March",
    "marketing",
    "apr",
    "april",
    "may",
    "Mayor",
    "jun",
    "june",
    "jul",
    "July",
    "aug",
    "August",
    "sep",
    "sept",
    "September",
    "oct",
    "October",
    "octopus",
    "nov",
    "Nov",
    "dec",
    "December",
    "decide",
    "janx",
    "mai",
    "noviembre",
  ];
  const WD = ["mon", "Monday", "tue", "Tues", "wed", "Wednesday", "thu", "thurs", "fri", "Friday", "sat", "sun"];
  const SEP = [
    " ",
    "  ",
    "\n",
    ", ",
    ". ",
    "; ",
    "–",
    " – ",
    "-",
    " - ",
    "—",
    " → ",
    " to ",
    " until ",
    " till ",
    " through ",
    " thru ",
    " up to ",
    " until at least ",
    " and including ",
    "/",
    ".",
    "_",
    "x",
    ":",
    "(",
    ")",
    "é",
    "İ",
    "’",
    " the ",
    " of ",
    " on ",
    " by ",
    " from ",
    "\t",
  ];
  const num = () => {
    const n = Math.floor(r() * 40);
    const s = r() < 0.15 ? String(n).padStart(2, "0") : r() < 0.03 ? `0${String(n).padStart(2, "0")}` : String(n);
    return r() < 0.3 ? s + pick(["st", "nd", "rd", "th", "TH", "st", "x", ""]) : s;
  };
  const token = () => {
    const k = r();
    if (k < 0.3) return num();
    if (k < 0.5) return pick(MON);
    if (k < 0.58) return pick(WD);
    if (k < 0.68) return `${num()}/${String(1 + Math.floor(r() * 13)).padStart(r() < 0.8 ? 2 : 1, "0")}`;
    if (k < 0.74)
      return `${String(Math.floor(r() * 35)).padStart(2, "0")}.${String(Math.floor(r() * 14)).padStart(2, "0")}`;
    if (k < 0.78) return String(2020 + Math.floor(r() * 10));
    if (k < 0.82)
      return `${num()}/${String(1 + Math.floor(r() * 12)).padStart(2, "0")}/${String(Math.floor(r() * 13)).padStart(2, "0")}`;
    return pick(["closed", "away", "Out", "of", "office", "until", "the", "and", "suspended", "a", "at", "noon"]);
  };
  const n = 1 + Math.floor(r() * 24);
  let out = "";
  for (let i = 0; i < n; i++) out += token() + (r() < 0.85 ? pick(SEP) : "");
  return out;
}

/** A closed range or an open "until" around `at` (ms), in the forms `coversDay` reads and some it does not. */
function spanNear(r: () => number, at: number): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const date = (ms: number) => {
    const d = new Date(ms);
    const mon = O_MONTHS[d.getUTCMonth()]!;
    const name = r() < 0.5 ? mon : `${mon[0]!.toUpperCase()}${mon.slice(1)}${pick(["", "ember", "uary", "il", "."])}`;
    return r() < 0.6 ? `${d.getUTCDate()}${pick(["", "", "th", "st"])} ${name}` : `${name} ${d.getUTCDate()}`;
  };
  const from = at - Math.floor(r() * 70 - 5) * DAY;
  const to = from + Math.floor(r() * 70 - 3) * DAY;
  const wd = pick(["", "", "Fri ", "Monday ", "thu. "]);
  const sep = pick([" – ", "–", " - ", " to ", " until ", " → ", " through ", ", 2026 – ", " and ", "  to   "]);
  if (r() < 0.6) return `${wd}${date(from)}${sep}${wd}${date(to)}`;
  return `${pick(["until", "till", "up to", "to", "through", "until at least", "closed"])} ${wd}${date(to)}`;
}

/** 1-3 days, valid calendar days in 2026 (what a time window gives). */
function fuzzDays(r: () => number): Set<string> {
  const out = new Set<string>();
  const n = 1 + Math.floor(r() * 3);
  const start = Date.UTC(2026, 0, 1) + Math.floor(r() * 365) * DAY;
  for (let i = 0; i < n; i++) out.add(new Date(start + Math.floor(r() * 5) * DAY).toISOString().slice(0, 10));
  return out;
}

describe("day facts (D1721): the scan's class, against the old functions", () => {
  test("the examples days.test.ts and ask-nudge.test.ts hold", () => {
    const cases: [string, string, number | undefined][] = [
      ["Jury service Mon 26 Oct – Fri 6 Nov", "2026-10-30", undefined],
      ["Mon 26 Oct – Fri 6 Nov", "2026-11-06", undefined],
      ["Doxycycline 100mg: 26 Oct → 8 Nov", "2026-11-02", undefined],
      ["Pool closed until Monday 2 November", "2026-10-31", Date.UTC(2026, 9, 25)],
      ["Pool closed until Monday 2 November", "2026-10-31", undefined],
      ["closed 20 Dec – 5 Jan", "2026-12-28", undefined],
      ["away Fri 30th", "2026-10-30", undefined],
      ["due 30/10", "2026-10-30", undefined],
      ["due 31/10", "2026-10-30", undefined],
      ["due 30.10", "2026-10-30", undefined],
      ["5/03/04", "2026-04-03", undefined],
      ["010/11", "2026-11-10", undefined],
      ["the 3rd party vendor", "2026-11-03", undefined],
      ["no dates here", "2026-10-30", undefined],
    ];
    for (const [text, day, at] of cases) {
      const days = new Set([day]);
      expect([text, factsClass("t", text, days, at)]).toEqual([text, oracleClass("t", text, days, at)]);
    }
    expect(factsClass("", "Mon 26 Oct – Fri 6 Nov", new Set(["2026-10-30"]))).toBe(1);
    expect(factsClass("", "due 30/10", new Set(["2026-10-30"]))).toBe(2);
    expect(factsClass("", "5/03/04", new Set(["2026-04-03"]))).toBe(2);
  });

  test("fuzz: 40,000 texts, the same class as the old scan", () => {
    const r = rng(1721);
    let ones = 0;
    let twos = 0;
    for (let i = 0; i < 40_000; i++) {
      const title = r() < 0.3 ? fuzzText(r) : "Note";
      const days = fuzzDays(r);
      const first = Date.parse([...days][0]!);
      // Half the texts hold a span or an "until" near the asked day, so the span reading is exercised too.
      const body = r() < 0.5 ? fuzzText(r) : `${fuzzText(r)} ${spanNear(r, first)} ${fuzzText(r)}`;
      const at = r() < 0.2 ? undefined : r() < 0.05 ? Number.NaN : first - Math.floor(r() * 80 - 5) * DAY;
      const want = oracleClass(title, body, days, at);
      const got = factsClass(title, body, days, at);
      if (got !== want) throw new Error(`differs on ${JSON.stringify({ title, body, days: [...days], at })}`);
      if (want === 1) ones++;
      if (want === 2) twos++;
    }
    // The fuzz reaches both kinds of match, not only "no date".
    expect(ones).toBeGreaterThan(1_500);
    expect(twos).toBeGreaterThan(1_000);
  });

  test("fuzz: every day of the year against texts naming it many ways", () => {
    const r = rng(42);
    for (let k = 0; k < 365; k++) {
      const d = new Date(Date.UTC(2026, 0, 1) + k * DAY);
      const day = d.getUTCDate();
      const m = d.getUTCMonth();
      const mon = O_MONTHS[m]!;
      const mm = String(m + 1).padStart(2, "0");
      const forms = [
        `${day} ${mon}`,
        `${mon} ${day}th`,
        `${day}${O_ORDINAL(day)}`,
        `${day}/${mm}`,
        `0${day}/${mm}`,
        `${String(day).padStart(2, "0")}.${mm}`,
        `${day} of ${mon}ember`,
        `until ${mon} ${day}`,
        `${mon} ${day} – ${day} ${O_MONTHS[(m + 1) % 12]}`,
      ];
      const days = new Set([d.toISOString().slice(0, 10)]);
      for (const f of forms) {
        const text = `${fuzzText(r)} ${f} ${fuzzText(r)}`;
        const at = d.getTime() - Math.floor(r() * 30) * DAY;
        expect([text, factsClass("x", text, days, at)]).toEqual([text, oracleClass("x", text, days, at)]);
      }
    }
  });

  test("only the first DATED_CHARS characters are read, as before", () => {
    const pad = "a".repeat(DATED_CHARS);
    const days = new Set(["2026-10-30"]);
    expect(factsClass("t", `${pad} 30 Oct`, days)).toBe(-1);
    expect(factsClass("t", `${pad.slice(10)} 30 Oct`, days)).toBe(2);
    // A character that lower-cases to two ("İ") moves the cut as it did.
    const wide = `${"İ".repeat(DATED_CHARS - 20)} 30 Oct and on`;
    expect(factsClass("t", wide, days)).toBe(oracleClass("t", wide, days));
  });

  test("the number form holds a text with no span and at most two named days; the rest take an array", () => {
    expect(dayFactsOf("t", "no digits")).toBe(0);
    expect(typeof dayFactsOf("t", "Sent 30 Oct 2026, the 5th")).toBe("number");
    expect(typeof dayFactsOf("t", "30 Oct, 2 Nov and 4 Dec")).toBe("object");
    expect(typeof dayFactsOf("t", "Mon 26 Oct – Fri 6 Nov")).toBe("object");
  });
});

describe("day facts on the cache's entries (D1721)", () => {
  const NOW = Date.UTC(2026, 9, 28, 9);
  const item = (id: string, text: string, updatedAt = NOW - DAY): ContextItem => ({
    id,
    sourceId: "mail",
    ref: id,
    title: `Note ${id}`,
    text,
    updatedAt,
  });
  const scope = { tenantId: "t", userId: "u1" };
  const days = new Set(["2026-10-30"]);
  const ids = (cache: ItemCache, s = scope) => cache.dated(s, days, () => false, NOW, 5, 0).map((h) => h.item.id);

  test("an item whose words change is read again; a copy with the same words keeps its facts", () => {
    const cache = new ItemCache();
    cache.put(
      scope,
      [item("a", "Lift out of service 26 Oct – 6 Nov".padEnd(400, ".")), item("b", "see you 30 Oct")],
      NOW,
    );
    expect(ids(cache)).toEqual(["a", "b"]);
    cache.put(scope, [item("a", "Lift back in service on 2 Nov".padEnd(400, "."))], NOW);
    expect(ids(cache)).toEqual(["b"]);
    // Same words, a newer copy: still found, now first among the named (newest first).
    cache.put(scope, [item("b", "see you 30 Oct", NOW)], NOW);
    cache.put(scope, [item("c", "the 30th works", NOW - 2 * DAY)], NOW);
    expect(ids(cache)).toEqual(["b", "c"]);
  });

  test("a frozen and thawed user (warm and compact) answers as before", () => {
    for (const warm of [true, false]) {
      const cache = new ItemCache(warm ? {} : { warmIdleMs: 0 });
      const items = [
        item("a", "Lift out of service 26 Oct – 6 Nov".padEnd(400, ".")),
        item("b", "see you 30 Oct"),
        item("c", "closed until Monday 2 November", NOW - 3 * DAY),
        item("d", "nothing on that day"),
      ];
      cache.put(scope, items, NOW);
      const live = ids(cache);
      for (let i = 0; i < 40 && cache.frozenCount === 0; i++) cache.expireIdle(NOW);
      expect(cache.frozenCount).toBe(1);
      expect(ids(cache)).toEqual(live);
      expect(live).toEqual(["a", "c", "b"]);
    }
  });

  test("isolation: facts are per user's entry; the same id with other words elsewhere reads its own", () => {
    const cache = new ItemCache();
    const other = { tenantId: "t2", userId: "u1" };
    cache.put(scope, [item("a", "see you 30 Oct")], NOW);
    cache.put(other, [item("a", "see you 31 Oct")], NOW);
    expect(ids(cache)).toEqual(["a"]);
    expect(ids(cache, other)).toEqual([]);
    expect(ids(cache, { tenantId: "t", userId: "u2" })).toEqual([]);
  });
});
