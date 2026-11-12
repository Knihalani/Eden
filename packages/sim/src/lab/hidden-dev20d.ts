/**
 * Tuning suite dev20d (F8, a dev20 tuning set; not held out: tune on it), written by an isolated author.
 * AUTHOR: replace this paragraph with the suite's description and its counts, as below.
 *
 * 40 templates, five in each life area (work, family, health, money, travel, home, admin, social, in that order).
 * Each is a request the user types (it does not name the hidden context), the consideration a good answer raises, a
 * planted item stating it (variant `hidden`) and a near-miss look-alike that does not apply (`control`); `neutral`
 * plants nothing. Request and detail are the same in every variant.
 *
 * Counts, from the comment above each template: (AUTHOR: overlap, decoy kinds, phrasing, languages, anchored, rare by
 * connector, silent by connector, sources of the rest, world-knowledge templates).
 *
 * World time is Tuesday 27 October 2026, 09:00 UTC. Weekdays checked with Date.UTC: (AUTHOR: list every date used).
 */
import { itemId } from "@eden/protocol";
import { addRareSources, RARE_SOURCES } from "../rare-sources";
import { Rng } from "../rng";
import { chatText, emailBody, emailText, type Who } from "../text";
import type { ItemKind, Person, World } from "../world";
import type { HiddenTask } from "./hidden-context";

/** A UTC instant in 2026 (month is 1-based), so the dates in this file read as written. */
const at = (month: number, day: number, h = 9, min = 0, year = 2026) => Date.UTC(year, month - 1, day, h, min);

/** One item to plant: everything but the id and ref, which the suite assigns. */
interface Plant {
  sourceId: string;
  kind: ItemKind;
  title: string;
  text: string;
  updatedAt: number;
  meta?: Record<string, string>;
}

interface Spec {
  text: string;
  detail: string;
  hidden: Plant;
  decoy: Plant;
  /**
   * Silent-change templates only (DEV20D_SILENT): the planted item as it read before someone edited it at the
   * source without telling anyone (same sourceId, kind and title as `hidden`, an earlier updatedAt, the old detail).
   * The suite plants `hidden` (the edited copy); a days harness can plant `before` first and swap in `hidden`
   * with no notice. Omit for every other template.
   */
  before?: Plant;
}

/**
 * What a template gets: `r` for every draw that shapes the task (people, numbers), and two forked streams for the
 * prose of the hidden item and of the decoy. Both items are always built, so the draws on `r` are identical across
 * variants and the three suites describe the same people and numbers.
 */
interface Ctx {
  r: Rng;
  ta: Rng;
  tb: Rng;
  user: Person;
  colleagues(k: number): Person[];
  clients(k: number): Person[];
  role(role: string, fallback: [string, string]): Person;
}

const bot = (full: string, email: string): Who => ({ full, first: full.split(" ")[0]!, email });

const people = (user: Person, ws: Who[]) =>
  ws
    .filter((w) => w.email !== user.email)
    .map((w) => `${w.full} <${w.email}>`)
    .join("; ");

/** A person-written email, with the greeting, signature and quirks text.ts gives real mail. */
function mail(
  c: Ctx,
  t: Rng,
  m: { from: Who; when: number; title: string; body: string[]; corporate?: boolean },
): Plant {
  const body = emailBody(t, { from: m.from, to: c.user, at: m.when, body: m.body, corporate: m.corporate ?? false });
  return {
    sourceId: "gmail",
    kind: "mail",
    title: m.title,
    text: emailText(m.from, c.user, m.when, body),
    updatedAt: m.when,
    meta: { people: people(c.user, [m.from, c.user]) },
  };
}

/** An automated email: no greeting or signature, a reference and a footer, as service mail has. */
function notice(c: Ctx, t: Rng, m: { from: Who; when: number; title: string; body: string }): Plant {
  const footer = t.pick([
    "This is an automated message. Replies to this address are not read. Manage your preferences | Privacy notice",
    "Please do not reply to this email. For help, visit our website or sign in to your account. Terms | Privacy",
    "You are receiving this because you have an account with us. Update your contact preferences at any time.",
  ]);
  return {
    sourceId: "gmail",
    kind: "notification",
    title: m.title,
    text: emailText(
      m.from,
      c.user,
      m.when,
      `${m.body}\n\nReference: ${t.token("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8)}\n\n${footer}`,
    ),
    updatedAt: m.when,
  };
}

/** A Slack channel excerpt: an unrelated line before the message that matters, as a search hit usually shows. */
function chat(t: Rng, channel: string, lines: { who: Person; text: string; when: number }[], bystander: Person): Plant {
  const chatter = t.pick([
    "is the wifi on 3 dropping for anyone else or just me",
    "fire alarm test at 11, don't panic",
    "lost a black umbrella in the kitchen, shout if you've seen it",
    "all-hands moved to 4pm today btw",
  ]);
  const first = lines[0]!.when - t.int(5, 45) * 60_000;
  const all = [
    { who: bystander.full, text: chatter, at: first },
    ...lines.map((l) => ({ ...l, who: l.who.full, at: l.when })),
  ];
  return {
    sourceId: "slack",
    kind: "chat",
    title: `#${channel}`,
    text: chatText(all),
    updatedAt: lines[lines.length - 1]!.when,
    meta: { people: lines.map((l) => `${l.who.full} <${l.who.email}>`).join("; ") },
  };
}

/** A calendar entry. The date line is written by the template, so it can avoid the request's own date wording. */
function event(m: { title: string; start: number; when: string; where: string; notes: string; edited: number }): Plant {
  return {
    sourceId: "calendar",
    kind: "event",
    title: m.title,
    text: `When: ${m.when}\nWhere: ${m.where}\n\n${m.notes}`,
    updatedAt: m.edited,
    meta: { start: new Date(m.start).toISOString() },
  };
}

/** A document in Drive / Notion. */
const doc = (title: string, text: string, edited: number): Plant => ({
  sourceId: "drive",
  kind: "doc",
  title,
  text: `${title}\n\n${text}`,
  updatedAt: edited,
});

/** The client's company, with a stand-in for a pool member that has none. */
const orgOf = (p: Person) => p.org ?? p.company ?? "Globex";

/** A client at another company than `p`, so a decoy about "the same kind of rule" names a different customer. */
function otherClient(c: Ctx, p: Person): Person {
  const found = c.clients(6).find((q) => orgOf(q) !== orgOf(p));
  if (found) return found;
  const org = orgOf(p) === "Hooli" ? "Initech" : "Hooli";
  return {
    id: "p-lee-brennan",
    first: "Lee",
    last: "Brennan",
    full: "Lee Brennan",
    email: `lee.brennan@${org.toLowerCase()}.com`,
    relation: "client",
    org,
    company: org,
  };
}

/** The user's home address in this suite's items (the world gives the user none). */

/**
 * An item in one of the rarely used connectors (RARE_SOURCES in ../rare-sources.ts: notes, whatsapp, bank, health,
 * school, trips, residents, tasks). Use the connector's kind; write the text the way that app shows it.
 */
const rare = (
  sourceId: string,
  title: string,
  text: string,
  updatedAt: number,
  meta?: Record<string, string>,
): Plant => {
  const src = RARE_SOURCES[sourceId];
  if (!src) throw new Error(`not a rare source: ${sourceId}`);
  return { sourceId, kind: src.kind, title, text, updatedAt, ...(meta ? { meta } : {}) };
};

// AUTHOR: write the 40 templates here. Each one is preceded by one labelled comment line of this exact shape:
// overlap: none|name|topic-word · decoy: (a) resolved/expired/superseded|(b) other entity or date|(c) condition met · phrasing: imperative|plan|statement|question · source: <sourceId> (<kind>) · anchored: yes|no · silent: yes|no · rare: yes|no · knowledge: yes|no · language: <English|German|…>
const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
];

/** Templates whose request names one person, thing or date the planted item words differently. */
export const DEV20D_ANCHORED: readonly string[] = [];
/** Templates whose planted item (both variants) sits in a rare source (RARE_SOURCES). */
export const DEV20D_RARE: readonly string[] = [];
/** Templates whose fact is a silent edit at the source (their Spec has `before`). */
export const DEV20D_SILENT: readonly string[] = [];
/** Templates whose request is not in English (name the language in the template's comment). */
export const DEV20D_NON_ENGLISH: readonly string[] = [];
/** Templates whose request is indirect or a question ("Should I…", "I need to…", "We should…", "Can we…?"). */
export const DEV20D_INDIRECT: readonly string[] = [];
/** Templates whose request is a question (a subset of DEV20D_INDIRECT). */
export const DEV20D_QUESTION: readonly string[] = [];
/** Templates whose fact connects to the request only through world knowledge (a drug and alcohol, asbestos and a drill). */
export const DEV20D_KNOWLEDGE: readonly string[] = [];
/** Templates whose request shares no word with the planted item (overlap: none). */
export const DEV20D_NO_OVERLAP: readonly string[] = [];

/** Each silent-change template's `before` item, for a days harness (same RNG draws as the planting function). */
export function dev20dBefore(world: World, seed: number): { template: string; before: Plant }[] {
  return build(world, seed).flatMap(({ name, spec }) => (spec.before ? [{ template: name, before: spec.before }] : []));
}

/** Build every template's spec, in order, with the suite's own streams (no world change). */
function build(world: World, seed: number): { name: string; spec: Spec }[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 2004);
  const by = (rel: string) => world.people.filter((p) => p.relation === rel);
  const pools = { colleague: by("colleague"), client: by("client") };
  // Never run out: a pool too small for k distinct people repeats, and an empty one falls back to a stand-in.
  const draw = (pool: Person[], k: number, stand: Person): Person[] => {
    if (pool.length === 0) return Array.from({ length: k }, () => stand);
    const out = r.sample(pool, Math.min(k, pool.length));
    while (out.length < k) out.push(r.pick(pool));
    return out;
  };
  const standIn = (first: string, last: string, relation: Person["relation"], org?: string): Person => ({
    id: `p-${first}-${last}`.toLowerCase(),
    first,
    last,
    full: `${first} ${last}`,
    email: `${first}.${last}@${org ? `${org.toLowerCase().replace(/\W+/g, "")}.com` : "gmail.com"}`.toLowerCase(),
    relation,
    org,
    company: org,
  });
  const relationOf = (role: string): Person["relation"] =>
    role === "friend" || role === "best friend" ? "friend" : role === "mum" || role === "sister" ? "family" : "service";
  return TEMPLATES.map((t) => {
    const ta = r.fork();
    const tb = r.fork();
    const ctx: Ctx = {
      r,
      ta,
      tb,
      user: world.user,
      colleagues: (k) => draw(pools.colleague, k, standIn("Alex", "Morgan", "colleague", world.user.company)),
      clients: (k) => draw(pools.client, k, standIn("Jordan", "Blake", "client", "Globex")),
      role: (role, [first, last]) =>
        world.people.find((p) => p.role === role) ?? standIn(first, last, relationOf(role)),
    };
    return { name: t.name, spec: t.build(ctx) };
  });
}

/**
 * Plant one item per template (the real one for `hidden`, the decoy for `control`, nothing for `neutral`) and return
 * the tasks. The rare sources and their filler are added in every variant, so the three see the same connectors.
 */
export function plantDev20d(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  addRareSources(world, seed);
  const suite = variant === "hidden" ? "dev20d" : `dev20d-${variant}`;
  const tasks: HiddenTask[] = [];
  for (const { name, spec } of build(world, seed)) {
    if (variant !== "neutral") {
      const p = variant === "hidden" ? spec.hidden : spec.decoy;
      // The same ref in hidden and control, of the base world's shape (`<kind>-<index>`): a ref naming the template or
      // marking the item as planted would tell the agent.
      const ref = `${p.kind}-${world.items.length}`;
      world.items.push({ ...p, id: itemId(p.sourceId, ref), ref, facts: [], noise: false });
    }
    tasks.push({ id: `w${seed}:${suite}:${name}`, template: name, text: spec.text, detail: spec.detail });
  }
  return tasks;
}
