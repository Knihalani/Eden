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
/**
 * Characters of an item's text read (its title and `meta.people` are read on their own): what names it and
 * constrains it comes early. 1,000, not 4,000 (D150): on `ingest.bench.ts` the graph's per-item backfill fell 2.1-2.3x
 * and its heap 37%, and every train screen (stub funnel, Haiku reader replay, eval) was the same task by task
 * (docs/research/graph-ablation.md, stage 2).
 */
const READ_CHARS = 1_000;
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

/** An item's flags in the graph: sent by a system (`AUTOMATED`); a sentence of it constrains something. */
const AUTOMATED_FLAG = 1;
const BOUND_FLAG = 2;

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
export function squash(s: string): string {
  const lower = s.toLowerCase();
  // ASCII (most names, every domain): the same result without the Unicode-class pattern.
  let ascii = true;
  let clean = true;
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charCodeAt(i);
    if (c >= 128) {
      ascii = false;
      break;
    }
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) clean = false;
  }
  if (ascii && clean) return lower;
  if (ascii) return (lower.endsWith("'s") ? lower.slice(0, -2) : lower).replace(/[^a-z0-9]/g, "");
  return lower.replace(/['’]s$/u, "").replace(/[^\p{L}\p{N}]/gu, "");
}

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
    if (run.length === 0) return;
    // Dates and common words around a name are not part of it ("on Friday Dana Lee", "Hi Robin"), nor is a number
    // left at either end ("Mon 26 Oct" is no name).
    while (run.length > 0 && leads(run[0]!)) {
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
      let name = run.length === 1 ? run[0]! : run.join(" ");
      if (name.length > 1 && name.endsWith("s") && (name.at(-2) === "'" || name.at(-2) === "’")) {
        name = name.slice(0, -2);
      }
      if (!skip && name.length <= 80 && !out.includes(name)) out.push(name);
    }
    run = [];
  };
  // One pass over the words of a name (a letter or digit of any script, then up to 40 more code points of letters,
  // digits and & ' ’ . -, as /[\p{L}\p{N}][\p{L}\p{N}&'’.-]{0,40}/u reads them), scanned by character code: this runs
  // on every sentence of every item cached, and a regex match per word allocated an array each.
  for (let i = 0; i < text.length;) {
    const c = codeAt(text, i);
    if (!isWordStart(c)) {
      i += c > 0xffff ? 2 : 1;
      continue;
    }
    const at = i;
    i += c > 0xffff ? 2 : 1;
    for (let more = 0; more < 40 && i < text.length; more++) {
      const d = codeAt(text, i);
      if (!isWordPart(d)) break;
      i += d > 0xffff ? 2 : 1;
    }
    if (out.length >= max) break;
    // Joined to the run when only spaces and tabs come between; a new sentence after . ! ? : or a line break.
    let joined = false;
    let boundary = false;
    if (lastEnd >= 0 && at > lastEnd) {
      joined = true;
      for (let k = lastEnd; k < at; k++) {
        const b = text.charCodeAt(k);
        if (b !== 32 && b !== 9) joined = false;
        if (b === 46 || b === 33 || b === 63 || b === 58 || b === 10) boundary = true;
      }
    }
    if (!joined) {
      flush();
      if (lastEnd < 0 || boundary) sentenceStart = true;
    }
    const cap = c < 128 ? c >= 65 && c <= 90 : UPPER_START.test(text.slice(at, i));
    const num = c < 128 ? c >= 48 && c <= 57 : NUMBER_START.test(text.slice(at, i));
    if (cap || (num && run.length > 0)) {
      if (run.length === 0) runStart = sentenceStart;
      // Trailing dots, apostrophes and hyphens are not part of the word ("Lee.", "Hooli's'").
      let cut = i;
      while (cut > at + 1 && isTrail(text.charCodeAt(cut - 1))) cut--;
      if (run.length < 4) run.push(text.slice(at, cut));
    } else flush();
    // A word ending in a full stop ends a sentence, unless it is an initial ("U.S.", "J.").
    if (text.charCodeAt(i - 1) !== 46) sentenceStart = false;
    else {
      const prev = text.charCodeAt(i - 2);
      sentenceStart = prev < 128 ? !(prev >= 65 && prev <= 90) : !UPPER_BEFORE_DOT.test(text.slice(at, i));
    }
    lastEnd = i;
  }
  flush();
  return out;
}

/** Characters stripped from a word's end, and the tests `runsOf` reads outside ASCII. */
const isTrail = (c: number) => c === 46 || c === 39 || c === 0x2019 || c === 45;
/** The code point at `i`: a code unit, or a surrogate pair's code point. */
function codeAt(s: string, i: number): number {
  const c = s.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff ? s.codePointAt(i)! : c;
}
/** Whether a run's first word is no part of a name (`runsOf`): a common capital, a request verb, a number. */
function leads(w: string): boolean {
  const lower = w.toLowerCase();
  return COMMON_CAPS.has(lower) || LEADING.has(lower) || startsNumber(w);
}
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
/** `LETTER_OR_DIGIT` per code unit of the basic plane, read once each: 0 not yet, 1 yes, 2 no. */
const LN_CLASS = new Uint8Array(0x10000);
function isWordStart(cp: number): boolean {
  if (cp < 128) return (cp >= 97 && cp <= 122) || (cp >= 65 && cp <= 90) || (cp >= 48 && cp <= 57);
  if (cp > 0xffff) return LETTER_OR_DIGIT.test(String.fromCodePoint(cp));
  if (LN_CLASS[cp] === 0) LN_CLASS[cp] = LETTER_OR_DIGIT.test(String.fromCharCode(cp)) ? 1 : 2;
  return LN_CLASS[cp] === 1;
}
/** A code point a word goes on with: a letter, a digit, or & ' ’ . - */
const isWordPart = (cp: number) => cp === 38 || cp === 39 || cp === 46 || cp === 45 || cp === 0x2019 || isWordStart(cp);
const UPPER_START = /^\p{Lu}/u;
const NUMBER_START = /^\p{N}/u;
const UPPER_BEFORE_DOT = /\p{Lu}\.$/u;
const startsNumber = (w: string) => {
  const c = w.charCodeAt(0);
  return c < 128 ? c >= 48 && c <= 57 : NUMBER_START.test(w);
};

/** Sentences (and people) a user's graph remembers reading (`UserGraph`), at most. */
const MEMO_SENTENCES = 256;

/**
 * What one sentence says for the graph, apart from the item it is in and the day it is read on (`parseSentence`).
 * Shared by every item that says the sentence: read only.
 */
export interface Parsed {
  /** It blocks, moves or settles something (`conflict.ts` `constrains`). */
  binding: boolean;
  /** Its capitalised runs (`runsOf`), as pairs: node key, then the run as written. */
  readonly runs: readonly string[];
  /** Its identifiers ("inv-7174") and account numbers. */
  readonly ids: readonly string[];
  readonly accounts: readonly string[];
  /** The roles it names as someone's, as pairs: the role, then the name written just before it or null. */
  readonly roles: readonly (string | null)[];
  /** The sentence in lower case (read for dates when it binds), and whether it states an expiry. */
  lower: string;
  expiry: boolean;
}

const NONE: readonly never[] = Object.freeze([]);

/** Reads one sentence (`Parsed`): its names, identifiers and roles, and whether it constrains anything. */
function parseSentence(raw: string, inTitle: boolean): Parsed {
  const lower = raw.toLowerCase();
  const binding = raw.length >= 3 && constrains(lower);
  const runs: string[] = [];
  for (const run of runsOf(raw, 12, inTitle)) runs.push(nameKey(run), run);
  const ids: string[] = [];
  for (const m of allOf(IDENT, raw)) if (!NOT_ID.test(m[1]!)) ids.push(`${m[1]!.toLowerCase()}-${m[2]}`);
  const accounts: string[] = [];
  for (const m of allOf(IBAN, raw)) {
    const id = m[1]!.replace(/\s/g, "").toLowerCase();
    if (id.length >= 14) accounts.push(id);
  }
  const roles: (string | null)[] = [];
  for (const m of allOf(ROLE_AT, lower)) {
    const role = (m[1] ?? m[2])!;
    if (!PERSON_ROLES.has(role)) continue;
    // (Read from the sentence as written, at the same place: lower-casing kept its length, or it is not read.)
    const before = raw.slice(Math.max(0, m.index! - 40), m.index!);
    const named = lower.length === raw.length ? NAME_BEFORE.exec(before) : null;
    roles.push(role, named ? named[1]!.trim() : null);
  }
  // Most lists are empty: one shared empty list keeps a remembered sentence small.
  const or = <T>(xs: T[]): readonly T[] => (xs.length > 0 ? xs : NONE);
  return {
    binding,
    runs: or(runs),
    ids: or(ids),
    accounts: or(accounts),
    roles: or(roles),
    lower: binding ? lower : "",
    expiry: binding && EXPIRY.test(lower),
  };
}

const NO_MATCHES: RegExpExecArray[] = [];

/**
 * Every match of one of this file's global patterns, as `matchAll` gives them, without its copy of the pattern and
 * iterator per call (`extract` reads several patterns per sentence). Collected first, so the loop over them may use
 * any pattern; none of these matches an empty string.
 */
function allOf(re: RegExp, s: string): RegExpExecArray[] {
  re.lastIndex = 0;
  let m = re.exec(s);
  if (m === null) return NO_MATCHES;
  const out: RegExpExecArray[] = [];
  for (; m !== null; m = re.exec(s)) out.push(m);
  re.lastIndex = 0;
  return out;
}

/** What `parsePerson` reads from a name and an address: the keys and labels a person puts in the graph. */
export interface ParsedPerson {
  /** The person's name node (null when the words name no one) and the name as written. */
  key: string | null;
  full: string;
  /** Their first name's node, when the name has two words or more, and the first name. */
  firstKey: string | null;
  first: string;
  /** Their address's node ("e:" and the address in lower case), the organisation its domain names, a system's. */
  at: string | null;
  org: string | null;
  automated: boolean;
}

/** Reads a person's name and address (`ParsedPerson`); `extract` adds what it names, in its order. */
function parsePerson(name: string, email: { local: string; domain: string } | null): ParsedPerson {
  const words = name.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && COMMON_CAPS.has(words[0]!.toLowerCase())) words.shift();
  const one = words.length === 1 ? words[0]!.toLowerCase() : "";
  const isName = words.length >= 1 && (one === "" || !(isStopword(one) || ROLES.has(one) || one.length < 2));
  const full = isName ? words.join(" ") : "";
  return {
    key: isName ? nameKey(full) : null,
    full,
    firstKey: isName && words.length >= 2 ? nameKey(words[0]!) : null,
    first: isName && words.length >= 2 ? words[0]! : "",
    at: email ? `e:${email.local.toLowerCase()}@${email.domain.toLowerCase()}` : null,
    org: email ? orgLabel(email.domain) : null,
    automated: email !== null && AUTOMATED.test(email.local),
  };
}

/** What a user's graph remembers reading (`extract`): sentences and people, while every item that said them stays. */
export interface Memo {
  sentences: Map<string, Parsed>;
  people: Map<string, ParsedPerson>;
}

/** Remembers one reading, forgetting the oldest past `MEMO_SENTENCES`. */
function remember<T>(memo: Map<string, T>, key: string, value: T): void {
  if (memo.size >= MEMO_SENTENCES) memo.delete(memo.keys().next().value!);
  memo.set(key, value);
}

/**
 * What an item puts in the graph (`Extraction`). `now` resolves the year of a day written without one. Linear in the
 * item's head (`READ_CHARS`); at most `MAX_NODES_PER_ITEM` nodes. `memo` (the user's graph's) holds sentences already
 * read: the same result, without reading them again.
 */
export function extract(item: ContextItem, now: number, memo?: Memo): Extraction {
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
    // A name and address many items carry (a sender, a colleague) are read once per user while their items stay.
    const memoKey = memo ? (email ? `${name}\u0000${email.local}@${email.domain}` : name) : "";
    let p = memo?.people.get(memoKey);
    if (!p) {
      p = parsePerson(name, email);
      if (memo) remember(memo.people, memoKey, p);
    }
    const key = p.key;
    if (key !== null) {
      add(key, "name", p.full, type);
      if (type === "authored") {
        authors.push(key);
        authorNames.push(p.full);
      }
      if (p.firstKey !== null) {
        // A first name links to the person: "Łukasz" in a chat is Łukasz Nowak when the user's items say so.
        add(p.firstKey, "name", p.first, type);
        link(key, p.firstKey, "alias");
      }
    }
    if (p.at !== null) {
      add(p.at, "email", p.at.slice(2), type);
      if (type === "authored") authors.push(p.at);
      if (type === "authored" && p.automated) automated = true;
      if (key !== null) link(key, p.at, "alias");
      if (p.org !== null) {
        const orgKey = `n:${p.org}`;
        add(orgKey, "name", p.org, "mentions");
        link(key ?? p.at, orgKey, "member");
      }
    }
  };
  /** The people of a text: each address with the name written just before it, then names with no address. */
  const people = (value: string, type: EdgeType, bare: boolean) => {
    let found = false;
    for (const m of allOf(EMAIL, value)) {
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
  const parties = allOf(PARTY, body);
  for (const m of parties) {
    const field = m[1]!.toLowerCase();
    people(m[2]!, /^(from|owner|organi)/.test(field) ? "authored" : "attended", true);
  }
  if (item.meta?.people) people(item.meta.people.slice(0, 1_000), "attended", true);
  // (With no header line, the text without them is the text: no copy.)
  people(parties.length > 0 ? body.replace(PARTY, "") : body, "mentions", false);
  // Chat speakers, and the channel a chat item is in.
  const channel = /^#([\p{L}\p{N}_-]{2,40})/u.exec(title);
  const chat = channel !== null || /^dm\b/i.test(title);
  for (const m of allOf(SPEAKER, body)) if (m[1] || chat) person(m[2]!, null, "authored");
  if (channel) add(`c:#${channel[1]!.toLowerCase()}`, "channel", `#${channel[1]!.toLowerCase()}`, "channel");
  // Sentences that block, move or settle something constrain what they name and the days they cover.
  const sentences = `${title}.\n${body}`.split(/[.!?;]+\s|\n+/);
  let bound = false;
  for (const raw of sentences) {
    const inTitle = raw.trim().length > 2 && title.includes(raw.trim());
    // A sentence many items share (a greeting, a sign-off, a footer) is read once per user while its items stay.
    let p = inTitle || !memo ? undefined : memo.sentences.get(raw);
    if (!p) {
      p = parseSentence(raw, inTitle);
      if (!inTitle && memo) remember(memo.sentences, raw, p);
    }
    const binding = p.binding;
    bound ||= binding;
    // A title's first word is its subject as often as not ("Globex — account", "Hooli supplier tender").
    for (let k = 0; k < p.runs.length; k += 2) {
      add(p.runs[k]!, "name", p.runs[k + 1]!, inTitle ? "about" : "mentions");
      if (binding) add(p.runs[k]!, "name", p.runs[k + 1]!, "constrains");
    }
    for (const id of p.ids) {
      add(`i:${id}`, "id", id, "ref");
      if (binding) add(`i:${id}`, "id", id, "constrains");
    }
    for (const id of p.accounts) add(`i:${id}`, "id", id, "ref");
    for (let k = 0; k < p.roles.length; k += 2) {
      const role = p.roles[k]!;
      add(`r:${role}`, "role", role, binding ? "constrains" : "role");
      // The person the role is someone's: the name just before it, the item's author when that is their first name.
      const name = p.roles[k + 1];
      if (name !== null) {
        const full = authorNames.find((a) => a === name || a.split(" ")[0] === name);
        link(nameKey(full ?? name!), `r:${role}`, "alias");
      }
    }
    if (binding) {
      const d = datesIn(p.lower, now);
      for (const sp of d.spans) {
        // A span too long to link day by day ("pausing headcount from 19 Oct until Q1") is kept whole (`long`).
        if (daysBetween(sp.from, sp.to) >= MAX_SPAN_DAYS) {
          if (long.length < MAX_LONG) long.push(sp);
        } else for (const day of daysOf(sp.from, sp.to)) add(`d:${day}`, "day", day, "constrains");
      }
      // A deadline ("the slip by Monday 2 Nov") binds what it is about, not every day before it. An expiry binds every
      // day after it: "passport expires 2 Nov" constrains a trip on the 21st.
      if (p.expiry) {
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

/**
 * The graph's storage is compact (D58 held a Map per node for its items and another for its links, and every item's
 * node keys and links again as strings: 2.2 KB per item over realistic mail). Node keys are interned to small integer
 * ids and items to slots; a node's items and links are packed words in typed arrays, (item slot or node id) shifted
 * past the edge mask; what one item placed is one `Int32Array`. Orders are kept as the Maps kept them (appended,
 * removed in place), so a walk visits what it visited before in the same order.
 */
const MASK_BITS = N_TYPES;
const MASK = (1 << MASK_BITS) - 1;
/** Item slots and node ids stay below this, so a packed word stays a positive 32-bit integer. */
const MAX_INDEX = 1 << (31 - MASK_BITS);
/** In an item's placed links: the link went on both nodes (else only the first's: the second was full). */
const BOTH = 1 << MASK_BITS;
const EMPTY = new Int32Array(0);
const KINDS: Record<string, NodeKind> = { n: "name", e: "email", i: "id", c: "channel", r: "role", d: "day" };
const ALIAS = bit("alias");
const CONSTRAINS = bit("constrains");

class GNode {
  /**
   * Whether the node is in the graph. A node out of it keeps its id (and key) while a link or an item's author still
   * names it, so a key never has two ids and an id never two keys.
   */
  live = false;
  /** Its items: (item slot << MASK_BITS | edge mask), in the order they came; `ni` used. */
  items: Int32Array = EMPTY;
  ni = 0;
  /** Its links to other nodes: pairs (node id << MASK_BITS | mask, items stating it), in the order they came. */
  links: Int32Array = EMPTY;
  /** Links used (pairs). A link is kept while some item still states it. */
  nl = 0;
  /** Links on other nodes and items' authors that name this node's id. */
  refs = 0;
  /** The node's name as first seen written (for ties): "Umbrella Health", "inv-7174", "#legal", "2026-10-29". */
  label: string;
  kind: NodeKind;
  readonly key: string;
  constructor(key: string, kind: NodeKind, label: string) {
    this.key = key;
    this.kind = kind;
    this.label = label;
  }
}

/** Scratch for `add` (one graph is built at a time: no await inside). */
const scratchNodes: number[] = [];
const scratchLinks: number[] = [];
const scratchAuthors: number[] = [];

/** `xs` with room for `n` more words, doubled when full. */
function room(xs: Int32Array, used: number, n: number): Int32Array {
  if (used + n <= xs.length) return xs;
  const grown = new Int32Array(Math.max(4, xs.length * 2, used + n));
  grown.set(xs.subarray(0, used));
  return grown;
}

/** `xs` halved when at most a quarter is used (an item churned off a busy node gives its room back). */
function shrink(xs: Int32Array, used: number): Int32Array {
  return xs.length > 8 && used <= xs.length >> 2 ? xs.slice(0, xs.length >> 1) : xs;
}

/** One user's graph. Held by the user's cache entry (`ItemCache`), so it is keyed, bounded and dropped with it. */
export class UserGraph {
  /** Node key → id, for every node in the graph and every id still named (`GNode.live`). */
  private readonly ids = new Map<string, number>();
  private readonly nodeAt: (GNode | undefined)[] = [];
  private readonly freeIds: number[] = [];
  private liveNodes = 0;
  /** Item id → slot, and per slot: the id, what it placed, its flags (`AUTOMATED_FLAG`, `BOUND_FLAG`). */
  private readonly slots = new Map<string, number>();
  private readonly itemAt: (string | undefined)[] = [];
  /**
   * What each item placed, to take it out again: [nodes n, links n, its node ids…, its links as (a, b, mask | BOTH)
   * triples…, its authors' node ids (From, organiser, owner, chat speaker)…].
   */
  private readonly placedAt: (Int32Array | undefined)[] = [];
  private flags = new Uint8Array(64);
  private readonly freeSlots: number[] = [];
  /** Items with long spans (`Extraction.long`), by slot, scanned by a walk from days: at most one entry an item. */
  private readonly long = new Map<number, { from: string; to: string }[]>();
  /**
   * Sentences and people read lately (`parseSentence`, `parsePerson`, at most `MEMO_SENTENCES` each): emptied whenever
   * an item leaves, so it never holds what only an item the graph no longer holds said.
   */
  private readonly memo: Memo = { sentences: new Map(), people: new Map() };
  /** Learned evidence per edge type: Beta(alpha, beta) of "an item reached by this type was delivered and used". */
  private readonly alpha = new Float64Array(N_TYPES).fill(2);
  private readonly beta = new Float64Array(N_TYPES).fill(2);

  /** `maxIds`: node ids held at most (`MAX_INDEX`; a test passes fewer to reach the bound). */
  constructor(private readonly maxIds = MAX_INDEX) {}

  get size(): number {
    return this.liveNodes;
  }

  /** Whether a node exists (for tests and for seeding only names the user's items know). */
  has(key: string): boolean {
    return this.liveId(key) >= 0;
  }

  /** The keys of the nodes in the graph (for tests). */
  keys(): string[] {
    const out: string[] = [];
    for (const n of this.nodeAt) if (n?.live) out.push(n.key);
    return out;
  }

  /** A node's id when it is in the graph, else -1. */
  private liveId(key: string): number {
    const id = this.ids.get(key);
    return id !== undefined && this.nodeAt[id]!.live ? id : -1;
  }

  /** The id of `key`, made (out of the graph) if it has none. */
  private intern(key: string, kind: NodeKind, label: string): number {
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const id = this.freeIds.pop() ?? this.nodeAt.length;
    this.nodeAt[id] = new GNode(key, kind, label);
    this.ids.set(key, id);
    return id;
  }

  /** Frees an id that is out of the graph and named by nothing. */
  private release(id: number): void {
    const node = this.nodeAt[id]!;
    if (node.live || node.refs > 0) return;
    this.ids.delete(node.key);
    this.nodeAt[id] = undefined;
    this.freeIds.push(id);
  }

  /** Takes a node out of the graph when nothing holds it: no item and no link. */
  private settle(id: number): void {
    const node = this.nodeAt[id];
    if (!node?.live || node.ni > 0 || node.nl > 0) return;
    node.live = false;
    this.liveNodes--;
    this.release(id);
  }

  /** Puts an item in the graph, replacing what an earlier copy of it put there. */
  add(item: ContextItem, now: number): void {
    const x = extract(item, now, this.memo);
    // A packed word must stay an int32: ids in use and every id this item could intern (its nodes, and its authors,
    // which neither `MAX_NODES` nor `MAX_NODES_PER_ITEM` bounds) stay under `maxIds`, slots under `MAX_INDEX`. Checked
    // before an earlier copy leaves: a copy refused here leaves the one held.
    if (this.nodeAt.length - this.freeIds.length + x.nodes.size + x.authors.length > this.maxIds) return;
    const replacing = this.slots.has(item.id);
    if (!replacing && this.freeSlots.length === 0 && this.itemAt.length >= MAX_INDEX) return;
    if (replacing) this.remove(item.id);
    const slot = this.freeSlots.pop() ?? this.itemAt.length;
    const nodes = scratchNodes;
    const links = scratchLinks;
    const authors = scratchAuthors;
    nodes.length = links.length = authors.length = 0;
    for (const [key, n] of x.nodes) {
      let id = this.ids.get(key);
      let node = id === undefined ? undefined : this.nodeAt[id]!;
      if (!node?.live) {
        if (this.liveNodes >= MAX_NODES) continue;
        id ??= this.intern(key, n.kind, n.label);
        node = this.nodeAt[id]!;
        node.kind = n.kind;
        node.label = n.label;
        node.live = true;
        this.liveNodes++;
      } else if (n.kind === "name" && /\s/.test(n.label) && !/\s/.test(node.label)) node.label = n.label;
      node.items = room(node.items, node.ni, 1);
      node.items[node.ni++] = (slot << MASK_BITS) | n.mask;
      nodes.push(id!);
    }
    for (const [a, b, mask] of x.links) {
      const ia = this.liveId(a);
      const ib = this.liveId(b);
      if (ia < 0 || ib < 0 || !this.bump(ia, ib, mask)) continue;
      links.push(ia, ib, this.bump(ib, ia, mask) ? mask | BOTH : mask);
    }
    for (const k of x.authors) {
      const id = this.intern(k, KINDS[k[0]!] ?? "name", "");
      this.nodeAt[id]!.refs++;
      authors.push(id);
    }
    const placed = new Int32Array(2 + nodes.length + links.length + authors.length);
    placed[0] = nodes.length;
    placed[1] = links.length / 3;
    placed.set(nodes, 2);
    placed.set(links, 2 + nodes.length);
    placed.set(authors, 2 + nodes.length + links.length);
    if (slot >= this.flags.length) {
      const grown = new Uint8Array(this.flags.length * 2);
      grown.set(this.flags);
      this.flags = grown;
    }
    this.flags[slot] = (x.automated ? AUTOMATED_FLAG : 0) | (x.bound ? BOUND_FLAG : 0);
    this.slots.set(item.id, slot);
    this.itemAt[slot] = item.id;
    this.placedAt[slot] = placed;
    if (x.long.length > 0) this.long.set(slot, x.long);
  }

  /** Adds one statement of a link from one node to another; false when the first is full (then nothing is added). */
  private bump(from: number, to: number, mask: number): boolean {
    const node = this.nodeAt[from]!;
    const l = node.links;
    for (let k = 0; k < node.nl * 2; k += 2) {
      if (l[k]! >> MASK_BITS !== to) continue;
      l[k]! |= mask;
      l[k + 1]!++;
      return true;
    }
    if (node.nl >= MAX_LINKS) return false;
    node.links = room(l, node.nl * 2, 2);
    node.links[node.nl * 2] = (to << MASK_BITS) | mask;
    node.links[node.nl * 2 + 1] = 1;
    node.nl++;
    this.nodeAt[to]!.refs++;
    return true;
  }

  /** Takes back one statement of a link from one node to another; the link goes with its last statement. */
  private unbump(from: number, to: number): void {
    const node = this.nodeAt[from]!;
    const l = node.links;
    for (let k = 0; k < node.nl * 2; k += 2) {
      if (l[k]! >> MASK_BITS !== to) continue;
      if (--l[k + 1]! > 0) return;
      l.copyWithin(k, k + 2, node.nl * 2);
      node.nl--;
      node.links = shrink(l, node.nl * 2);
      this.nodeAt[to]!.refs--;
      this.release(to);
      return;
    }
  }

  /** Takes an item out: its edges, the links it stated, and nodes nothing else holds. */
  remove(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    const p = this.placedAt[slot]!;
    this.memo.sentences.clear();
    this.memo.people.clear();
    this.slots.delete(id);
    this.long.delete(slot);
    this.itemAt[slot] = undefined;
    this.placedAt[slot] = undefined;
    this.freeSlots.push(slot);
    const nodesEnd = 2 + p[0]!;
    const linksEnd = nodesEnd + p[1]! * 3;
    for (let k = nodesEnd; k < linksEnd; k += 3) {
      this.unbump(p[k]!, p[k + 1]!);
      if (p[k + 2]! & BOTH) this.unbump(p[k + 1]!, p[k]!);
    }
    for (let k = 2; k < nodesEnd; k++) {
      const node = this.nodeAt[p[k]!]!;
      const xs = node.items;
      for (let i = 0; i < node.ni; i++) {
        if (xs[i]! >> MASK_BITS !== slot) continue;
        xs.copyWithin(i, i + 1, node.ni);
        node.ni--;
        node.items = shrink(xs, node.ni);
        break;
      }
      this.settle(p[k]!);
    }
    // A node kept only by a link whose last item just left: gone with it.
    for (let k = nodesEnd; k < linksEnd; k += 3) {
      this.settle(p[k]!);
      this.settle(p[k + 1]!);
    }
    for (let k = linksEnd; k < p.length; k++) {
      this.nodeAt[p[k]!]!.refs--;
      this.release(p[k]!);
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
    if (mask & CONSTRAINS) best = Math.max(best, 0.5) * (1 + PRIOR.constrains * this.factor(EDGE.constrains));
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
    const act = new Map<number, { a: number; origin: string }>();
    const isSeed = new Set<number>();
    const banned = new Set<number>();
    for (const k of opt.exclude ?? []) {
      const id = this.ids.get(k);
      if (id !== undefined) banned.add(id);
    }
    for (const s of seeds) {
      const id = this.liveId(s.key);
      if (id < 0 || banned.has(id) || (act.get(id)?.a ?? 0) >= s.weight) continue;
      if (s.parent && this.has(s.parent)) continue;
      act.set(id, { a: s.weight, origin: s.key });
      isSeed.add(id);
    }
    /** Nodes one link from a seed whose seed is no hub: their items' authors speak for what the request names. */
    const near = new Set<number>(isSeed);
    // Two hops of links: a first name to the person, the person to their organisation ("Ingrid" to Ingrid Berg to
    // Globex), each hop weaker.
    // A word of a longer name seeds its own items only: "Sam" of an unknown "Sam Ortiz" is not every Sam.
    const words = new Set(seeds.filter((s) => s.parent).map((s) => s.key));
    let frontier = [...isSeed].filter((id) => !words.has(this.nodeAt[id]!.key));
    for (let hop = 1; hop <= LINK_HOPS && frontier.length > 0; hop++) {
      const next: number[] = [];
      for (const key of frontier) {
        const node = this.nodeAt[key]!;
        const from = act.get(key)!;
        // A person's few links (addresses, first name, organisation) each carry them whole; an organisation's many
        // people share its activation.
        const fan = node.nl > 12 ? Math.sqrt(node.nl) : 1;
        for (let k = 0; k < node.nl * 2; k += 2) {
          if (late()) break;
          const other = node.links[k]! >> MASK_BITS;
          const mask = node.links[k]! & MASK;
          // A first name several people go by stands for each of them only in part ("Sam": Sam Patel or Sam Ortiz).
          const shared = mask & ALIAS ? Math.max(1, this.peopleCalled(key), this.peopleCalled(other)) : 1;
          const w = ((from.a * this.weightOf(mask)) / fan / shared) * (hop === 1 ? 1 : HOP_DECAY);
          if (banned.has(other)) continue;
          if (w > (act.get(other)?.a ?? 0)) {
            if (!act.has(other)) next.push(other);
            act.set(other, { a: w, origin: from.origin });
          }
          // The seed's own names and addresses, or the person a role names: their items speak for the seed. An
          // organisation's members do not each speak for what the request asks of it.
          if (hop === 1 && mask & ALIAS && node.nl <= 12 && node.ni <= HUB) near.add(other);
        }
      }
      frontier = next.filter((id) => this.nodeAt[id]?.live);
    }
    // An item's score from one seed is the best of the nodes that seed reached it through (a person's name, address
    // and first name are one person, not three votes); its scores from different seeds add up. Keyed by item slot.
    const best = new Map<number, Map<string, number>>();
    const masks = new Map<number, number>();
    const via = new Map<number, string[]>();
    const viaName = new Set<number>();
    const binding = new Set<number>();
    const byRef = new Set<number>();
    for (const [key, { a, origin }] of act) {
      if (late()) break;
      const node = this.nodeAt[key];
      if (!node?.live || node.ni > HUB) continue;
      const spread = a / Math.log2(2 + node.ni);
      const reached = isSeed.has(key) ? 0 : this.linkMask(key, isSeed);
      for (let k = 0; k < node.ni; k++) {
        const slot = node.items[k]! >> MASK_BITS;
        const mask = node.items[k]! & MASK;
        if (node.kind === "day" && !(mask & CONSTRAINS)) continue;
        const s = spread * this.weightOf(mask);
        const per = best.get(slot) ?? new Map<string, number>();
        if (s > (per.get(origin) ?? 0)) per.set(origin, s);
        best.set(slot, per);
        masks.set(slot, (masks.get(slot) ?? 0) | mask | reached);
        const v = via.get(slot) ?? [];
        if (v.length < 6 && !v.includes(node.label)) v.push(node.label);
        via.set(slot, v);
        if (node.kind !== "day") viaName.add(slot);
        if (mask & CONSTRAINS) binding.add(slot);
        if (node.kind === "id" && isSeed.has(key)) byRef.add(slot);
      }
    }
    // Days a long span covers: the items holding such spans, scanned (one per cached item at most), each covering
    // span's spread divided like a day node's by how many cover the day.
    for (const s of seeds) {
      if (!s.key.startsWith("d:") || this.long.size === 0) continue;
      const day = s.key.slice(2);
      const covering: number[] = [];
      for (const [slot, spans] of this.long) {
        if (late()) break;
        if (spans.some((sp) => sp.from <= day && day <= sp.to)) covering.push(slot);
      }
      const spread = (s.weight / Math.log2(2 + covering.length)) * this.weightOf(CONSTRAINS);
      for (const slot of covering) {
        const per = best.get(slot) ?? new Map<string, number>();
        if (spread > (per.get(s.key) ?? 0)) per.set(s.key, spread);
        best.set(slot, per);
        masks.set(slot, (masks.get(slot) ?? 0) | CONSTRAINS);
        const v = via.get(slot) ?? [];
        if (v.length < 6 && !v.includes(day)) v.push(day);
        via.set(slot, v);
        binding.add(slot);
      }
    }
    const out: Walked[] = [];
    for (const [slot, per] of best) {
      let s = 0;
      for (const x of per.values()) s += x;
      if (s < opt.floor) continue;
      const p = this.placedAt[slot]!;
      let speaks = false;
      for (let k = 2 + p[0]! + p[1]! * 3; k < p.length && !speaks; k++) speaks = near.has(p[k]!);
      const flags = this.flags[slot]!;
      out.push({
        id: this.itemAt[slot]!,
        score: s,
        mask: masks.get(slot)!,
        via: via.get(slot)!,
        speaks,
        named: viaName.has(slot),
        binds: binding.has(slot) || (flags & BOUND_FLAG) !== 0,
        automated: (flags & AUTOMATED_FLAG) !== 0,
        byRef: byRef.has(slot),
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
    const id = this.liveId(key);
    if (id < 0) return out;
    out.add(key);
    const node = this.nodeAt[id]!;
    for (let k = 0; k < node.nl * 2; k += 2) {
      if (node.links[k]! & (ALIAS | bit("member"))) out.add(this.nodeAt[node.links[k]! >> MASK_BITS]!.key);
    }
    return out;
  }

  /** For a one-word name (a first name), how many people go by it: its alias links to other names; else 0. */
  private peopleCalled(id: number): number {
    const node = this.nodeAt[id];
    if (!node?.live || node.kind !== "name" || /\s/.test(node.label)) return 0;
    let n = 0;
    for (let k = 0; k < node.nl * 2; k += 2) {
      if (node.links[k]! & ALIAS && this.nodeAt[node.links[k]! >> MASK_BITS]!.key.startsWith("n:")) n++;
    }
    return n;
  }

  /** The link types by which a non-seed node was reached from the seeds (for learning). */
  private linkMask(id: number, seeds: Set<number>): number {
    let mask = 0;
    const node = this.nodeAt[id];
    if (!node?.live) return 0;
    for (let k = 0; k < node.nl * 2; k += 2) if (seeds.has(node.links[k]! >> MASK_BITS)) mask |= node.links[k]! & MASK;
    return mask;
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
