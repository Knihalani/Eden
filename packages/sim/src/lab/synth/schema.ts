/**
 * The synth world format (D880) and its checks. LAB ONLY. A world is one synthetic user's items and tasks; each task
 * is a HiddenTask-shaped template (requests, a planted fact, its decoy twin, neutral items of the same topic) whose
 * labels come from construction (`labels.ts`), never from a model.
 */
import { z } from "zod";
import { AREAS, ARCHETYPE_NAMES, DECOY_KINDS, RARE_SOURCES, SYNTH_NOW, TIMINGS, type Archetype } from "./taxonomy";
import { COMMON_SOURCES } from "./taxonomy";

const DAY = 86_400_000;
const KINDS = ["mail", "newsletter", "notification", "promo", "event", "doc", "deal", "contact", "chat"] as const;
const SOURCE_IDS = [...COMMON_SOURCES, ...Object.keys(RARE_SOURCES)] as [string, ...string[]];

export const FamilySchema = z.object({
  id: z.string().regex(/^f-[a-z0-9-]+$/),
  area: z.enum(AREAS),
  archetype: z.enum(ARCHETYPE_NAMES as [Archetype, ...Archetype[]]),
  /** One or two sentences, no names: the scenario every world instantiating the family shares. */
  situation: z.string().min(20).max(600),
  request: z.string().min(5).max(300),
  fact: z.string().min(10).max(400),
  decoy: z.string().min(10).max(400),
  decoyKind: z.enum(Object.keys(DECOY_KINDS) as [keyof typeof DECOY_KINDS, ...(keyof typeof DECOY_KINDS)[]]),
  source: z.string().min(2).max(40),
});
export type Family = z.infer<typeof FamilySchema>;

export const ItemSchema = z.object({
  id: z.string().regex(/^i\d+$/),
  source: z.enum(SOURCE_IDS),
  kind: z.enum(KINDS),
  title: z.string().min(1).max(200),
  text: z.string().min(10).max(4_000),
  /** Epoch ms: when the item (this revision) appeared in its source. */
  at: z.number().int(),
  /** Participants as a connector reports them ("Name <email>; …") and an event's start (ISO), as in world.ts. */
  meta: z.record(z.string(), z.string()).optional(),
  /** A silent change: this item is the in-place edit of `revisionOf` (same source item, no notification). */
  revisionOf: z.string().optional(),
});
export type SynthItem = z.infer<typeof ItemSchema>;

export const RequestSchema = z.object({
  id: z.string().regex(/^t\d+r\d+$/),
  style: z.string(),
  lang: z.string().min(2).max(5),
  text: z.string().min(3).max(600),
  at: z.number().int(),
});
export type SynthRequest = z.infer<typeof RequestSchema>;

export const TaskSchema = z.object({
  id: z.string().regex(/^t\d+$/),
  family: z.string(),
  area: z.enum(AREAS),
  archetype: z.enum(ARCHETYPE_NAMES as [Archetype, ...Archetype[]]),
  timing: z.enum(TIMINGS),
  decoyKind: z.string(),
  rare: z.boolean(),
  /** The hidden consideration a good answer raises, as a grader reads it (HiddenTask.detail). */
  detail: z.string().min(10).max(500),
  fact: z.string(),
  decoy: z.string(),
  neutrals: z.array(z.string()).min(1).max(4),
  requests: z.array(RequestSchema).min(4).max(12),
});
export type SynthTask = z.infer<typeof TaskSchema>;

export const PersonSchema = z.object({
  full: z.string().min(3).max(80),
  email: z.string().min(3).max(120),
  relation: z.string().max(40),
  role: z.string().max(80).optional(),
});

export const WorldSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(/^sw-[a-z0-9-]+$/),
  split: z.enum(["train", "val", "test"]),
  persona: z.object({
    first: z.string().min(1).max(40),
    last: z.string().min(1).max(40),
    email: z.string().min(3).max(120),
    city: z.string().max(80),
    job: z.string().max(160),
    household: z.string().max(400),
  }),
  people: z.array(PersonSchema).min(3).max(40),
  /** The rare sources the world uses, id → description (the common five are implied). */
  sources: z.record(z.string(), z.string()),
  items: z.array(ItemSchema).min(10).max(200),
  tasks: z.array(TaskSchema).min(1).max(12),
  gen: z.object({ model: z.string(), usd: z.number(), calls: z.number().int(), seed: z.number().int() }),
});
export type SynthWorld = z.infer<typeof WorldSchema>;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Weekday-date pairs a text states ("Thursday 29 October", "Thu 29 Oct 2026") that the calendar contradicts, read
 * against the year given or, without one, the year that puts the date nearest the sim's present.
 */
export function wrongWeekdays(text: string): string[] {
  const out: string[] = [];
  const re =
    /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*,?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s+(20\d\d))?/gi;
  for (const m of text.matchAll(re)) {
    const wd = WEEKDAYS.findIndex((w) => w.startsWith(m[1]!.toLowerCase().slice(0, 3)));
    const mon = MONTHS.findIndex((x) => x.startsWith(m[3]!.toLowerCase().slice(0, 3)));
    const day = Number(m[2]);
    const years = m[4] ? [Number(m[4])] : [2025, 2026, 2027];
    const near = years
      .map((y) => Date.UTC(y, mon, day))
      .sort((a, b) => Math.abs(a - SYNTH_NOW) - Math.abs(b - SYNTH_NOW))[0]!;
    if (new Date(near).getUTCDay() !== wd) out.push(m[0]);
  }
  return out;
}

/**
 * Everything the schema cannot say: references resolve, every item belongs to one task at most, the timing's shape
 * holds (silent: the fact edits the decoy; late: the fact lands the same day after the first request; multiday: the
 * fact lands between the first and the last request), rare tasks plant in a rare source, times are in range, and no
 * weekday contradicts its date. Returns the problems (empty when the world is valid).
 */
export function checkWorld(w: SynthWorld): string[] {
  const p: string[] = [];
  const items = new Map(w.items.map((i) => [i.id, i]));
  if (items.size !== w.items.length) p.push("duplicate item ids");
  const owner = new Map<string, string>();
  const claim = (id: string, t: string) => {
    if (!items.has(id)) p.push(`${t}: no item ${id}`);
    if (owner.has(id)) p.push(`${t}: item ${id} already belongs to ${owner.get(id)}`);
    owner.set(id, t);
  };
  const reqIds = new Set<string>();
  for (const t of w.tasks) {
    claim(t.fact, t.id);
    claim(t.decoy, t.id);
    for (const n of t.neutrals) claim(n, t.id);
    const fact = items.get(t.fact);
    const decoy = items.get(t.decoy);
    if (!fact || !decoy) continue;
    const reqs = [...t.requests].sort((a, b) => a.at - b.at);
    for (const r of reqs) {
      if (reqIds.has(r.id)) p.push(`${t.id}: duplicate request id ${r.id}`);
      reqIds.add(r.id);
      if (!r.id.startsWith(`${t.id}r`)) p.push(`${t.id}: request ${r.id} named for another task`);
    }
    const first = reqs[0]!.at;
    const last = reqs[reqs.length - 1]!.at;
    if (t.timing === "silent") {
      if (fact.revisionOf !== decoy.id) p.push(`${t.id}: silent fact does not revise the decoy`);
      if (!(fact.at > decoy.at)) p.push(`${t.id}: silent fact is not after the decoy`);
      if (fact.source !== decoy.source) p.push(`${t.id}: silent fact moved source`);
    } else if (fact.revisionOf) p.push(`${t.id}: only a silent fact revises an item`);
    if (t.timing === "late" && !(fact.at > first && fact.at - first < DAY)) p.push(`${t.id}: late fact not same day`);
    if (t.timing === "multiday") {
      if (!(last - first >= DAY)) p.push(`${t.id}: multiday requests span under a day`);
      if (!(fact.at > first && fact.at < last)) p.push(`${t.id}: multiday fact not between requests`);
    }
    if ((t.timing === "static" || t.timing === "silent") && fact.at > first) p.push(`${t.id}: fact after request`);
    if (t.rare !== fact.source in RARE_SOURCES) p.push(`${t.id}: rare flag does not match fact source`);
    if (fact.source in RARE_SOURCES && !(fact.source in w.sources)) p.push(`${t.id}: rare source not declared`);
    const en = t.requests.filter((r) => r.lang === "en").length;
    if (en < 4) p.push(`${t.id}: under four English requests`);
  }
  for (const i of w.items) {
    if (i.at < SYNTH_NOW - 730 * DAY || i.at > SYNTH_NOW + 10 * DAY) p.push(`${i.id}: time out of range`);
    if (i.source in RARE_SOURCES && !(i.source in w.sources)) p.push(`${i.id}: rare source not declared`);
    const bad = wrongWeekdays(`${i.title}\n${i.text}`);
    if (bad.length) p.push(`${i.id}: wrong weekday ${bad.join(", ")}`);
  }
  for (const t of w.tasks)
    for (const r of t.requests) {
      const bad = wrongWeekdays(r.text);
      if (bad.length) p.push(`${r.id}: wrong weekday ${bad.join(", ")}`);
    }
  return p;
}

/** Parses and checks one world: the zod schema, then `checkWorld`. */
export function validateWorld(raw: unknown): { world?: SynthWorld; problems: string[] } {
  const r = WorldSchema.safeParse(raw);
  if (!r.success) return { problems: r.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`) };
  return { world: r.data, problems: checkWorld(r.data) };
}
