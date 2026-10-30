/**
 * Probes: the checks a request implies but does not ask for (docs/research/probes.md). A request to act ("set up
 * dinner with Jamie on Thursday at 19:00", "send Rose the Q3 report") is sent to sources as it is, and as a few short,
 * targeted queries besides:
 *
 * - its people, cleaned of the verb that starts the sentence ("Send Rose Kimura" is Rose Kimura);
 * - the organisation each person belongs to, read from the results for that person (an address at
 *   umbrellahealth.com and the name "Umbrella Health" in the same results): what is said about their organisation
 *   applies to them;
 * - its topic, the content words that are neither people, days nor the action;
 * - for an action on a named day (scheduling, accepting, booking), a listing of that day from sources that list by
 *   time: what is already there is what the action might clash with.
 *
 * And it adds a structural ground for delivery with no model: an event close to the time a scheduling request names,
 * on the day it names (a clash). Their finds get seats among the judge's candidates.
 * Nothing here calls a model; every probe is a source call, bounded per lookup (`probeCalls`).
 */
import type { ContextItem } from "@eden/protocol";

/**
 * Words that start a request without naming anything: imperatives and politeness. A capitalised run at a sentence
 * start keeps them ("Send Rose Kimura", "Ask Łukasz"); without them the run is the name.
 */
export const LEADING = new Set(
  (
    "please pls can could would will ask tell send email e-mail message text ping remind reply respond forward share " +
    "book schedule set arrange organise organize plan invite accept decline cancel move reschedule push offer order " +
    "buy get pay sign approve draft write call meet put add find check confirm give let make help chase follow " +
    "introduce update notify loop thank congratulate wish hi hey ok okay so and also then"
  ).split(" "),
);

/** A request's people as they would appear in a source: no leading imperative, no possessive. */
export function cleanEntities(entities: string[]): string[] {
  const out: string[] = [];
  for (const e of entities) {
    let words = e.trim().split(/\s+/);
    while (words.length > 1 && LEADING.has(words[0]!.toLowerCase())) words = words.slice(1);
    const v = words.join(" ").replace(/['’]s$/i, "");
    if (v.length > 1 && !LEADING.has(v.toLowerCase()) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** A request to do something: it starts with an imperative or a polite ask ("Send …", "Can you book …"). */
export const isAction = (raw: string) =>
  LEADING.has(
    raw
      .trim()
      .split(/\s+/)[0]!
      .toLowerCase()
      .replace(/[^a-z-]/g, ""),
  ) || isScheduling(raw);

/** Words that open a request without being its verb: a courtesy, an aside, a "can you". */
const OPENERS = new Set("please pls can could would will you hi hey ok okay so and also then".split(" "));

/**
 * A request in the imperative: its first word other than an opener (`OPENERS`) is a verb that acts ("Book a table…",
 * "Please give Dana access…", "can you send…"). Stricter than `isAction`, which also takes a scheduling word anywhere
 * ("a great book on negotiation"). Reads at most the first eight words.
 */
export function isImperative(raw: string): boolean {
  for (const w of raw.trim().split(/\s+/, 8)) {
    const word = w.toLowerCase().replace(/[^a-z-]/g, "");
    if (OPENERS.has(word)) continue;
    return LEADING.has(word);
  }
  return false;
}

/** A request that puts something in the calendar or commits the user's time. */
const SCHEDULING =
  /\b(schedul\w*|set up|setup|arrange|organi[sz]e|book|invite|accept|put .* (diary|calendar)|block|hold|meet(ing)?|dinner|lunch|breakfast|coffee|drinks|call|workshop|session|1:1|appointment|visit|trip|flight|travel)\b/i;
export const isScheduling = (raw: string) => SCHEDULING.test(raw);

/**
 * The time of day a request names, as a range in minutes from midnight: "at 19:00", "7pm", "10:00", "8am" are that
 * time ±3 h (an event's end is rarely known: a 07:10 flight clashes with a 10:00 workshop); "morning", "afternoon",
 * "evening", "night" their part of the day. Null when it names none.
 */
export function requestedRange(raw: string): { from: number; to: number } | null {
  const t = raw.toLowerCase();
  const m =
    /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t) ?? /\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t);
  if (m) {
    let h = Number(m[1]) % 24;
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    const at = h * 60 + Number(m[2] ?? 0);
    return { from: at - 180, to: at + 180 };
  }
  if (/\bmorning\b/.test(t)) return { from: 6 * 60, to: 12 * 60 };
  if (/\bafternoon\b/.test(t)) return { from: 12 * 60, to: 18 * 60 };
  if (/\b(evening|tonight|night)\b/.test(t)) return { from: 17 * 60, to: 23 * 60 + 59 };
  return null;
}

/**
 * The time a request asks to fill, in minutes from midnight: a range it states ("3–5pm", "15:00-17:00", "from 2 to
 * 4pm") as it is, a single time ("dinner at 19:00") as the 90 minutes from it, a part of the day as that part. Null
 * when it names no time. A clash is an event overlapping this (`overlaps`), not one merely near it.
 */
export function requestedSpan(raw: string): { from: number; to: number } | null {
  // Whitespace collapsed first, and a request's head is where its time is: the patterns below then never rescan a
  // long run (a digit before thousands of spaces was quadratic).
  const t = raw.slice(0, 2_000).toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ");
  const clock = (h: string, m: string | undefined, half: string | undefined) => {
    let hour = Number(h) % 24;
    if (half === "pm" && hour < 12) hour += 12;
    if (half === "am" && hour === 12) hour = 0;
    return hour * 60 + Number(m ?? 0);
  };
  // A stated range, the first one that is a time ("6-9 nov" is a date): a meridiem written once ("3-5pm") holds for
  // both ends, unless that would start it after it ends ("11-1pm" is 11 in the morning to 1).
  for (const r of t.matchAll(
    /\b(?:from |between )?(\d{1,2})(?::(\d{2}))? ?(am|pm)? ?(?:-|to|and|until) ?(\d{1,2})(?::(\d{2}))? ?(am|pm)?\b/g,
  )) {
    if (!(r[3] || r[6] || r[2] || r[5])) continue;
    let from = clock(r[1]!, r[2], r[3] ?? r[6]);
    const to = clock(r[4]!, r[5], r[6] ?? r[3]);
    if (!r[3] && r[6] === "pm" && from >= to) from = clock(r[1]!, r[2], "am");
    if (to > from && to - from <= 12 * 60) return { from, to };
  }
  const one =
    /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t) ?? /\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t);
  if (one) {
    const at = clock(one[1]!, one[2], one[3]);
    return { from: at, to: at + 90 };
  }
  // A bare hour after "at" ("the barbecue at 1", "dinner at 7"): one to seven is the afternoon or evening.
  const bare = /\bat\s+(\d{1,2})\b(?![:.\d%])/.exec(t);
  if (bare && Number(bare[1]) >= 1 && Number(bare[1]) <= 12) {
    const h = Number(bare[1]);
    const at = (h <= 7 ? h + 12 : h) * 60;
    return { from: at, to: at + 90 };
  }
  if (/\bmorning\b/.test(t)) return { from: 6 * 60, to: 12 * 60 };
  if (/\bafternoon\b/.test(t)) return { from: 12 * 60, to: 18 * 60 };
  if (/\b(evening|tonight|night)\b/.test(t)) return { from: 17 * 60, to: 23 * 60 + 59 };
  return null;
}

/**
 * Minutes from midnight an event ends: the first time its text gives after its start ("10:00–11:30", "departs 07:10,
 * arrives 10:35"), within twelve hours; else an hour after it starts.
 */
export function endMinutes(item: ContextItem, start: number): number {
  for (const m of item.text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
    const t = Number(m[1]) * 60 + Number(m[2]);
    if (t > start && t - start <= 12 * 60) return t;
  }
  return start + 60;
}

/** Whether an event starting at `start` overlaps the span (an hour long when its end is not stated). */
export function overlaps(item: ContextItem, start: number, span: { from: number; to: number }): boolean {
  return start < span.to && endMinutes(item, start) > span.from;
}

/** Verbs of a request about an event that already exists. */
const ABOUT_EXISTING = /\b(confirm|cancel|move|reschedul\w*|push|postpone|remind|attend|still on|what time)\b/i;
/** Verbs of a request that makes something new in the calendar: then no existing event is its subject. */
const MAKES_NEW = /\b(book|schedule|set up|arrange|add|fit in|put in|block|invite|organi[sz]e)\b/i;

/**
 * Whether an event is the thing the request is about rather than something in its way: it shares a distinctive word
 * with the request ("confirm my dentist appointment" and "Dental check-up": the same first four letters, words of
 * five letters or more that are neither scheduling words nor times). Confirming an appointment is not a clash with it.
 */
export function isSubject(item: ContextItem, raw: string): boolean {
  // Only a request about something already in the calendar has one there; "block", "book" or "set up" make a new one.
  if (!ABOUT_EXISTING.test(raw) || MAKES_NEW.test(raw)) return false;
  const stems = (text: string) =>
    new Set(
      (text.toLowerCase().match(/[\p{L}]{5,}/gu) ?? [])
        .filter((w) => !SCHEDULING.test(w) && !TIMEISH.test(w) && !LEADING.has(w))
        .map((w) => w.slice(0, 4)),
    );
  const asked = stems(raw);
  return [...stems(item.title)].some((x) => asked.has(x));
}

/** Minutes from midnight an item starts at, in its own offset; null without a timed `meta.start`. */
export function startMinutes(item: ContextItem): number | null {
  const m = /T(\d{2}):(\d{2})/.exec(item.meta?.start ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Words of a request that carry its topic: not a person's, not a day's, not the action's. "Send Rose Kimura the Q3
 * report" is "q3 report"; "Offer Globex 15% off so we can close their renewal this week" is "15 off close renewal".
 * At most `max` words, in the request's order: an all-words search finds nothing for a longer one.
 */
export function topicOf(terms: string[], entities: string[], max = 2): string {
  const named = new Set(entities.flatMap((e) => e.toLowerCase().split(/\s+/)));
  const out = terms.filter(
    (w) => !named.has(w) && !LEADING.has(w) && !TIMEISH.test(w) && !GENERIC.has(w) && w.length > 1 && !/['’]/.test(w),
  );
  return out.slice(0, max).join(" ");
}

const TIMEISH =
  /^(today|tonight|tomorrow|yesterday|week|weekend|next|this|last|morning|afternoon|evening|night|am|pm|\d{1,2}(:\d\d)?(am|pm)?|(mon|tues|wednes|thurs|fri|satur|sun)day|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|\d{1,2}(st|nd|rd|th))$/;
/** Words too common in requests to search on. */
const GENERIC = new Set("me my our us we you your them their they it its need want like know new".split(" "));

/**
 * The organisations the people of a request belong to, read from items returned for them: an address of theirs at a
 * domain, and a name in the same items whose letters are the domain's label ("Umbrella Health" for
 * umbrellahealth.com). Free-mail domains name no organisation.
 */
export function orgsOf(people: string[], items: ContextItem[]): string[] {
  const out: string[] = [];
  for (const person of people) {
    const words = person.toLowerCase().split(/\s+/);
    const labels = new Set<string>();
    for (const it of items) {
      const hay = `${it.text}\n${it.meta?.people ?? ""}`;
      for (const m of hay.matchAll(/([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)*)?\s*<?([\w.+-]+)@([\w-]+)\.[\w.-]+/g)) {
        const local = m[2]!.toLowerCase();
        const near = (m[1] ?? "").toLowerCase();
        if (!words.every((w) => near.includes(w) || local.includes(w))) continue;
        const label = m[3]!.toLowerCase();
        if (!FREE_MAIL.has(label)) labels.add(label);
      }
    }
    if (labels.size === 0) continue;
    for (const it of items) {
      for (const m of `${it.title}. ${it.text}`.matchAll(/\b([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})\b/g)) {
        const squashed = m[1]!.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (squashed.length >= 4 && labels.has(squashed) && !out.includes(m[1]!)) out.push(m[1]!);
      }
    }
  }
  return out;
}

const FREE_MAIL = new Set(
  "gmail googlemail icloud me mac outlook hotmail live msn yahoo aol proton protonmail hey fastmail gmx yandex".split(
    " ",
  ),
);

/**
 * Phrases saying a matter stands as the user would expect: the plan holds, the issue is closed. Not "already done"
 * ("already paid" changes what to do: do not pay twice), not a return ("back from leave on Monday" says away until
 * then), and not when negated ("not resolved").
 */
const SETTLED =
  /\b(as usual|as planned|as normal|as agreed|as before|no changes?|unchanged|nothing (has )?changed|still (on|valid|in place|the same|going ahead)|all clear|(is|are|now|it's) clear to|good to go|(?:you|we) can go ahead|(?:you're|you are) clear to go ahead|resolved|sorted( out)?)\b/i;
const NEGATED =
  /\b(not|n't|never|no longer|isn't|hasn't|wasn't|yet to be|nothing (?:is|has been|was|got))\s+(\w+\s+)?$/i;

/**
 * Whether an item only confirms that things stand as expected (`SETTLED`, not negated): with no model to judge, such
 * an item is not pushed unasked, since it changes nothing the agent would do (`quietSettled`).
 */
export function settled(item: ContextItem): boolean {
  const text = `${item.title}. ${item.text}`;
  for (const m of text.matchAll(new RegExp(SETTLED.source, "gi"))) {
    if (NEGATED.test(text.slice(Math.max(0, m.index! - 24), m.index!))) continue;
    // Asked, not said: the sentence it is in ends with a question mark ("Is this resolved?").
    const end = text.slice(m.index!).search(/[.!?\n]/);
    if (end >= 0 && text[m.index! + end] === "?") continue;
    return true;
  }
  return false;
}

/** Words saying someone is not there: on leave, away, out of office, unavailable. */
// "Away" only as a person's ("is away", "I'm away", "away on Skye", "away until"); "right away" and "throw away" are
// not.
const ABSENT =
  /\b((?:is|am|are|i'm|im|we're|he's|she's|they're|be|been|being)\s+away|away\s+(?:on|from|until|till|through|for|in|at|between)|on leave|annual leave|parental leave|maternity leave|paternity leave|sick leave|compassionate leave|out of (the )?office|ooo|on holiday|on vacation|off sick|off work|unavailable|not available)\b/i;
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The days an item says someone is away, as ISO dates from and to (inclusive), read from the dates written near its
 * absence words ("away on Skye 6–9 Nov", "on leave from 2 Nov to 6 Nov", "out of office until 9 November", "back on
 * 9 Nov"); the year is the one that puts the date nearest after `now` less two months. Null when the item says no one
 * is away or gives no date for it.
 */
export function absenceSpan(item: ContextItem, now: number): { from: string; to: string } | null {
  const text = `${item.title}. ${item.text}`;
  const m = ABSENT.exec(text);
  if (!m) return null;
  // Dates after the absence words first ("unavailable for calls 20 Nov"), then just before them ("6–9 Nov: away").
  const after = text.slice(m.index, m.index + m[0].length + 120).toLowerCase();
  const before = text.slice(Math.max(0, m.index - 60), m.index + m[0].length).toLowerCase();
  const today = new Date(now).toISOString().slice(0, 10);
  const iso = (day: number, month: string) => {
    const mi = MONTHS.indexOf(month.slice(0, 3));
    if (mi < 0 || day < 1 || day > 31) return null;
    const base = new Date(now);
    for (const year of [base.getUTCFullYear() - 1, base.getUTCFullYear(), base.getUTCFullYear() + 1]) {
      const d = new Date(Date.UTC(year, mi, day));
      if (d.getTime() >= now - 60 * 86_400_000 && d.getTime() <= now + 300 * 86_400_000) {
        return d.toISOString().slice(0, 10);
      }
    }
    return null;
  };
  const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);
  const span = (from: string | null, to: string | null) => (from && to && from <= to ? { from, to } : null);
  const sep = "\\s*(?:-|–|—|to|until|till|through|and)\\s*";
  const read = (near: string): { from: string; to: string } | null => {
    let r: RegExpExecArray | null;
    // "6–9 Nov"
    if ((r = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?${sep}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`).exec(near))) {
      return span(iso(Number(r[1]), r[3]!), iso(Number(r[2]), r[3]!));
    }
    // "2 Nov to 6 Nov", "30 Oct – 2 Nov"
    if (
      (r = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}${sep}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`).exec(
        near,
      ))
    ) {
      return span(iso(Number(r[1]), r[2]!), iso(Number(r[3]), r[4]!));
    }
    // "Nov 6–9"
    if ((r = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?${sep}(\\d{1,2})\\b`).exec(near))) {
      return span(iso(Number(r[2]), r[1]!), iso(Number(r[3]), r[1]!));
    }
    // "until 9 November", "back on 9 Nov" (away until the day before)
    if (
      (r = new RegExp(
        `\\b(until|till|through|thru|back(?: on)?|returning(?: on)?)\\s+(?:\\w+day,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`,
      ).exec(near))
    ) {
      const d = iso(Number(r[2]), r[3]!);
      return d ? span(today, r[1]!.startsWith("back") || r[1]!.startsWith("return") ? dayBefore(d) : d) : null;
    }
    // One date: that day.
    if ((r = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`).exec(near))) {
      const d = iso(Number(r[1]), r[2]!);
      return span(d, d);
    }
    return null;
  };
  return read(after) ?? read(before);
}

/** Whether a request's person (a name of one or more words) is named in an item, whole words, any case. */
export function mentions(name: string, item: ContextItem): boolean {
  const hay = ` ${`${item.title} ${item.text} ${item.meta?.people ?? ""}`.toLowerCase().replace(/[^\p{L}\p{N}@.]+/gu, " ")} `;
  const words = name
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  return words.length > 0 && words.every((w) => hay.includes(` ${w} `));
}

/**
 * Words that name someone by their relation to the user rather than by name ("my manager", "the landlord", "my
 * sister"): a person probe has no name to send, so the word itself is sent (the user's items say "your landlord",
 * "Mum", "the school office").
 */
const ROLES = new Set(
  (
    "manager boss lead director ceo cfo cto founder cofounder colleague team assistant recruiter hr payroll finance " +
    "accounts legal counsel lawyer solicitor accountant landlord letting agent tenant neighbour neighbor nanny " +
    "babysitter cleaner school teacher nursery doctor gp dentist physio therapist vet pharmacy mum mom dad mother " +
    "father sister brother wife husband partner son daughter grandma grandpa aunt uncle cousin parents kids"
  ).split(" "),
);

/** The relation words of a request ("Book a 1:1 with my manager" is ["manager"]), at most `max`, in order. */
export function rolesOf(raw: string, max = 2): string[] {
  const out: string[] = [];
  for (const w of raw.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (ROLES.has(w) && !out.includes(w)) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** The days an item names by day and month ("Fri 6 Nov", "6 November"), as ISO dates: the year nearest `now`. */
export function daysNamed(item: ContextItem, now: number): string[] {
  const out: string[] = [];
  const year = new Date(now).getUTCFullYear();
  for (const m of `${item.title} ${item.text}`
    .toLowerCase()
    .matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`, "g"))) {
    const mi = MONTHS.indexOf(m[2]!.slice(0, 3));
    const day = Number(m[1]);
    if (mi < 0 || day < 1 || day > 31) continue;
    let best = "";
    let gap = Infinity;
    for (const y of [year - 1, year, year + 1]) {
      const t = Date.UTC(y, mi, day);
      if (Math.abs(t - now) < gap) [best, gap] = [new Date(t).toISOString().slice(0, 10), Math.abs(t - now)];
    }
    if (!out.includes(best)) out.push(best);
  }
  return out;
}
