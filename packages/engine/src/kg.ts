/**
 * A per-user knowledge graph over every item the cache holds (docs/research/moon-graph.md; `graph`, off by default).
 * The cache's index finds items that share a request's words. Many items that change what a request is about to do
 * share none: "Reply to Ahmed Hassan" and "do not commit delivery dates to Umbrella Health" are tied only by Ahmed's
 * address at umbrellahealth.com, read from some other mail; "Give Łukasz Nowak the draft" and "#team: Łukasz: I'm
 * offline from 26 Oct" only by the first name the user's own items show Łukasz Nowak goes by; "schedule the release
 * for Thursday" and "no production changes 28 Oct to 3 Nov" only by the day. The graph holds those ties.
 *
 * Nodes are named things (people, organisations, projects and systems: one namespace, a name squashed to its letters
 * and digits, so "Umbrella Health" and the domain label "umbrellahealth" are one node), email addresses, identifiers
 * ("INV-7174", an IBAN), channels, roles ("manager", "legal") and days. Edges join an item to a node with a type
 * (`EDGE`): about (in its title), authored, attended, mentions, ref, channel, role, on (an event's day) and constrains
 * (a node named in a sentence that blocks, moves or settles something, `conflict.ts` `constrains`; for a day, a day
 * such a sentence covers). Nodes join nodes too: a person to their address and first name (alias), a person to the
 * organisation their address is at (member).
 *
 * Built as items are cached and dropped with them (`ItemCache`), per user, bounded: at most `MAX_NODES_PER_ITEM` nodes
 * an item, `MAX_SPAN_DAYS` days a span (a longer one, and the days after an expiry, kept whole), `MAX_NODES` a user.
 * Retrieval (`walk`) is spreading activation from the request's names, ids, roles and days, two hops through node
 * links, then to items, with typed-edge weights learned per user from whether what was delivered was used (`learn`),
 * each node's spread divided by its degree (a name on every item says nothing), the user's own name, addresses and
 * organisation left out, under a hard time bound. No model, no source call. Item text is read with fixed linear
 * patterns, as data: it is never followed.
 */
import type { ContextItem } from "@eden/protocol";
import { constrains, datesIn } from "./conflict";
import { LEADING, ROLES, rolesOf } from "./probes";
import { isStopword } from "./text";

/** Edge types, as bit positions in an edge's mask. */
export const EDGE = {
  about: 0,
  authored: 1,
  attended: 2,
  mentions: 3,
  ref: 4,
  channel: 5,
  role: 6,
  on: 7,
  constrains: 8,
  alias: 9,
  member: 10,
} as const;
export type EdgeType = keyof typeof EDGE;
const TYPES = Object.keys(EDGE) as EdgeType[];
const N_TYPES = TYPES.length;
const bit = (t: EdgeType) => 1 << EDGE[t];

/**
 * Prior weights of the edge types: how much an edge of the type says the item is about the node. A title naming a
 * thing, an identifier, or an author says more than a passing mention or a channel; a link to an organisation through
 * an address says less than an alias of the same person. Multiplied by the user's learned factor (`factor`).
 */
const PRIOR: Record<EdgeType, number> = {
  about: 1,
  authored: 0.9,
  attended: 0.6,
  mentions: 0.7,
  ref: 1.2,
  channel: 0.5,
  role: 0.8,
  on: 0.5,
  constrains: 2,
  alias: 0.8,
  member: 0.7,
};

/** Nodes read from one item, at most: a long thread names many things, and the rest add degree, not ties. */
const MAX_NODES_PER_ITEM = 48;
/**
 * A span of at least this many days ("from 19 Oct until further notice") is not linked day by day: it is kept whole
 * with its item (`UserGraph.long`) and a walk from a day it covers scans for it.
 */
const MAX_SPAN_DAYS = 21;
/** Characters of an item read: what names it and constrains it comes early. */
const READ_CHARS = 4_000;
/** A node on more than this many items is a hub (the user's own name, their company): it spreads nothing. */
const HUB = 400;
/** Links a node keeps to other nodes (a person's addresses and names; an organisation's people). */
const MAX_LINKS = 64;
/** Hops of node links a walk takes before it reaches items, and how much the second one keeps. */
const LINK_HOPS = 2;
const HOP_DECAY = 0.6;
/** Long spans an item keeps at most (`Extraction.long`). */
const MAX_LONG = 4;
/** A sentence that states an expiry or lapse: its day is when a constraint starts, not a deadline. */
const EXPIRY = /\b(?:expir\w*|lapse[sd]?|valid (?:to|until|through))\b/;
/** Nodes per user at most; past it, an item's new nodes are not added (its known ones still are). */
const MAX_NODES = 120_000;

export type NodeKind = "name" | "email" | "id" | "channel" | "role" | "day";

interface GNode {
  kind: NodeKind;
  /** The node's name as first seen written (for ties): "Umbrella Health", "inv-7174", "#legal", "2026-10-29". */
  label: string;
  /** Item id → mask of edge types (`EDGE`). */
  items: Map<string, number>;
  /** Node key → { mask, count }: a link is kept while some item still states it. */
  links: Map<string, { mask: number; n: number }>;
}

/** What one item put in the graph, so it can be taken out again. */
interface Placed {
  nodes: string[];
  links: [string, string, number][];
  /** Its authors' node keys (From, organiser, owner, chat speaker). */
  authors: string[];
  /** Sent by a system, not a person (`AUTOMATED`). */
  automated: boolean;
  /** A sentence of it blocks, moves or settles something (`conflict.ts` `constrains`). */
  bound: boolean;
}

/** What `extract` reads from an item: its nodes with edge masks, node links, and authors. */
export interface Extraction {
  nodes: Map<string, { kind: NodeKind; label: string; mask: number }>;
  links: [string, string, number][];
  authors: string[];
  /** Sent by a system, not a person: a no-reply or notification address (`AUTOMATED`). */
  automated: boolean;
  /** A sentence of it blocks, moves or settles something. */
  bound: boolean;
  /** Spans its blocking sentences hold too long to link day by day, and the days after an expiry it states. */
  long: { from: string; to: string }[];
}

/** One seed of a walk: a node key and its starting activation. */
export interface Seed {
  key: string;
  weight: number;
  /** For a word of a longer name: that name's key. The word seeds only when the name is no node ("Hooli RFP"). */
  parent?: string;
}

/** An item a walk reached: its activation, the edge types it was reached by, and the nodes it was reached through. */
export interface Walked {
  id: string;
  score: number;
  mask: number;
  /** Labels of the nodes the item touches that were activated (for the conflict test's ties). */
  via: string[];
  /**
   * Whether an author of the item is a seed, or one of a seed's own names, addresses or role holder (`conflict.ts`
   * `speaks`): their "I" is what the request names.
   */
  speaks: boolean;
  /** Whether it was reached by a name, id or role (not only by a day). */
  named: boolean;
  /**
   * Whether it was reached through a node it constrains: a name in a sentence of it that blocks, moves or settles
   * something, its author or title subject when it does, or a day it holds such a span over. Only such an item is
   * set against the request with no model (`Partner.grounded`).
   */
  binds: boolean;
  /** Sent by a system (a notification), not a person. */
  automated: boolean;
  /** Reached through an identifier the request names ("INV-7174"). */
  byRef: boolean;
}

export interface WalkOptions {
  /** Hard time bound (ms): past it, the walk returns what it has. */
  budgetMs: number;
  /** Items returned at most. */
  limit: number;
  /** Least activation an item needs. */
  floor: number;
  /** Nodes never activated: the user themself, their addresses and organisation, which are on everything. */
  exclude?: ReadonlySet<string>;
}

/** Free-mail domains name no organisation. */
const FREE_MAIL = new Set(
  "gmail googlemail icloud me mac outlook hotmail live msn yahoo aol proton protonmail hey fastmail gmx yandex".split(
    " ",
  ),
);
/** Labels of a domain that are not the organisation's name ("co" in "globex.co.uk"). */
const SUFFIXES = new Set("com co org net gov edu ac io ai app inc ltd uk us de fr eu nz au ca".split(" "));

/**
 * Capitalised words that start sentences and greetings rather than name anything. With the stopwords, the dates and
 * the request verbs (`LEADING`-like), a single such word at a sentence start is not a node.
 */
const COMMON_CAPS = new Set(
  (
    "re fw fwd hi hello hey dear thanks thank cheers best regards kind warm reminder update updates quick heads fyi " +
    "note notes please just all our your the this that these those we you it its i im i'm i've i'll let lets let's " +
    "from to cc date sent subject when where who what why how attendees organiser organizer owner status contact " +
    "deal stage amount reason account legal policy section entry outcome declared reviewed location preferences " +
    "today tomorrow yesterday tonight morning afternoon evening night monday tuesday wednesday thursday friday " +
    "saturday sunday january february march april may june july august september october november december jan feb " +
    "mar apr jun jul aug sep sept oct nov dec mon tue tues wed thu thur thurs fri sat sun am pm utc gmt bst cet " +
    "anything nothing something everything nobody anyone someone everyone any no yes ok okay sure great good nice " +
    "can could would will should may might must shall do does did done send sending sent get got go going " +
    "one two three four five six seven eight nine ten new old next last first second same other"
  ).split(" "),
);

/** A domain's organisation label: "umbrellahealth" for umbrellahealth.com, "globex" for mail.globex.co.uk. */
export function orgLabel(domain: string): string | null {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  // The top-level label is never the name ("hooli.xyz" is Hooli); then any second-level one ("co" in ".co.uk").
  if (parts.length > 1) parts.pop();
  while (parts.length > 1 && SUFFIXES.has(parts.at(-1)!)) parts.pop();
  const label = parts.at(-1);
  if (!label || parts.length === 0 || FREE_MAIL.has(label) || label.length < 2) return null;
  return label.replace(/[^a-z0-9]/g, "") || null;
}

/** A name squashed to its lower-case letters and digits: "Umbrella Health" and "umbrellahealth" are one key. */
export const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]s$/u, "")
    .replace(/[^\p{L}\p{N}]/gu, "");

const nameKey = (s: string) => `n:${squash(s)}`;

/** Header lines that name who takes part, and how: a sender, organiser or owner wrote it; the rest attended it. */
const PARTY = /^(from|to|cc|attendees|owner|organi[sz]er|primary contact|contact):[ \t]*([^\n]{0,600})$/gim;
/** An email address, bounded in every part. */
const EMAIL = /([\w.+-]{1,64})@([\w-]{1,63}(?:\.[\w-]{1,63}){1,4})/g;
/** Capitalised words at the start or the end of a text: the name before an address, or after a header's colon. */
const LEADING_NAME = /^\s*(\p{Lu}[\p{L}'’-]{0,30}(?:[ \t]+\p{Lu}[\p{L}'’-]{0,30}){0,3})/u;
const TRAILING_NAME = /(\p{Lu}[\p{L}'’-]{0,30}(?:[ \t]+\p{Lu}[\p{L}'’-]{0,30}){0,3})[\s"'“”(<]*$/u;
/** A chat line's time and speaker ("[09:14] Bo Jensen: "), or, in a chat item, a line that starts with a name. */
const SPEAKER = /^(\[\d{1,2}:\d{2}\]\s?)?(\p{Lu}[\p{L}'’-]{0,30}(?:[ \t]\p{Lu}[\p{L}'’-]{0,30}){0,2}):[ \t]/gmu;
/** An identifier: "INV-7174", "SEC-373", "SOW-9597", "PO-4471", "PO 4471". */
const IDENT = /\b([A-Z]{2,6})[- ]?(\d{2,9})\b/g;
/** An IBAN-like account number: two letters, two digits, then 10 to 30 letters and digits in groups. */
const IBAN = /\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?)\b/g;
/** A word of a name: letters (any script), digits and inner marks. */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}&'’.-]{0,40}/gu;
/**
 * A role named as someone's ("your manager", "the landlord", "(Legal)"). Not "my X": in a message from someone else,
 * "my mum" is theirs, not the user's.
 */
const ROLE_AT = /\b(?:your|our|the)\s+([a-z]{2,12})\b|\(([a-z]{2,12})\)/g;
/** A name just before a role in apposition: "Mark (your manager)", "Robert Haddad (Legal)". */
const NAME_BEFORE = /(\p{Lu}[\p{L}'’-]{0,30}(?:[ \t]+\p{Lu}[\p{L}'’-]{0,30}){0,2})[ \t]*[(,–—-]?[ \t]*$/u;
/**
 * Roles that name one person or office ("your manager", "my mum", "Robert Haddad (Legal)"), not a group the user is
 * part of: "outside the team" and "my team" tie nothing to each other.
 */
const PERSON_ROLES = new Set(
  [...ROLES].filter((r) => !/^(team|colleague|lead|finance|accounts|payroll|hr|assistant|parents|kids)$/.test(r)),
);
/** The local part of an address a system sends from: a status a tool reports is no one's constraint on a person. */
const AUTOMATED =
  /^(?:no-?reply|do-?not-?reply|notify|notifications?|alerts?|jira|github|gitlab|bot|mailer-daemon|updates?|calendar-notification|shipment-tracking)$/i;
/** Identifier prefixes that are units or times, not references. */
const NOT_ID = /^(AM|PM|ST|ND|RD|TH|GB|MB|KB|PX|BN|NO|FY|CY|UTC|GMT|BST|CET|EST|PST|NZDT|UK|EU|US|Q|H)$/;

/**
 * The capitalised runs of a text: names of people, organisations, projects and systems ("Umbrella Health", "H1
 * 2027", "Łukasz"). One linear pass over its words: a run is consecutive capitalised words with only spaces between
 * them; a number continues a run it does not start ("SOC 2", "H1 2027"). A single word that starts a sentence counts
 * only when it is not a common capitalised word (`COMMON_CAPS`), a stopword, or a role.
 */
export function runsOf(text: string, max = 32, title = false): string[] {
  const out: string[] = [];
  let run: string[] = [];
  let runStart = false;
  let lastEnd = -1;
  let sentenceStart = true;
  const flush = () => {
    // Dates and common words around a name are not part of it ("on Friday Dana Lee", "Hi Robin"), nor is a number
    // left at either end ("Mon 26 Oct" is no name).
    const lead = (w: string) => COMMON_CAPS.has(w.toLowerCase()) || LEADING.has(w.toLowerCase()) || /^\p{N}/u.test(w);
    while (run.length > 0 && lead(run[0]!)) {
      run.shift();
      runStart = false;
    }
    while (run.length > 0 && COMMON_CAPS.has(run.at(-1)!.toLowerCase())) run.pop();
    if (run.length > 0) {
      const one = run.length === 1 ? run[0]!.toLowerCase() : "";
      // A quarter or a half alone ("Q4", "H1") is a time, on half the user's mail: no name.
      const skip =
        one !== "" &&
        ((runStart && !title) || isStopword(one) || ROLES.has(one) || one.length < 2 || /^[qh]\d$/.test(one));
      const name = run.join(" ").replace(/['’]s$/u, "");
      if (!skip && name.length <= 80 && !out.includes(name)) out.push(name);
    }
    run = [];
  };
  for (const m of text.matchAll(WORD)) {
    if (out.length >= max) break;
    const word = m[0].replace(/[.'’-]+$/u, "");
    const at = m.index!;
    const between = lastEnd < 0 ? "" : text.slice(lastEnd, at);
    const joined = lastEnd >= 0 && /^[ \t]+$/.test(between);
    if (!joined) {
      flush();
      if (lastEnd < 0 || /[.!?:\n]/.test(between)) sentenceStart = true;
    }
    const cap = /^\p{Lu}/u.test(word);
    const num = /^\p{N}/u.test(word);
    if (cap || (num && run.length > 0)) {
      if (run.length === 0) runStart = sentenceStart;
      if (run.length < 4) run.push(word);
    } else flush();
    sentenceStart = /[.!?:]$/.test(m[0]) && !/\p{Lu}\.$/u.test(m[0]);
    lastEnd = at + m[0].length;
  }
  flush();
  return out;
}

/**
 * What an item puts in the graph (`Extraction`). `now` resolves the year of a day written without one. Linear in the
 * item's head (`READ_CHARS`); at most `MAX_NODES_PER_ITEM` nodes.
 */
export function extract(item: ContextItem, now: number): Extraction {
  const nodes = new Map<string, { kind: NodeKind; label: string; mask: number }>();
  const links: [string, string, number][] = [];
  const authors: string[] = [];
  const authorNames: string[] = [];
  let automated = false;
  const long: { from: string; to: string }[] = [];
  const add = (key: string, kind: NodeKind, label: string, type: EdgeType) => {
    if (key.length <= 2) return;
    const known = nodes.get(key);
    if (known) {
      known.mask |= bit(type);
      // A name written out ("Umbrella Health") is a better label than a domain's squashed one.
      if (kind === "name" && /\s/.test(label) && !/\s/.test(known.label)) known.label = label;
      return;
    }
    if (nodes.size >= MAX_NODES_PER_ITEM) return;
    nodes.set(key, { kind, label, mask: bit(type) });
  };
  const link = (a: string, b: string, type: EdgeType) => {
    if (a !== b && a.length > 2 && b.length > 2 && links.length < MAX_NODES_PER_ITEM) links.push([a, b, bit(type)]);
  };
  const title = item.title.slice(0, 500);
  const body = item.text.slice(0, READ_CHARS);
  /** A person by name (capitalised words), with an address or not: the person, address, first name, organisation. */
  const person = (name: string, email: { local: string; domain: string } | null, type: EdgeType) => {
    const words = name.trim().split(/\s+/).filter(Boolean);
    while (words.length > 0 && COMMON_CAPS.has(words[0]!.toLowerCase())) words.shift();
    const one = words.length === 1 ? words[0]!.toLowerCase() : "";
    const isName = words.length >= 1 && (one === "" || !(isStopword(one) || ROLES.has(one) || one.length < 2));
    let key: string | null = null;
    if (isName) {
      const full = words.join(" ");
      key = nameKey(full);
      add(key, "name", full, type);
      if (type === "authored") {
        authors.push(key);
        authorNames.push(full);
      }
      if (words.length >= 2) {
        // A first name links to the person: "Łukasz" in a chat is Łukasz Nowak when the user's items say so.
        const first = nameKey(words[0]!);
        add(first, "name", words[0]!, type);
        link(key, first, "alias");
      }
    }
    if (email) {
      const at = `e:${email.local.toLowerCase()}@${email.domain.toLowerCase()}`;
      add(at, "email", at.slice(2), type);
      if (type === "authored") authors.push(at);
      if (type === "authored" && AUTOMATED.test(email.local)) automated = true;
      if (key) link(key, at, "alias");
      const org = orgLabel(email.domain);
      if (org) {
        const orgKey = `n:${org}`;
        add(orgKey, "name", org, "mentions");
        link(key ?? at, orgKey, "member");
      }
    }
  };
  /** The people of a text: each address with the name written just before it, then names with no address. */
  const people = (value: string, type: EdgeType, bare: boolean) => {
    let found = false;
    for (const m of value.matchAll(EMAIL)) {
      found = true;
      const before = value.slice(Math.max(0, m.index! - 80), m.index!);
      person(TRAILING_NAME.exec(before)?.[1] ?? "", { local: m[1]!, domain: m[2]! }, type);
    }
    if (found || !bare) return;
    for (const entry of value.split(/[;,]/)) {
      const name = LEADING_NAME.exec(entry)?.[1];
      if (name) person(name, null, type);
    }
  };
  // Who takes part: header lines and `meta.people`; addresses anywhere else in the text are mentions.
  for (const m of body.matchAll(PARTY)) {
    const field = m[1]!.toLowerCase();
    people(m[2]!, /^(from|owner|organi)/.test(field) ? "authored" : "attended", true);
  }
  if (item.meta?.people) people(item.meta.people.slice(0, 1_000), "attended", true);
  people(body.replace(PARTY, ""), "mentions", false);
  // Chat speakers, and the channel a chat item is in.
  const channel = /^#([\p{L}\p{N}_-]{2,40})/u.exec(title);
  const chat = channel !== null || /^dm\b/i.test(title);
  for (const m of body.matchAll(SPEAKER)) if (m[1] || chat) person(m[2]!, null, "authored");
  if (channel) add(`c:#${channel[1]!.toLowerCase()}`, "channel", `#${channel[1]!.toLowerCase()}`, "channel");
  // Sentences that block, move or settle something constrain what they name and the days they cover.
  const sentences = `${title}.\n${body}`.split(/[.!?;]+\s|\n+/);
  let bound = false;
  for (const raw of sentences) {
    const lower = raw.toLowerCase();
    const binding = raw.length >= 3 && constrains(lower);
    bound ||= binding;
    const inTitle = raw.trim().length > 2 && title.includes(raw.trim());
    // A title's first word is its subject as often as not ("Globex — account", "Hooli supplier tender").
    for (const run of runsOf(raw, 12, inTitle)) {
      add(nameKey(run), "name", run, inTitle ? "about" : "mentions");
      if (binding) add(nameKey(run), "name", run, "constrains");
    }
    for (const m of raw.matchAll(IDENT)) {
      if (NOT_ID.test(m[1]!)) continue;
      const id = `${m[1]!.toLowerCase()}-${m[2]}`;
      add(`i:${id}`, "id", id, "ref");
      if (binding) add(`i:${id}`, "id", id, "constrains");
    }
    for (const m of raw.matchAll(IBAN)) {
      const id = m[1]!.replace(/\s/g, "").toLowerCase();
      if (id.length >= 14) add(`i:${id}`, "id", id, "ref");
    }
    for (const m of lower.matchAll(ROLE_AT)) {
      const role = (m[1] ?? m[2])!;
      if (!PERSON_ROLES.has(role)) continue;
      add(`r:${role}`, "role", role, binding ? "constrains" : "role");
      // The person the role is someone's: the name just before it, the item's author when that is their first name.
      // (Read from the sentence as written, at the same place: lower-casing kept its length, or it is not read.)
      const before = raw.slice(Math.max(0, m.index! - 40), m.index!);
      const named = lower.length === raw.length ? NAME_BEFORE.exec(before) : null;
      if (named) {
        const name = named[1]!.trim();
        const full = authorNames.find((a) => a === name || a.split(" ")[0] === name);
        link(nameKey(full ?? name), `r:${role}`, "alias");
      }
    }
    if (binding) {
      const d = datesIn(lower, now);
      for (const sp of d.spans) {
        // A span too long to link day by day ("pausing headcount from 19 Oct until Q1") is kept whole (`long`).
        if (daysBetween(sp.from, sp.to) >= MAX_SPAN_DAYS) {
          if (long.length < MAX_LONG) long.push(sp);
        } else for (const day of daysOf(sp.from, sp.to)) add(`d:${day}`, "day", day, "constrains");
      }
      // A deadline ("the slip by Monday 2 Nov") binds what it is about, not every day before it. An expiry binds every
      // day after it: "passport expires 2 Nov" constrains a trip on the 21st.
      if (EXPIRY.test(lower)) {
        for (const day of d.limits) if (long.length < MAX_LONG) long.push({ from: nextDay(day), to: "9999-12-31" });
      }
    }
  }
  // An item that constrains anything constrains through its author and what its title names too: "Łukasz: I'm
  // offline from 26 Oct" is Łukasz's constraint, whichever sentence says so.
  if (bound) {
    for (const n of nodes.values())
      if (n.kind !== "day" && n.mask & (bit("authored") | bit("about"))) n.mask |= bit("constrains");
  }
  const start = item.meta?.start?.slice(0, 10);
  if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) add(`d:${start}`, "day", start, "on");
  return { nodes, links, authors, automated, bound, long };
}

/** Days from one ISO day to another (Infinity when either is no day). */
function daysBetween(from: string, to: string): number {
  const d = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(d) ? d : Infinity;
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The ISO days from `from` to `to` inclusive, at most `MAX_SPAN_DAYS` (a longer span: its first day only). */
function daysOf(from: string, to: string): string[] {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a)) return [];
  if (!Number.isFinite(b) || b < a || (b - a) / 86_400_000 >= MAX_SPAN_DAYS) return [from];
  const out: string[] = [];
  for (let t = a; t <= b; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** One user's graph. Held by the user's cache entry (`ItemCache`), so it is keyed, bounded and dropped with it. */
export class UserGraph {
  readonly nodes = new Map<string, GNode>();
  private readonly placed = new Map<string, Placed>();
  /** Items with long spans (`Extraction.long`), scanned by a walk from days: at most one entry per cached item. */
  private readonly long = new Map<string, { from: string; to: string }[]>();
  /** Learned evidence per edge type: Beta(alpha, beta) of "an item reached by this type was delivered and used". */
  private readonly alpha = new Float64Array(N_TYPES).fill(2);
  private readonly beta = new Float64Array(N_TYPES).fill(2);

  get size(): number {
    return this.nodes.size;
  }

  /** Puts an item in the graph, replacing what an earlier copy of it put there. */
  add(item: ContextItem, now: number): void {
    if (this.placed.has(item.id)) this.remove(item.id);
    const x = extract(item, now);
    const placed: Placed = { nodes: [], links: [], authors: x.authors, automated: x.automated, bound: x.bound };
    for (const [key, n] of x.nodes) {
      let node = this.nodes.get(key);
      if (!node) {
        if (this.nodes.size >= MAX_NODES) continue;
        node = { kind: n.kind, label: n.label, items: new Map(), links: new Map() };
        this.nodes.set(key, node);
      } else if (n.kind === "name" && /\s/.test(n.label) && !/\s/.test(node.label)) node.label = n.label;
      node.items.set(item.id, (node.items.get(item.id) ?? 0) | n.mask);
      placed.nodes.push(key);
    }
    for (const [a, b, mask] of x.links) {
      const na = this.nodes.get(a);
      const nb = this.nodes.get(b);
      if (!na || !nb) continue;
      if (!this.bump(na, b, mask) || !this.bump(nb, a, mask)) continue;
      placed.links.push([a, b, mask]);
    }
    this.placed.set(item.id, placed);
    if (x.long.length > 0) this.long.set(item.id, x.long);
  }

  /** Adds one statement of a link; false when the node is full (then nothing is added on either side). */
  private bump(node: GNode, other: string, mask: number): boolean {
    const l = node.links.get(other);
    if (l) {
      l.mask |= mask;
      l.n++;
      return true;
    }
    if (node.links.size >= MAX_LINKS) return false;
    node.links.set(other, { mask, n: 1 });
    return true;
  }

  /** Takes an item out: its edges, the links it stated, and nodes nothing else holds. */
  remove(id: string): void {
    const p = this.placed.get(id);
    if (!p) return;
    this.placed.delete(id);
    this.long.delete(id);
    for (const [a, b] of p.links) {
      for (const [x, y] of [
        [a, b],
        [b, a],
      ] as const) {
        const node = this.nodes.get(x);
        const l = node?.links.get(y);
        if (l && --l.n <= 0) node!.links.delete(y);
      }
    }
    for (const key of p.nodes) {
      const node = this.nodes.get(key);
      if (!node) continue;
      node.items.delete(id);
      if (node.items.size === 0 && node.links.size === 0) this.nodes.delete(key);
    }
    // A node kept only by a link whose last item just left: gone with it.
    for (const [a, b] of p.links) {
      for (const k of [a, b]) {
        const node = this.nodes.get(k);
        if (node && node.items.size === 0 && node.links.size === 0) this.nodes.delete(k);
      }
    }
  }

  /** The learned multiplier of an edge type: its posterior mean over the prior's (0.5), between 0.25 and 2. */
  factor(t: number): number {
    const mean = this.alpha[t]! / (this.alpha[t]! + this.beta[t]!);
    return Math.min(2, Math.max(0.25, mean / 0.5));
  }

  /** The weight of an edge mask: its strongest type's prior times the learned factor, plus a constrains bonus. */
  private weightOf(mask: number): number {
    let best = 0;
    for (let t = 0; t < N_TYPES; t++) {
      if (!(mask & (1 << t)) || t === EDGE.constrains) continue;
      best = Math.max(best, PRIOR[TYPES[t]!] * this.factor(t));
    }
    // What constrains something is what the conflict test can use: it ranks first among a name's many items.
    if (mask & bit("constrains")) best = Math.max(best, 0.5) * (1 + PRIOR.constrains * this.factor(EDGE.constrains));
    return best;
  }

  /**
   * Learns from an outcome: the item(s) reached through these edge types were delivered and then used (or not). A
   * cheap Beta update per type, with the evidence decaying (0.995 per update) so a user's habits can change.
   */
  learn(mask: number, used: boolean): void {
    for (let t = 0; t < N_TYPES; t++) {
      this.alpha[t] = 2 + (this.alpha[t]! - 2) * 0.995;
      this.beta[t] = 2 + (this.beta[t]! - 2) * 0.995;
      if (!(mask & (1 << t))) continue;
      if (used) this.alpha[t]! += 1;
      else this.beta[t]! += 1;
    }
  }

  /**
   * Spreading activation from `seeds`: one hop of node links (a person to their organisation and first name, a first
   * name to the people who go by it), then to items, each node's spread divided by log2(2 + its degree). A day seed
   * reaches only items that constrain it (an event that day is the cache's `timed` business). A node on more than
   * `HUB` items spreads nothing. Stops at `budgetMs`.
   */
  walk(seeds: Seed[], opt: WalkOptions): Walked[] {
    const t0 = performance.now();
    let steps = 0;
    const late = () => (++steps & 127) === 0 && performance.now() - t0 > opt.budgetMs;
    // Each activated node, its activation and the seed it came from: a node reached from two seeds keeps the larger.
    const act = new Map<string, { a: number; origin: string }>();
    const isSeed = new Set<string>();
    const banned = opt.exclude ?? new Set<string>();
    for (const s of seeds) {
      if (!this.nodes.has(s.key) || banned.has(s.key) || (act.get(s.key)?.a ?? 0) >= s.weight) continue;
      if (s.parent && this.nodes.has(s.parent)) continue;
      act.set(s.key, { a: s.weight, origin: s.key });
      isSeed.add(s.key);
    }
    /** Nodes one link from a seed whose seed is no hub: their items' authors speak for what the request names. */
    const near = new Set<string>(isSeed);
    // Two hops of links: a first name to the person, the person to their organisation ("Ingrid" to Ingrid Berg to
    // Globex), each hop weaker.
    // A word of a longer name seeds its own items only: "Sam" of an unknown "Sam Ortiz" is not every Sam.
    const words = new Set(seeds.filter((s) => s.parent).map((s) => s.key));
    let frontier = [...isSeed].filter((k) => !words.has(k));
    for (let hop = 1; hop <= LINK_HOPS && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const key of frontier) {
        const node = this.nodes.get(key)!;
        const from = act.get(key)!;
        // A person's few links (addresses, first name, organisation) each carry them whole; an organisation's many
        // people share its activation.
        const fan = node.links.size > 12 ? Math.sqrt(node.links.size) : 1;
        for (const [other, l] of node.links) {
          if (late()) break;
          // A first name several people go by stands for each of them only in part ("Sam": Sam Patel or Sam Ortiz).
          const shared = l.mask & bit("alias") ? Math.max(1, this.peopleCalled(key), this.peopleCalled(other)) : 1;
          const w = ((from.a * this.weightOf(l.mask)) / fan / shared) * (hop === 1 ? 1 : HOP_DECAY);
          if (banned.has(other)) continue;
          if (w > (act.get(other)?.a ?? 0)) {
            if (!act.has(other)) next.push(other);
            act.set(other, { a: w, origin: from.origin });
          }
          // The seed's own names and addresses, or the person a role names: their items speak for the seed. An
          // organisation's members do not each speak for what the request asks of it.
          if (hop === 1 && l.mask & bit("alias") && node.links.size <= 12 && node.items.size <= HUB) near.add(other);
        }
      }
      frontier = next.filter((k) => this.nodes.has(k));
    }
    // An item's score from one seed is the best of the nodes that seed reached it through (a person's name, address
    // and first name are one person, not three votes); its scores from different seeds add up.
    const best = new Map<string, Map<string, number>>();
    const masks = new Map<string, number>();
    const via = new Map<string, string[]>();
    const viaName = new Set<string>();
    const binding = new Set<string>();
    const byRef = new Set<string>();
    for (const [key, { a, origin }] of act) {
      if (late()) break;
      const node = this.nodes.get(key);
      if (!node || node.items.size > HUB) continue;
      const spread = a / Math.log2(2 + node.items.size);
      for (const [id, mask] of node.items) {
        if (node.kind === "day" && !(mask & bit("constrains"))) continue;
        const s = spread * this.weightOf(mask);
        const per = best.get(id) ?? new Map<string, number>();
        if (s > (per.get(origin) ?? 0)) per.set(origin, s);
        best.set(id, per);
        masks.set(id, (masks.get(id) ?? 0) | mask | (isSeed.has(key) ? 0 : this.linkMask(key, isSeed)));
        const v = via.get(id) ?? [];
        if (v.length < 6 && !v.includes(node.label)) v.push(node.label);
        via.set(id, v);
        if (node.kind !== "day") viaName.add(id);
        if (mask & bit("constrains")) binding.add(id);
        if (node.kind === "id" && isSeed.has(key)) byRef.add(id);
      }
    }
    // Days a long span covers: the items holding such spans, scanned (one per cached item at most), each covering
    // span's spread divided like a day node's by how many cover the day.
    for (const s of seeds) {
      if (!s.key.startsWith("d:") || this.long.size === 0) continue;
      const day = s.key.slice(2);
      const covering: string[] = [];
      for (const [id, spans] of this.long) {
        if (late()) break;
        if (spans.some((sp) => sp.from <= day && day <= sp.to)) covering.push(id);
      }
      const spread = (s.weight / Math.log2(2 + covering.length)) * this.weightOf(bit("constrains"));
      for (const id of covering) {
        const per = best.get(id) ?? new Map<string, number>();
        if (spread > (per.get(s.key) ?? 0)) per.set(s.key, spread);
        best.set(id, per);
        masks.set(id, (masks.get(id) ?? 0) | bit("constrains"));
        const v = via.get(id) ?? [];
        if (v.length < 6 && !v.includes(day)) v.push(day);
        via.set(id, v);
        binding.add(id);
      }
    }
    const out: Walked[] = [];
    for (const [id, per] of best) {
      let s = 0;
      for (const x of per.values()) s += x;
      if (s < opt.floor) continue;
      const authors = this.placed.get(id)?.authors ?? [];
      out.push({
        id,
        score: s,
        mask: masks.get(id)!,
        via: via.get(id)!,
        speaks: authors.some((k) => near.has(k)),
        named: viaName.has(id),
        binds: binding.has(id) || (this.placed.get(id)?.bound ?? false),
        automated: this.placed.get(id)?.automated ?? false,
        byRef: byRef.has(id),
      });
    }
    return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, opt.limit);
  }

  /**
   * The user's own neighbourhood: their name's node and the nodes it links to (addresses, first name, the
   * organisation their address is at), to keep out of every walk: they are on nearly everything the user holds.
   */
  around(key: string): Set<string> {
    const out = new Set<string>();
    const node = this.nodes.get(key);
    if (!node) return out;
    out.add(key);
    for (const [other, l] of node.links) if (l.mask & (bit("alias") | bit("member"))) out.add(other);
    return out;
  }

  /** For a one-word name (a first name), how many people go by it: its alias links to other names; else 0. */
  private peopleCalled(key: string): number {
    const node = this.nodes.get(key);
    if (!node || node.kind !== "name" || /\s/.test(node.label)) return 0;
    let n = 0;
    for (const [other, l] of node.links) if (l.mask & bit("alias") && other.startsWith("n:")) n++;
    return n;
  }

  /** The link types by which a non-seed node was reached from the seeds (for learning). */
  private linkMask(key: string, seeds: Set<string>): number {
    let mask = 0;
    const node = this.nodes.get(key);
    if (!node) return 0;
    for (const s of seeds) mask |= node.links.get(s)?.mask ?? 0;
    return mask;
  }

  /** Whether a node exists (for tests and for seeding only names the user's items know). */
  has(key: string): boolean {
    return this.nodes.has(key);
  }
}

/** Seeds for a request: its names (and their capitalised runs), identifiers, roles and days, as node keys. */
export function seedsOf(
  raw: string,
  entities: string[],
  days: Iterable<string>,
  roles: string[] = rolesOf(raw),
): Seed[] {
  const out = new Map<string, number>();
  const parents = new Map<string, string>();
  const put = (key: string, w: number) => {
    if (key.length > 2 && (out.get(key) ?? 0) < w) out.set(key, w);
  };
  const text = raw.slice(0, 2_000);
  for (const e of entities) {
    if (/@/.test(e)) put(`e:${e.toLowerCase()}`, 1);
    else put(nameKey(e), 1);
  }
  // Sentence-start names too ("Hana needs the renewal signed"): a run is a seed only if the user's items name it.
  for (const run of runsOf(text, 16)) {
    put(nameKey(run), 1);
    // "Hooli RFP" may be no node where "Hooli" is: each word of a longer run, weaker.
    const words = run.split(/\s+/);
    if (words.length > 1) {
      for (const w of words) {
        const key = nameKey(w);
        if (w.length >= 3 && /^\p{Lu}/u.test(w) && !out.has(key)) parents.set(key, nameKey(run));
        if (w.length >= 3 && /^\p{Lu}/u.test(w)) put(key, 0.5);
      }
    }
  }
  for (const m of text.matchAll(/\b([A-Za-z]{2,6})-(\d{2,9})\b/g)) {
    if (!NOT_ID.test(m[1]!.toUpperCase())) put(`i:${m[1]!.toLowerCase()}-${m[2]}`, 1.2);
  }
  for (const r of roles) if (PERSON_ROLES.has(r)) put(`r:${r}`, 0.8);
  for (const d of days) put(`d:${d}`, 0.6);
  return [...out].map(([key, weight]) => {
    const parent = weight < 1 ? parents.get(key) : undefined;
    return parent ? { key, weight, parent } : { key, weight };
  });
}

/** Lower-case words of node labels (for the conflict test's ties): "Umbrella Health" is "umbrella" and "health". */
export function tieWords(labels: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const l of labels) {
    // Days, channels and addresses tie nothing a statement says ("ai" of "jen@wayneanalytics.ai").
    if (/^\d{4}-\d{2}-\d{2}$/.test(l) || l.startsWith("#") || l.includes("@")) continue;
    // As `conflict.ts` reads a statement's words: lower case, ASCII letters first.
    for (const w of l.toLowerCase().match(/[a-z][a-z0-9'-]{1,}/g) ?? []) out.add(w);
  }
  return out;
}

/** Edge type names of a mask (for traces and tests). */
export function typesOf(mask: number): EdgeType[] {
  return TYPES.filter((t) => mask & bit(t));
}
