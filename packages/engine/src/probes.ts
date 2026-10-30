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
const LEADING = new Set(
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
