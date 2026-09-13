/**
 * CLS text primitives — tokenisation, light stemming, entity / time features and
 * relative-time grounding shared by the episodic and semantic stores.
 */

export const STOP = new Set(
  "the of is a an on to and in for this that with from into about these then still has out how what why was are you your its our not or no hey hi hello yeah yes ok okay thanks thank do does did be been being it it's i'm i've i'd i'll we've we're they're he's she's am were will would could should can just so very really too also there here their them they he she him her his my me we us at by as if than but".split(
    " ",
  ),
);

export const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_IDX = new Map<string, number>(MONTHS.flatMap((m, i) => [[m, i], [m.slice(0, 3), i]] as [string, number][]));
MONTH_IDX.set("sept", 8);

export function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+(?:[.'\-][a-z0-9]+)*/g) ?? [];
}

/** Conservative stemmer: plural / -ing / -ed / -ly / trailing e. */
export function stem(w0: string): string {
  let w = w0;
  if (w.length < 4 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length >= 6) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length >= 5) w = w.slice(0, -2);
  else if (w.endsWith("ly") && w.length >= 5) w = w.slice(0, -2);
  if (w.length >= 4 && /([bdfglmnprt])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length >= 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

const NUMWORD: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90" };
const CONTRACT: Record<string, string> = { "i'm": "i", "i've": "i", "i'd": "i", "i'll": "i", "don't": "not", "doesn't": "not", "didn't": "not", "can't": "not", "won't": "not", "isn't": "not", "aren't": "not", "wasn't": "not", "haven't": "not", "hasn't": "not" };

/** Content tokens (stemmed, stop-filtered). Numbers survive, number words are numeralised. */
export function contentToks(s: string): string[] {
  const out: string[] = [];
  for (const w0 of words(s)) {
    const w = CONTRACT[w0] ?? w0;
    if (STOP.has(w)) continue;
    const base = w.replace(/'s$/, "");
    if (!base || STOP.has(base)) continue;
    if (NUMWORD[base]) {
      out.push(NUMWORD[base]!);
      continue;
    }
    if (base.length < 2) continue;
    out.push(stem(base));
  }
  return out;
}

export function properNames(s: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[^A-Za-z])((?:Dr|Mr|Mrs|Ms|St)\.?\s+)?([A-Z][a-z]{2,16})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[2]!.toLowerCase());
  return out;
}

/** Codes such as B12 / 2A / INV-1234 / 10.8.0.0/16 — sparse identifiers with high retrieval value. */
export function codeToks(s: string): string[] {
  return (s.match(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{2,12}\b/g) ?? []).map((x) => x.toLowerCase());
}

export type Stamp = { y: number; m: number; d: number } | null;

/** Parse session stamps like "1:56 pm on 8 May, 2023" / "2026-03-02 09:00" / "May 2023". */
export function parseStamp(date: string): Stamp {
  if (!date) return null;
  let m = date.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return { y: +m[1]!, m: +m[2]! - 1, d: +m[3]! };
  m = date.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9}),?\s+(\d{4})\b/);
  if (m && MONTH_IDX.has(m[2]!.toLowerCase())) return { y: +m[3]!, m: MONTH_IDX.get(m[2]!.toLowerCase())!, d: +m[1]! };
  m = date.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (m && MONTH_IDX.has(m[1]!.toLowerCase())) return { y: +m[3]!, m: MONTH_IDX.get(m[1]!.toLowerCase())!, d: +m[2]! };
  m = date.match(/\b([A-Za-z]{3,9}),?\s+(\d{4})\b/);
  if (m && MONTH_IDX.has(m[1]!.toLowerCase())) return { y: +m[2]!, m: MONTH_IDX.get(m[1]!.toLowerCase())!, d: 1 };
  m = date.match(/\b(20\d{2})\b/);
  if (m) return { y: +m[1]!, m: 0, d: 1 };
  return null;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function fmtDMY(st: { y: number; m: number; d: number }): string {
  return `${st.d} ${cap(MONTHS[st.m]!)} ${st.y}`;
}
export function fmtMY(st: { y: number; m: number }): string {
  return `${cap(MONTHS[st.m]!)} ${st.y}`;
}
export function shiftDays(st: { y: number; m: number; d: number }, days: number) {
  const dt = new Date(Date.UTC(st.y, st.m, st.d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
}
export function shiftMonths(st: { y: number; m: number; d: number }, months: number) {
  const total = st.y * 12 + st.m + months;
  return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12, d: st.d };
}

/** Time-bucket features for a stamp: year, month, year-month, day. */
export function stampToks(st: Stamp): string[] {
  if (!st) return [];
  return [`t:y${st.y}`, `t:m${st.m}`, `t:${st.y}-${st.m}`, `t:d${st.d}`];
}

/** Time tokens present in free text (years, month names, weekdays). */
export function textTimeToks(s: string): string[] {
  const out: string[] = [];
  const low = s.toLowerCase();
  for (const y of low.match(/\b20\d{2}\b/g) ?? []) out.push(`t:y${y}`);
  for (const w of low.match(/\b[a-z]{3,9}\b/g) ?? []) {
    if (MONTH_IDX.has(w) && (w.length > 3 || w === "may")) out.push(`t:m${MONTH_IDX.get(w)}`);
  }
  return out;
}

const NUM = "(\\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple of|few)";
function num(s: string): number {
  const x = s.toLowerCase();
  if (x === "a" || x === "an" || x === "one") return 1;
  if (x === "couple of") return 2;
  if (x === "few") return 3;
  return NUMWORD[x] ? +NUMWORD[x]! : +x;
}

/**
 * Relative-time grounding: resolve "last year" / "next month" / "two weeks ago" / "yesterday"
 * against the episode's session stamp and return absolute-date phrases to attach to the episode.
 */
export function groundRelativeTime(text: string, st: Stamp): string[] {
  if (!st) return [];
  const out: string[] = [];
  const low = text.toLowerCase();
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  if (/\byesterday\b/.test(low)) add(`the day before ${fmtDMY(st)}: ${fmtDMY(shiftDays(st, -1))}`);
  if (/\b(tomorrow)\b/.test(low)) add(`the day after ${fmtDMY(st)}: ${fmtDMY(shiftDays(st, 1))}`);
  if (/\b(today|tonight|this morning|this afternoon|this evening|earlier today)\b/.test(low)) add(`on ${fmtDMY(st)}`);
  if (/\b(last|past|previous) (week|few days)\b/.test(low) || /\b(a|one) week ago\b/.test(low)) add(`the week before ${fmtDMY(st)}: ${fmtDMY(shiftDays(st, -7))}`);
  if (/\b(next|coming|following) week\b/.test(low)) add(`the week after ${fmtDMY(st)}: ${fmtDMY(shiftDays(st, 7))}`);
  if (/\b(last|past) weekend\b/.test(low)) add(`the weekend before ${fmtDMY(st)}`);
  if (/\bthis weekend\b/.test(low)) add(`the weekend of ${fmtDMY(st)}`);
  if (/\b(next|coming) weekend\b/.test(low)) add(`the weekend after ${fmtDMY(st)}`);
  if (/\b(last|past|previous) month\b/.test(low) || /\b(a|one) month ago\b/.test(low)) add(`${fmtMY(shiftMonths(st, -1))} (the month before ${fmtMY(st)})`);
  if (/\b(next|coming|following) month\b/.test(low)) add(`${fmtMY(shiftMonths(st, 1))} (the month after ${fmtMY(st)})`);
  if (/\b(last|past|previous) year\b/.test(low) || /\b(a|one) year ago\b/.test(low)) add(`${st.y - 1} (the year before ${st.y})`);
  if (/\b(next|coming|following) year\b/.test(low)) add(`${st.y + 1}`);
  if (/\bthis (year|summer|spring|winter|fall|autumn|month|week|semester|season)\b/.test(low) || /\bearlier this year\b/.test(low)) add(`${fmtMY(st)}`);
  if (/\b(last|past) (summer|spring|winter|fall|autumn|christmas|semester|season)\b/.test(low)) add(`${st.y - 1} or earlier in ${st.y}`);
  if (/\b(next|this coming) (summer|spring|winter|fall|autumn|christmas)\b/.test(low)) add(`${st.y} or ${st.y + 1}`);
  let m: RegExpExecArray | null;
  const ago = new RegExp(`\\b${NUM} (day|days|week|weeks|month|months|year|years)\\s+(?:ago|back|earlier|before)\\b`, "g");
  while ((m = ago.exec(low))) {
    const n = num(m[1]!);
    const u = m[2]!;
    if (!Number.isFinite(n)) continue;
    if (u.startsWith("day")) add(`${n} day${n > 1 ? "s" : ""} before ${fmtDMY(st)}: ${fmtDMY(shiftDays(st, -n))}`);
    else if (u.startsWith("week")) add(`${n} week${n > 1 ? "s" : ""} before ${fmtDMY(st)}: ${fmtDMY(shiftDays(st, -7 * n))}`);
    else if (u.startsWith("month")) add(`${fmtMY(shiftMonths(st, -n))} (${n} month${n > 1 ? "s" : ""} before ${fmtMY(st)})`);
    else add(`${st.y - n} (${n} year${n > 1 ? "s" : ""} before ${st.y})`);
  }
  const inN = new RegExp(`\\bin ${NUM} (day|days|week|weeks|month|months|year|years)\\b`, "g");
  while ((m = inN.exec(low))) {
    const n = num(m[1]!);
    const u = m[2]!;
    if (!Number.isFinite(n)) continue;
    if (u.startsWith("day")) add(`${fmtDMY(shiftDays(st, n))}`);
    else if (u.startsWith("week")) add(`${fmtDMY(shiftDays(st, 7 * n))} (${n} week${n > 1 ? "s" : ""} after ${fmtDMY(st)})`);
    else if (u.startsWith("month")) add(`${fmtMY(shiftMonths(st, n))}`);
    else add(`${st.y + n}`);
  }
  // "on Monday" / "next Friday" / "last Sunday" around the stamp.
  const wd = /\b(last|next|this|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g;
  while ((m = wd.exec(low))) {
    const which = m[1]!;
    const day = m[2]!;
    add(which === "last" ? `the ${cap(day)} before ${fmtDMY(st)}` : which === "next" ? `the ${cap(day)} after ${fmtDMY(st)}` : `${cap(day)} around ${fmtDMY(st)}`);
  }
  // Bare month names in text: attach the stamp's year so "in June" reads "June 2023".
  const monthOnly = /\b(january|february|march|april|june|july|august|september|october|november|december)\b(?!,?\s+20\d{2})/g;
  while ((m = monthOnly.exec(low))) {
    const mi = MONTH_IDX.get(m[1]!)!;
    add(`${cap(m[1]!)} ${mi <= st.m + 1 ? st.y : st.y}`);
  }
  return out.slice(0, 4);
}
