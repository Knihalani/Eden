/**
 * G2 (M14, D1020): a second synthetic-world generator, written to differ from M2's on purpose. LAB ONLY; nothing in
 * a product package imports it. M2 (synth/gen.ts) asks Haiku for abstract families, then a world, then one call per
 * task, then a revision, and formats every email with the sim's own headers. G2 asks a different writer (Sonnet) for a
 * whole world in one call, with no family stage, its own request styles, and a format pack per world: forwarded
 * email chains with quoting, terse chat, ICS calendar text, CRM field dumps, PDF-extracted documents, app
 * notifications, a whole world in another language, or deliberately short items. Item length is told to carry no
 * information about an item's role (D908: M3's tagger learned that facts are long). The output is M2's SynthWorld
 * schema and its construction labels (`labels.ts`), so every synth tool reads it.
 *
 *   bun packages/sim/src/lab/m14/g2.ts gen --n 400 [--limit K] [--concurrency 12]
 *   bun packages/sim/src/lab/m14/g2.ts assemble        # → <dir>/worlds.jsonl
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rng } from "../../rng";
import { SpendLedger } from "../spend";
import { parseJson, readResult, runDirect, type Job } from "../synth/jobs";
import { calendar, dayName } from "../synth/prompts";
import { validateWorld, type SynthItem, type SynthTask, type SynthWorld } from "../synth/schema";
import {
  AREAS,
  ARCHETYPE_NAMES,
  ARCHETYPES,
  DECOY_KINDS,
  RARE_SOURCES,
  SYNTH_NOW,
  type Archetype,
  type Area,
} from "../synth/taxonomy";

const DAY = 86_400_000;
export const G2_MODEL = "claude-sonnet-5-5";

/** The format packs: each world is written in one, so a held-out pack is a writing style no other world shares. */
export const PACKS = {
  forwarded: {
    sources: ["gmail", "gmail", "calendar", "drive", "slack"],
    brief: `Most items are email threads as they look when copied out of a mail client: replies and forwards with quoted earlier messages ("> " prefixes, "-----Original Message-----", "On Tue, 20 Oct 2026 at 14:02, Name <email> wrote:", "---------- Forwarded message ---------"), signatures, legal disclaimers, "Sent from my iPhone". The deciding detail of a fact may sit in a quoted earlier message, not the newest one. Put From/To/Date/Subject header lines at the top of each email text yourself.`,
  },
  chat: {
    sources: ["slack", "whatsapp", "sms", "slack", "gmail"],
    brief: `Most items are chat logs: lowercase, abbreviations (tmrw, pls, idk, fyi, w/, b4), emoji, typos, people talking over each other, one thought split over several lines, timestamps like "[09:14]" before some lines. A fact may be a single short line in a busy chat; a background chat may be long.`,
  },
  ics: {
    sources: ["calendar", "calendar", "gmail", "tasks", "drive"],
    brief: `Calendar items are written as raw iCalendar text (BEGIN:VEVENT, UID, DTSTART;TZID=..., DTEND, SUMMARY, LOCATION, ORGANIZER;CN=..., ATTENDEE;PARTSTAT=..., STATUS:CONFIRMED|TENTATIVE|CANCELLED, DESCRIPTION with escaped \\n and \\, , END:VEVENT), sometimes with an updated SEQUENCE. Other items are invitation emails and to-do entries with due dates.`,
  },
  crm: {
    sources: ["crm", "crm", "tickets", "gmail", "drive"],
    brief: `Most items are business-system records: CRM deals and contacts as "Field: value" dumps (Stage, Amount, Close date, Owner, Next step, Notes), activity logs with timestamps and initials, issue-tracker tickets (ID, status, assignee, labels, comments). Terse, abbreviated, internal jargon.`,
  },
  pdf: {
    sources: ["drive", "files", "drive", "gmail", "school"],
    brief: `Most items are documents as text extracted from PDFs: hard line breaks in mid-sentence every 60-90 characters, words hyphenated across lines ("appoint-\\nment"), page headers and footers repeated ("Page 2 of 4", a company name), table cells run together, bullet glyphs (•, ▪) and section numbers. Letters, policies, statements, terms and conditions, school letters.`,
  },
  apps: {
    sources: ["bank", "health", "household", "school", "notes"],
    brief: `Most items are app notifications and records: bank transactions and alerts (merchant codes, masked card numbers, balances), health-app entries (appointment slots, prescription status, clinic codes), household-app bills and chores, school-app notices, and the user's own terse notes and lists.`,
  },
  foreign: {
    sources: ["gmail", "whatsapp", "calendar", "drive", "notes"],
    brief: `The whole world is in LANG: every item (titles and texts) and every request, written as a native speaker of LANG writes them, with local formats for dates, money and addresses. The persona lives where LANG is spoken. Do not translate from English; write natively.`,
  },
  short: {
    sources: ["sms", "notes", "slack", "calendar", "gmail"],
    brief: `Items are mostly very short: one or two lines (a text, a calendar title with a time, a note, a one-line email). A few background items are long (a newsletter, minutes, a long thread). Facts and decoys are often short too: a one-line text can change everything.`,
  },
} as const;
export type Pack = keyof typeof PACKS;
const PACK_NAMES = Object.keys(PACKS) as Pack[];
const FOREIGN = ["de", "fr", "es", "it", "pt", "nl"] as const;
/** Regions for English worlds (the pilot put four of eight personas in one city without a seed). */
const REGIONS = [
  "rural Wales",
  "Glasgow",
  "Manchester",
  "south London",
  "Cork",
  "Dublin",
  "Toronto",
  "rural Saskatchewan",
  "Halifax, Nova Scotia",
  "Austin, Texas",
  "rural Ohio",
  "Chicago",
  "Atlanta",
  "Seattle",
  "Phoenix",
  "Boston suburbs",
  "Brisbane",
  "Perth, Australia",
  "Auckland",
  "Wellington",
  "Mumbai",
  "Bengaluru",
  "Singapore",
  "Lagos",
  "Nairobi",
  "Cape Town",
  "Belfast",
  "Cornwall",
  "Norfolk",
  "Edinburgh",
  "Vancouver Island",
  "New Orleans",
  "Minneapolis",
] as const;
const FOREIGN_REGION: Record<string, string> = {
  de: "Germany, Austria or Switzerland",
  fr: "France, Belgium or Quebec",
  es: "Spain, Mexico or Argentina",
  it: "Italy",
  pt: "Portugal or Brazil",
  nl: "the Netherlands or Flanders",
};
const LANG_NAME: Record<string, string> = {
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
};

/** G2's request styles: none of M2's seven, so a model cannot key on M2's phrasings. */
const G2_STYLES = {
  dictated: "voice-dictated: run-on, no punctuation, filler words (um, like, so yeah)",
  typos: "typed fast on a phone: typos, missing apostrophes, no capitals",
  formal: "polite and formal, a full sentence or two (Could you please…, I would like you to…)",
  embedded: "the intent buried in a message about two other unrelated things",
  oneword: "two to five words, no verb or barely one",
} as const;

export interface G2Plan {
  id: string;
  index: number;
  pack: Pack;
  lang: string;
  region: string;
  tasks: { area: Area; archetype: Archetype; decoyKind: string; silent: boolean }[];
}

/** Deterministic in the world's index: the pack cycles, so every pack gets an equal share. */
export function g2Plan(index: number): G2Plan {
  const rng = new Rng(14_000 + index);
  const pack = PACK_NAMES[index % PACK_NAMES.length]!;
  const areas = rng.sample(AREAS, 4);
  const lang = pack === "foreign" ? rng.pick(FOREIGN) : "en";
  return {
    id: `sw-g2-${String(index).padStart(4, "0")}`,
    index,
    pack,
    lang,
    region: lang === "en" ? rng.pick(REGIONS) : FOREIGN_REGION[lang]!,
    tasks: areas.map((area) => ({
      area,
      archetype: rng.pick(ARCHETYPE_NAMES),
      decoyKind: rng.pick(Object.keys(DECOY_KINDS)),
      silent: rng.chance(0.2),
    })),
  };
}

export function g2System(): string {
  return `You write the private data of one fictional person, used to test a context helper that reads a user's data beside their AI assistant. Today is ${dayName(0)}, 09:00.

Calendar (dates and weekdays must agree):
${calendar()}

You write one JSON object:
{"persona": {"first", "last", "email", "city", "job", "household"},
 "people": [6-10 of {"full", "email", "relation", "role"}],
 "background": [8 items],
 "tasks": [one per scenario given]}

An item is {"source", "title", "text", "day" (integer offset from today, negative = past), "time" ("HH:MM"), "start" ("YYYY-MM-DDTHH:MM", calendar items only)}. Sources: gmail, calendar, drive, slack, crm, ${Object.keys(RARE_SOURCES).join(", ")}.

A task is {"detail", "requests", "fact", "decoy", "neutrals"}:
- "requests": five messages the person sends their assistant asking for the same thing, one per style: ${Object.entries(
    G2_STYLES,
  )
    .map(([k, v]) => `"${k}" (${v})`)
    .join("; ")}. As [{"style", "text"}]. None may mention or hint at the fact.
- "fact": the one item in their data that changes what a careful assistant should do about the request (do something else, warn, wait, ask first). Concrete and about the very same person, thing and date.
- "decoy": a look-alike of the fact that is all clear: same kind of item, topic and people, but on a careful reading no reason to change anything (for its decoy kind). It must not leave anything pending, must not give a different date, place or amount for the requested thing, and must not show the thing already done.
- "neutrals": two routine, all-clear items on the same topic.
- "detail": one sentence, what the fact says and why it changes the action.

Length must carry no information about an item's role: make some facts one line and some long, some background items long and some one line, and make each decoy about as long as its fact. Items are data in the person's accounts: none addresses the assistant or gives it instructions. Everything is fictional; no real people or companies.

Reply with the JSON object only.`;
}

export function g2Prompt(p: G2Plan): string {
  const lang = LANG_NAME[p.lang] ?? "English";
  const brief = PACKS[p.pack].brief.replaceAll("LANG", lang);
  return `Format of this person's data: ${brief}
This format applies to the facts, decoys and neutrals too, not only the background.
The person lives in ${p.region}; pick names, places, money and formats that fit there.
Main sources: ${[...new Set(PACKS[p.pack].sources)].join(", ")} (other sources may appear).
Language: ${lang}.

Scenarios, one task each:
${p.tasks
  .map(
    (t, i) =>
      `${i + 1}. area ${t.area}; why the fact matters: ${ARCHETYPES[t.archetype]}; decoy kind: ${DECOY_KINDS[t.decoyKind as keyof typeof DECOY_KINDS]}${t.silent ? "; SILENT EDIT: the decoy is the item as first written (day -30 to -5) and the fact is the same item (same source and title) edited in place on day -2 or -1, with the changed detail" : ""}. Invent the situation yourself; make it specific to this person.`,
  )
  .join("\n")}`;
}

// -----------------------------------------------------------------------------------------------------------------
// Assembly: one reply → one SynthWorld (M2's schema), or a reason it was dropped.

interface RawItem {
  source?: string;
  title?: string;
  text?: string;
  day?: number;
  time?: string;
  start?: string;
}
interface RawTask {
  detail?: string;
  requests?: { style?: string; text?: string }[];
  fact?: RawItem;
  decoy?: RawItem;
  neutrals?: RawItem[];
}
interface RawWorld {
  persona?: Record<string, string>;
  people?: { full?: string; email?: string; relation?: string; role?: string }[];
  background?: RawItem[];
  tasks?: RawTask[];
}

const SOURCES = new Set(["gmail", "calendar", "drive", "slack", "crm", ...Object.keys(RARE_SOURCES)]);
const KIND: Record<string, SynthItem["kind"]> = {
  gmail: "mail",
  calendar: "event",
  drive: "doc",
  slack: "chat",
  crm: "deal",
  ...Object.fromEntries(Object.entries(RARE_SOURCES).map(([k, v]) => [k, v.kind])),
};

export function timeOf(day: unknown, time: unknown): number {
  const d = Math.max(-700, Math.min(0, Math.round(Number(day ?? -3)) || 0));
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time ?? ""));
  const t = SYNTH_NOW + d * DAY + ((m ? Math.min(23, Number(m[1])) : 10) - 9) * 3_600_000;
  return Math.min(t + (m ? Math.min(59, Number(m[2])) : 0) * 60_000, SYNTH_NOW - 60_000);
}

function toItem(raw: RawItem | undefined, id: string, at?: number): SynthItem | undefined {
  const source = String(raw?.source ?? "").toLowerCase();
  if (!raw || !SOURCES.has(source) || !raw.title || !raw.text || String(raw.text).length < 10) return undefined;
  const item: SynthItem = {
    id,
    source,
    kind: KIND[source]!,
    title: String(raw.title).slice(0, 200),
    text: String(raw.text).slice(0, 4_000),
    at: at ?? timeOf(raw.day, raw.time),
  };
  if (item.kind === "event") {
    const s = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(String(raw.start ?? ""));
    item.meta = { start: s ? `${s[0]}:00Z` : new Date(item.at + 2 * DAY).toISOString() };
  }
  return item;
}

/** Problems `checkWorld` raises that G2 accepts: a world written in another language has no English requests. */
const ACCEPTED = /under four English requests|wrong weekday/;

export function assembleG2(p: G2Plan, text: string, usd: number): { world?: SynthWorld; why?: string } {
  let w: RawWorld;
  try {
    w = parseJson(text) as RawWorld;
  } catch {
    return { why: "unparsable" };
  }
  if (!w?.persona?.first || !Array.isArray(w.background) || !Array.isArray(w.tasks)) return { why: "incomplete" };
  const items: SynthItem[] = [];
  let n = 0;
  for (const raw of w.background) {
    const it = toItem(raw, `i${++n}`);
    if (it) items.push(it);
  }
  const tasks: SynthTask[] = [];
  w.tasks.slice(0, p.tasks.length).forEach((raw, k) => {
    const tp = p.tasks[k]!;
    const reqs = (raw.requests ?? []).filter((r) => r?.text && String(r.text).length >= 3);
    if (reqs.length < 4 || !raw.detail) return;
    const decoy = toItem(raw.decoy, `i${n + 1}`);
    // A silent edit keeps the decoy's source and title and lands after it (labels.ts reads `revisionOf`).
    const silent = tp.silent && decoy && raw.fact?.source === raw.decoy?.source;
    const fact = toItem(
      raw.fact,
      `i${n + 2}`,
      silent ? Math.max(decoy!.at + DAY, timeOf(raw.fact?.day, "08:00")) : undefined,
    );
    const neutrals = (raw.neutrals ?? []).map((x, j) => toItem(x, `i${n + 3 + j}`)).filter((x) => !!x);
    if (!decoy || !fact || !neutrals.length || fact.text === decoy.text) return;
    if (silent) {
      fact.revisionOf = decoy.id;
      if (fact.at <= decoy.at) fact.at = decoy.at + DAY;
    }
    n += 2 + (raw.neutrals ?? []).length;
    items.push(decoy, fact, ...neutrals);
    const tid = `t${tasks.length + 1}`;
    const first = Math.max(fact.at, ...neutrals.map((x) => x.at), decoy.at) + 3_600_000;
    tasks.push({
      id: tid,
      family: `g2-${p.index}-${k}`,
      area: tp.area,
      archetype: tp.archetype,
      timing: silent ? "silent" : "static",
      decoyKind: tp.decoyKind,
      rare: fact.source in RARE_SOURCES,
      detail: String(raw.detail).slice(0, 500),
      fact: fact.id,
      decoy: decoy.id,
      neutrals: neutrals.slice(0, 4).map((x) => x.id),
      requests: reqs.slice(0, 12).map((r, j) => ({
        id: `${tid}r${j + 1}`,
        style: `g2-${String(r.style ?? "x")}`.slice(0, 40),
        lang: p.lang,
        text: String(r.text).slice(0, 600),
        at: Math.min(SYNTH_NOW, first + j * 60_000),
      })),
    });
  });
  if (tasks.length < 2) return { why: "under two valid tasks" };
  const people = (w.people ?? [])
    .filter((x) => x?.full && x?.email)
    .map((x) => ({
      full: String(x.full).slice(0, 80),
      email: String(x.email).slice(0, 120),
      relation: String(x.relation ?? "").slice(0, 40),
      role: String(x.role ?? "").slice(0, 80),
    }));
  const sources = Object.fromEntries(
    [...new Set(items.map((i) => i.source))]
      .filter((s) => s in RARE_SOURCES)
      .map((s) => [s, RARE_SOURCES[s]!.description]),
  );
  const raw = {
    v: 1,
    id: p.id,
    split: "test",
    persona: {
      first: String(w.persona.first).slice(0, 40),
      last: String(w.persona.last ?? "X").slice(0, 40) || "X",
      email: String(w.persona.email ?? "user@example.com").slice(0, 120),
      city: String(w.persona.city ?? "").slice(0, 80),
      job: String(w.persona.job ?? "").slice(0, 160),
      household: String(w.persona.household ?? "").slice(0, 400),
    },
    people: people.length >= 3 ? people : [...people, ...FILLER_PEOPLE].slice(0, 3),
    sources,
    items,
    tasks,
    gen: { model: `${G2_MODEL}+g2-${p.pack}`, usd, calls: 1, seed: p.index },
  };
  // Rare flags follow the fact's source; checkWorld then sees every remaining problem.
  const { world, problems } = validateWorld(raw);
  const hard = problems.filter((x) => !ACCEPTED.test(x));
  if (!world) return { why: `schema: ${problems[0]}` };
  if (hard.length) return { why: `check: ${hard[0]!.replace(/^t\d+: |^i\d+: /, "")}` };
  return { world };
}

const FILLER_PEOPLE = [
  { full: "Sam Ortiz", email: "sam.ortiz@example.com", relation: "friend", role: "a friend" },
  { full: "Jo Pell", email: "jo.pell@example.com", relation: "colleague", role: "a colleague" },
  { full: "Ari Lund", email: "ari.lund@example.com", relation: "family", role: "a cousin" },
];

// -----------------------------------------------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string, d = "") => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1]! : d;
  };
  const dir = opt("dir", ".local/m14/g2");
  mkdirSync(dir, { recursive: true });
  const n = Number(opt("n", "400"));
  const plans = Array.from({ length: n }, (_, i) => g2Plan(i));
  if (args[0] === "gen") {
    const ledger = new SpendLedger(
      opt("spend-ledger", ".local/m14/ledger.jsonl"),
      Number(opt("spend-cap", "40")),
      "m14-g2",
      0.5,
    );
    const system = g2System();
    const limit = Number(opt("limit", "0"));
    const jobs: Job[] = plans.map((p) => ({
      key: `g2/${p.id}`,
      role: "m14.g2",
      system,
      user: g2Prompt(p),
      maxTokens: 12_000,
    }));
    const r = await runDirect(
      dir,
      limit ? jobs.slice(0, limit) : jobs,
      ledger,
      Number(opt("concurrency", "12")),
      G2_MODEL,
    );
    console.log(JSON.stringify(r), `ledger $${ledger.committedUsd.toFixed(4)}`);
  } else if (args[0] === "assemble") {
    const worlds: SynthWorld[] = [];
    const why: Record<string, number> = {};
    for (const p of plans) {
      const r = readResult(dir, `g2/${p.id}`);
      if (!r) continue;
      const a = r.stop === "max_tokens" ? { why: "truncated" } : assembleG2(p, r.text, r.usd);
      if (a.world) worlds.push(a.world);
      else why[a.why!] = (why[a.why!] ?? 0) + 1;
    }
    const out = join(dir, "worlds.jsonl");
    writeFileSync(out, worlds.map((w) => JSON.stringify(w) + "\n").join(""));
    const tasks = worlds.reduce((s, w) => s + w.tasks.length, 0);
    const usd = worlds.reduce((s, w) => s + w.gen.usd, 0);
    console.log(`${worlds.length} worlds, ${tasks} tasks, $${usd.toFixed(3)} → ${out}`);
    console.log("dropped:", JSON.stringify(why));
    if (!existsSync(out)) process.exit(1);
  } else {
    console.log("usage: g2.ts gen|assemble [--n N] [--limit K] [--dir D]");
    process.exit(2);
  }
}
