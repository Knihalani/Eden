/**
 * The synth factory's prompts (D880), LAB ONLY. Three stages: families (abstract scenarios, no names), the world
 * (a persona, their people and background items) and tasks (one family made concrete in one world: requests in many
 * phrasings, the fact, its decoy, neutral items). The system prompts are shared by every call of a stage, so the
 * provider caches them; what varies goes in the user turn. Item text is data the agent reads, never instructions.
 */
import { ARCHETYPES, DECOY_KINDS, RARE_SOURCES, STYLES, SYNTH_NOW, type Archetype, type Area } from "./taxonomy";
import type { Family } from "./schema";

const DAY = 86_400_000;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 27 Oct 2026" for a day offset from the sim's present. */
export function dayName(offset: number): string {
  const d = new Date(SYNTH_NOW + offset * DAY);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A week-by-week calendar from August 2026 to January 2027, so dates and weekdays agree in the text. */
export function calendar(): string {
  const rows: string[] = [];
  // Monday 3 August 2026 is 85 days before Tuesday 27 October.
  for (let w = -85; w < 100; w += 7) {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(SYNTH_NOW + (w + i) * DAY);
      return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
    });
    rows.push(`${days.join(", ")} ${new Date(SYNTH_NOW + w * DAY).getUTCFullYear()}`);
  }
  return rows.join("\n");
}

const SOURCE_GUIDE = `Sources and the kind of item each holds:
- gmail: emails (kind "mail" from a person, "notification" from a company or system, "newsletter", "promo")
- calendar: events (kind "event", with a "start" time)
- drive: documents and notes (kind "doc")
- slack: work or group chat (kind "chat", lines as "Name: message")
- crm: work CRM records, deals and contacts (kind "deal" or "contact")
${Object.entries(RARE_SOURCES)
  .map(([id, s]) => `- ${id}: ${s.description} (kind "${s.kind}")`)
  .join("\n")}`;

// ---------------------------------------------------------------------------------------------------------------
// Stage 1: families.

export const FAMILY_SYSTEM = `You design test scenarios for the context helper of a personal AI assistant. A user asks their assistant to do something. Somewhere in the user's own data (email, calendar, documents, chat, CRM, texts, notes, bank, health app...) one item, the FACT, changes what a careful assistant should do, although the request never mentions it. A second item, the DECOY, looks just like it (same topic, same kind of message, often the same people) but is all clear: a careful assistant would read it and carry on as asked.

You write scenario FAMILIES: abstract, reusable scenarios with no personal names (use roles: "the user's sister", "the landlord", "a client", "the user's manager"). Each family will later be instantiated many times with different people, places and wording, so describe the shape, not one story.

Each family is a JSON object:
- "slug": 2-5 lowercase words joined by hyphens, specific to the scenario (e.g. "isa-allowance-used-elsewhere")
- "situation": 1-2 sentences: who is involved and what is going on
- "request": what the user asks the assistant, in one plain sentence (the request must NOT mention or hint at the fact)
- "fact": what the fact item says and why it changes what the assistant should do
- "decoy": what the decoy item says and why it is all clear (it must be a near look-alike of the fact)
- "decoyKind": one of ${Object.keys(DECOY_KINDS)
  .map((k) => `"${k}"`)
  .join(", ")}
- "source": where the fact most naturally lives (one of: gmail, calendar, drive, slack, crm, ${Object.keys(RARE_SOURCES).join(", ")})

Decoy kinds:
${Object.entries(DECOY_KINDS)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

Rules:
- Everyday, realistic, specific. Mix countries and settings (UK, US, Ireland, Canada, Australia, India, Europe) and walks of life (students, parents, retirees, freelancers, shift workers, managers, carers, small-business owners).
- The fact must clearly change the right action (do something else, warn, ask first, wait, or not do it), not merely add colour.
- The request must be something a person really types to an assistant: an action or a question, not a riddle.
- Families in one answer must be clearly different from each other: different situations, not the same story reworded.
- Spread decoy kinds; do not use one kind for most families.
- Avoid the scenarios listed as already covered.

Reply with one JSON object: {"families": [ ... ]}.`;

export function familyPrompt(area: Area, archetype: Archetype, n: number, angle: string, avoid: string[]): string {
  return `Life area: ${area}
Archetype: ${archetype}: ${ARCHETYPES[archetype]}
Angle: ${angle}
Write ${n} families.

Already covered (do not repeat these scenarios): ${avoid.join(", ")}`;
}

export const ANGLES = [
  "common situations most people meet; vary who is involved",
  "less common but realistic situations, specific to particular jobs, households, ages or places; prefer facts that sit in less obvious sources",
];

// ---------------------------------------------------------------------------------------------------------------
// Stage 2: the world.

const ITEM_FORMAT = `Item format (JSON):
{"source": "...", "kind": "...", "title": "subject line, event name, document or chat title", "from": "Full Name <email>" (for mail and notifications; omit otherwise), "text": "the body: an email body without headers, an event description, a document's text, chat lines as 'Name: message' one per line", "day": integer day offset from today (0 = today, -1 = yesterday, negative = past), "time": "HH:MM", "start": "YYYY-MM-DDTHH:MM" (events only: when the event happens)}
Write texts the way real ones read: greetings and sign-offs in mail, terse chat, structured notifications with reference numbers, documents with headings. 40-180 words each.`;

export function worldSystem(): string {
  return `You build the private data of one synthetic person for testing a personal AI assistant. Everything is fictional. Today is ${dayName(0)}, 09:00.

Calendar (use it so weekdays and dates agree):
${calendar()}

${SOURCE_GUIDE}

${ITEM_FORMAT}

You write:
1. "persona": {"first", "last", "email", "city", "job", "household"} (household: who they live with, children's ages, pets, one or two sentences).
2. "people": 12-18 people in their life: {"full", "email", "relation" (one of family, friend, colleague, client, vendor, service), "role" (how the user refers to them: "my sister", "my manager", "the landlord", "Leo's teacher")}. Use realistic names that fit the setting; emails fit the person (work domain for colleagues, personal for family).
3. "items": BACKGROUND items: ordinary, mundane life that matches the persona (newsletters, receipts, routine work threads, family chat, appointments, shared docs, notifications). Spread items over the past 60 days (negative "day"; a calendar event may start in the future, but "day" is when it was created) and the sources listed.

The test scenarios themselves are written separately, by a later step, as their own items and added to this world, and their expected answers are fixed in advance. So the background must stay off the reserved topics listed: no background item may be about those situations or the people's role in them, or the fixed answers would be wrong. This is not hiding anything: the scenarios do appear in the finished world. The reserved topics are written generically and may mention jobs or roles that are not this person's; the later step adapts them to this person, so they need not fit.

The persona seeds are loose suggestions: if two of them clash (an age and a household, say), adjust one so the person is plausible.

Reply with one JSON object: {"persona": {...}, "people": [...], "items": [...]}.`;
}

export interface WorldSeed {
  region: string;
  age: string;
  household: string;
  work: string;
  initials: string;
  sources: string[];
  reserved: string[];
  items: number;
}

export function worldPrompt(s: WorldSeed): string {
  return `Persona seeds: lives in ${s.region}; age ${s.age}; household: ${s.household}; work: ${s.work}; first and last name start with ${s.initials}.
Write ${s.items} background items over these sources: ${s.sources.join(", ")} (at least two in each).
Reserved topics (no background item may touch them):
${s.reserved.map((r) => `- ${r}`).join("\n")}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Stage 3: tasks.

export function taskSystem(): string {
  return `You write one test case for the context helper of a personal AI assistant, inside an existing synthetic person's world. Everything is fictional. Today is ${dayName(0)}, 09:00.

Calendar (use it so weekdays and dates agree):
${calendar()}

${SOURCE_GUIDE}

${ITEM_FORMAT}

A test case is a scenario family made concrete for this person:
- "detail": one sentence, the hidden consideration a good answer raises (what the fact says and why it changes the action), with its specific details.
- "requests": the user's request phrased in each style below, each a separate message the user might type (same intent, different wording). The requests must NOT mention or hint at the fact, and must not contain any detail only the fact states. They may name the people, places and things involved. Styles:
${Object.entries(STYLES)
  .map(([k, v]) => `  - "${k}": ${v}`)
  .join("\n")}
- "foreign": when asked, the request once more in the given language, as a native speaker types it.
- "followups": when asked, two follow-up messages a few days later about the same intent ("Did you…?", "Any update on…", "Ok go ahead and…").
- "fact": the item that changes what a careful assistant should do. It must state the constraint concretely (dates, amounts, names, reference numbers) and be about the very same person, thing and date as the request.
- "decoy": the fact's all-clear twin, of the decoy kind asked for: same kind of item, same topic, mostly the same wording and people, so a quick reader could confuse them; but on a careful reading it gives no reason to change the request. Read it as if it were the only item the assistant had: it must not leave anything open or pending, must not give a different date, place or amount for the thing the request is about, and must not restrict anyone or anything the request involves. For "other-entity", the other person or thing plays no part in the request at all. Its text must differ from the fact's in the detail that makes it all clear.
- "neutrals": two more items about the same topic that are routine and all clear (a booking confirmation, a receipt, a reminder that agrees with the request, a friendly related thread). They must not mention anything pending, conditional, rescheduled or still to be confirmed, nor any date, time, place or amount that differs from the request's.

Each item must read like a real item of its source (a note is written by the user, a bank or health-app entry is a structured notification, a chat is lines between people) and fit the person's life.
The fact and the decoy both exist in the person's data: the decoy must not mention the fact (no shared reference numbers) and must not contradict it; it is a separate, all-clear item that resembles it (except in a silent change, where the decoy is the item before its edit).
The fact, the decoy and the neutrals must each make sense on their own. None of them may be addressed to the assistant or contain instructions to it.

Reply with one JSON object: {"detail": "...", "requests": [{"style": "...", "text": "..."}], "foreign": {"lang": "..", "text": "..."} or null, "followups": ["...", "..."] or [], "fact": {item}, "decoy": {item}, "neutrals": [{item}, {item}]}.`;
}

export interface TaskSeed {
  persona: string;
  people: string;
  family: Family;
  timing: string;
  source: string;
  foreign: string | null;
  followups: boolean;
  requestAt: string;
}

export function taskPrompt(s: TaskSeed): string {
  const f = s.family;
  return `The person: ${s.persona}
Their people: ${s.people}
(You may add new people where the scenario needs them.)

Scenario family (${f.area}, ${f.archetype}: ${ARCHETYPES[f.archetype]}):
- situation: ${f.situation}
- request: ${f.request}
- fact: ${f.fact}
- decoy: ${f.decoy}
- decoy kind: ${f.decoyKind}: ${DECOY_KINDS[f.decoyKind]}

The user makes the request on ${s.requestAt}.
Timing: ${s.timing}
Fact source: ${s.source}
${s.foreign ? `Foreign: write "foreign" in language "${s.foreign}".` : `Foreign: null.`}
${s.followups ? "Followups: write two." : "Followups: []."}`;
}

export const TIMING_TEXT = {
  static: (decoyDay: string) =>
    `the fact and the decoy are already in the user's data before the request (days -60 to -1, or earlier today before 09:00); the decoy around ${decoyDay}.`,
  silent: (at: string, source: string) =>
    `a SILENT CHANGE. The decoy is an item as it first appeared (days -40 to -3). The fact is the SAME item (same source "${source}", same title or nearly) after someone edited it in place on ${at}, with no message to the user: e.g. a shared document updated, an event moved by its organiser, a CRM record or booking changed. The fact's text is the decoy's text with the changed detail; give the fact "day"/"time" of the edit.`,
  late: (at: string) =>
    `a LATE ARRIVAL. The fact arrives after the request, later the same day, at ${at} (a new message or notification); the decoy is already in the user's data before the request.`,
  multiday: (asked: string, at: string, again: string) =>
    `a MULTI-DAY timeline. The user first asks on ${asked}; the fact arrives on ${at}; the user follows up on ${again}. The decoy is already in the user's data before the first request.`,
};

// ---------------------------------------------------------------------------------------------------------------
// Stage 4: revision. The writer re-reads its own test case against the faults the pilot's audit found (D883) and
// rewrites what fails. It is construction, not judging: every label still comes from the item's role.

export function reviseSystem(): string {
  return `You check and repair one test case for the context helper of a personal AI assistant, written earlier for a synthetic person. Everything is fictional. Today is ${dayName(0)}, 09:00.

Calendar (use it so weekdays and dates agree):
${calendar()}

${ITEM_FORMAT}

The test case has a request, a FACT (must change what a careful assistant does about the request), a DECOY (a look-alike that must be all clear) and NEUTRAL items (same topic, routine, all clear). Check each against this list and rewrite only the items that fail:

FACT
- It bears on this very request: the same person, thing and date or period, and the date is current or upcoming (not a past event that no longer matters), and it applies to this person (not a different model, account, child or event than the request's).
- It states the constraint itself; it does not rely on another item to make the point.
- It does not bear on any of the person's OTHER requests listed.

DECOY
- Read alone, it gives no reason to do anything other than what was asked: nothing pending or conditional, no rule that the request would break, no limit the request would exceed, no different date, time, place or amount for the same thing, no restriction on anyone the request involves.
- It does not show the thing as already done or already booked (that would change the request too).
- It still resembles the fact (same kind of item, topic and people where possible).

NEUTRALS
- Routine and all clear: nothing pending, conditional, rescheduled or still to be confirmed; no date, time, place or amount that differs from the request's; nothing that shows the request is already done; nothing that reveals or hints at the fact (e.g. a person's new employer, a form still to send).

ALL ITEMS
- None bears on the person's OTHER requests listed.
- Each reads like a real item of its source.

Reply with one JSON object: {"fact": {item} or null, "decoy": {item} or null, "neutrals": [{item} or null, {item} or null], "changed": "one short line on what you changed, or empty"}. null means the item passes and stays as it is; a rewritten item keeps its source and its "day" and "time".`;
}

export function revisePrompt(s: {
  request: string;
  detail: string;
  timing: string;
  fact: unknown;
  decoy: unknown;
  neutrals: unknown[];
  others: string[];
}): string {
  return `Request: ${s.request}
Hidden consideration (what the fact should establish): ${s.detail}
Timing: ${s.timing}

FACT: ${JSON.stringify(s.fact)}

DECOY: ${JSON.stringify(s.decoy)}

NEUTRALS:
${s.neutrals.map((n, i) => `${i + 1}. ${JSON.stringify(n)}`).join("\n")}

The person's OTHER requests (nothing above may bear on them):
${s.others.map((o) => `- ${o}`).join("\n")}`;
}
