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
 * The graph's storage is struct-of-arrays (D169; D58 held a Map per node for its items and another for its links, and
 * every item's node keys and links again as strings: 2.2 KB per item over realistic mail; then a `GNode` object per
 * node, two strings and two `Int32Array`s each, behind a `Map` from key to id and another from item id to slot: 1.7
 * KB). Node keys are interned to small integer ids and items to slots, through open-addressing tables of typed
 * arrays (`Table`); what a node holds is a word in typed columns indexed by its id; its items and links are packed
 * words, (item slot or node id) shifted past the edge mask, in blocks of two shared arenas (`Arena`); what each item
 * placed is one block of a third; node keys and labels are UTF-16 code units in a fourth, copied there when the node
 * is interned, so no label keeps the item text it was read from alive. Orders are kept as the Maps kept them
 * (appended, removed in place), so a walk visits what it visited before in the same order (kg.test.ts holds the
 * earlier storage and walks both).
 */
const MASK_BITS = N_TYPES;
const MASK = (1 << MASK_BITS) - 1;
/** Item slots and node ids stay below this, so a packed word stays a positive 32-bit integer. */
const MAX_INDEX = 1 << (31 - MASK_BITS);
/** In an item's placed links: the link went on both nodes (else only the first's: the second was full). */
const BOTH = 1 << MASK_BITS;
const KINDS: Record<string, NodeKind> = { n: "name", e: "email", i: "id", c: "channel", r: "role", d: "day" };
const KIND_OF: readonly NodeKind[] = ["name", "email", "id", "channel", "role", "day"];
const KIND_NAME = 0;
const KIND_ID = 2;
const KIND_DAY = 5;
const KIND_CODE: Record<NodeKind, number> = { name: 0, email: 1, id: 2, channel: 3, role: 4, day: 5 };
const ALIAS = bit("alias");
const CONSTRAINS = bit("constrains");
/** A node id's state: free (no key), named (out of the graph, still named by a link or an author), in the graph. */
const FREE = 0;
const NAMED = 1;
const LIVE = 2;
/** A label stored as "the key past its two-character prefix" (every kind but a name, and a domain's name). */
const KEY_LABEL = -1;
const SPACE = /\s/;

/** FNV-1a over a string's UTF-16 code units. */
function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16_777_619);
  return h | 0;
}
/** The table position of a hash (its high bits folded in: FNV's low bits alone cluster). */
const home = (h: number, mask: number) => (h ^ (h >>> 15)) & mask;

/**
 * An open-addressing table (linear probing, backward-shift deletion) from a string to a small integer that owns it: a
 * node key to its id, an item id to its slot. It stores only the integers (plus one, 0 is empty); the hash and the key
 * of each are read from the owner (`hashAt`, `is`). Kept at most half full, halved when an eighth full.
 */
class Table {
  private t = new Int32Array(16);
  private n = 0;
  constructor(
    private readonly hashAt: (v: number) => number,
    private readonly is: (v: number, key: string) => boolean,
  ) {}

  /** The integer `key` maps to (`h` its `hashOf`), else -1. */
  get(key: string, h: number): number {
    const t = this.t;
    const m = t.length - 1;
    for (let i = home(h, m); ; i = (i + 1) & m) {
      const e = t[i]!;
      if (e === 0) return -1;
      if (this.hashAt(e - 1) === h && this.is(e - 1, key)) return e - 1;
    }
  }

  /** Adds `v` (its key not in the table). */
  put(v: number): void {
    if ((this.n + 1) * 2 > this.t.length) this.resize(this.t.length * 2);
    this.place(v);
    this.n++;
  }

  /** Takes `v` out (it must be in). */
  delete(v: number): void {
    const t = this.t;
    const m = t.length - 1;
    let i = home(this.hashAt(v), m);
    while (t[i] !== v + 1) i = (i + 1) & m;
    // Every entry after the hole up to the next empty one moves into it unless its home lies between them.
    for (let j = (i + 1) & m; t[j] !== 0; j = (j + 1) & m) {
      const k = home(this.hashAt(t[j]! - 1), m);
      if (i <= j ? i < k && k <= j : i < k || k <= j) continue;
      t[i] = t[j]!;
      i = j;
    }
    t[i] = 0;
    this.n--;
    if (this.t.length > 16 && this.n * 8 < this.t.length) this.resize(this.t.length >> 1);
  }

  private place(v: number): void {
    const t = this.t;
    const m = t.length - 1;
    let i = home(this.hashAt(v), m);
    while (t[i] !== 0) i = (i + 1) & m;
    t[i] = v + 1;
  }

  private resize(size: number): void {
    const old = this.t;
    this.t = new Int32Array(size);
    for (let i = 0; i < old.length; i++) if (old[i] !== 0) this.place(old[i]! - 1);
  }
}

type Words = Int32Array | Uint16Array;

/**
 * Blocks of words, appended to one typed array; a block given back is only counted. When the array is full, or more
 * than four times the words in use, the blocks in use are copied to a new array sized half again over them (`owners`
 * names each, in a fixed order, and takes its new offset). Each copy follows appends or frees of at least half the
 * words it copies, so it costs O(1) a word; the array is 1.5x what is in use just after a copy, 4x at most.
 */
class Arena<W extends Words> {
  w: W;
  private top = 0;
  private dead = 0;
  constructor(
    private readonly make: (n: number) => W,
    /** Calls `move(offset, words in use, words held)` for every block in use and stores what it returns. */
    private readonly owners: (move: (off: number, used: number, size: number) => number) => void,
  ) {
    this.w = make(0);
  }

  /** The offset of a new block of `n` words. Moves every block (read offsets again after it). */
  alloc(n: number): number {
    if (this.top + n > this.w.length) this.compact(n);
    const at = this.top;
    this.top += n;
    return at;
  }

  /** Gives back a block of `n` words. Moves every block when most of the array is given back. */
  free(n: number): void {
    this.dead += n;
    if (this.w.length > 1_024 && (this.top - this.dead) * 4 < this.w.length) this.compact(0);
  }

  private compact(n: number): void {
    const from = this.w;
    // Sized from what the owners report, not from `top - dead`: a block an owner reports and the counts missed
    // (an owner that marks a block live before writing it) would otherwise run the new array short, and the next
    // `alloc` would return an offset past its end, where writes are silently dropped.
    let live = 0;
    this.owners((off, _used, size) => {
      live += size;
      return off;
    });
    const to = this.make(Math.max(64, Math.ceil((Math.max(live, this.top - this.dead) + n) * 1.5)));
    let top = 0;
    this.owners((off, used, size) => {
      (to as Int32Array).set((from as Int32Array).subarray(off, off + used), top);
      top += size;
      return top - size;
    });
    this.w = to;
    this.top = top;
    this.dead = 0;
  }
}

/** `xs` with room for `n` entries, grown by half (not doubled: a column is a word or a byte per node, kept tight). */
function grown<W extends Words | Uint8Array>(xs: W, n: number): W {
  let size = xs.length;
  while (size < n) size = Math.ceil(size * 1.5);
  if (size === xs.length) return xs;
  const out = new (xs.constructor as new (n: number) => W)(size);
  (out as Int32Array).set(xs as Int32Array);
  return out;
}

/** A string from UTF-16 code units (in chunks: an argument list has a limit). */
function decode(w: Uint16Array, off: number, len: number): string {
  let s = "";
  for (let k = 0; k < len; k += 4_096) {
    const part = w.subarray(off + k, off + Math.min(len, k + 4_096));
    s += String.fromCharCode.apply(null, part as unknown as number[]);
  }
  return s;
}

/** Scratch for `add` (one graph is built at a time: no await inside). */
const scratchNodes: number[] = [];
const scratchLinks: number[] = [];
const scratchAuthors: number[] = [];

/** One user's graph. Held by the user's cache entry (`ItemCache`), so it is keyed, bounded and dropped with it. */
export class UserGraph {
  /** Node key → id, for every node in the graph and every id still named (`state` NAMED). */
  private readonly ids = new Table(
    (id) => this.hash[id]!,
    (id, key) => this.keyIs(id, key),
  );
  /** Ids handed out so far (the next new one), and those given back. */
  private top = 0;
  private readonly freeIds: number[] = [];
  private liveNodes = 0;
  // Per node id. `state`: FREE, NAMED (out of the graph: it keeps its id, and key, while a link or an item's author
  // still names it, so a key never has two ids and an id never two keys) or LIVE. `kind`: `KIND_OF`'s index.
  private state = new Uint8Array(16);
  private kind = new Uint8Array(16);
  /** Whether its label has white space (a name written out, not a domain's squashed one). */
  private spaced = new Uint8Array(16);
  /** Its items: (item slot << MASK_BITS | edge mask), in the order they came: offset in `itemWords`, used, held. */
  private itemsAt = new Int32Array(16);
  private ni = new Int32Array(16);
  private itemsCap = new Int32Array(16);
  /** Its links to other nodes: pairs (node id << MASK_BITS | mask, items stating it), in the order they came. */
  private linksAt = new Int32Array(16);
  /** Links used (pairs; a link is kept while some item still states it), and words held. */
  private nl = new Int32Array(16);
  private linksCap = new Int32Array(16);
  /** Links on other nodes and items' authors that name this node's id. */
  private refs = new Int32Array(16);
  /** Its key ("n:umbrellahealth") in `chars`, and the key's `hashOf`. */
  private keyAt = new Int32Array(16);
  private keyLen = new Int32Array(16);
  private hash = new Int32Array(16);
  /**
   * Its name as first seen written (for ties), in `chars`: "Umbrella Health", "inv-7174", "#legal", "2026-10-29";
   * `KEY_LABEL` when that is the key past its prefix.
   */
  private labelAt = new Int32Array(16);
  private labelLen = new Int32Array(16);
  private readonly itemWords = new Arena(
    (n) => new Int32Array(n),
    (move) => {
      for (let id = 0; id < this.top; id++) {
        if (this.itemsCap[id]! > 0) this.itemsAt[id] = move(this.itemsAt[id]!, this.ni[id]!, this.itemsCap[id]!);
      }
    },
  );
  private readonly linkWords = new Arena(
    (n) => new Int32Array(n),
    (move) => {
      for (let id = 0; id < this.top; id++) {
        if (this.linksCap[id]! > 0) this.linksAt[id] = move(this.linksAt[id]!, this.nl[id]! * 2, this.linksCap[id]!);
      }
    },
  );
  private readonly chars = new Arena(
    (n) => new Uint16Array(n),
    (move) => {
      for (let id = 0; id < this.top; id++) {
        if (this.state[id] === FREE) continue;
        this.keyAt[id] = move(this.keyAt[id]!, this.keyLen[id]!, this.keyLen[id]!);
        const n = this.labelLen[id]!;
        if (n > 0) this.labelAt[id] = move(this.labelAt[id]!, n, n);
      }
    },
  );
  /** Item id → slot, and per slot: the id and its `hashOf`, what it placed, its flags. */
  private readonly slots = new Table(
    (slot) => this.slotHash[slot]!,
    (slot, id) => this.itemAt[slot] === id,
  );
  private readonly itemAt: (string | undefined)[] = [];
  private slotHash = new Int32Array(16);
  /**
   * What each item placed, to take it out again, in `placedWords` (offset, words; 0 for a free slot): [nodes n, links
   * n, its node ids…, its links as (a, b, mask | BOTH) triples…, its authors' node ids (From, organiser, owner, chat
   * speaker)…].
   */
  private placedAt = new Int32Array(16);
  private placedLen = new Int32Array(16);
  private readonly placedWords = new Arena(
    (n) => new Int32Array(n),
    (move) => {
      for (let slot = 0; slot < this.itemAt.length; slot++) {
        const n = this.placedLen[slot]!;
        if (n > 0) this.placedAt[slot] = move(this.placedAt[slot]!, n, n);
      }
    },
  );
  /** Per slot: `AUTOMATED_FLAG`, `BOUND_FLAG`. */
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
    for (let id = 0; id < this.top; id++) if (this.state[id] === LIVE) out.push(this.keyOf(id));
    return out;
  }

  /** The id of `key` (in the graph or named), else -1. */
  private idOf(key: string): number {
    return this.ids.get(key, hashOf(key));
  }

  /** A node's id when it is in the graph, else -1. */
  private liveId(key: string): number {
    const id = this.idOf(key);
    return id >= 0 && this.state[id] === LIVE ? id : -1;
  }

  private keyIs(id: number, key: string): boolean {
    const n = this.keyLen[id]!;
    if (n !== key.length) return false;
    const w = this.chars.w;
    const at = this.keyAt[id]!;
    for (let k = 0; k < n; k++) if (w[at + k] !== key.charCodeAt(k)) return false;
    return true;
  }

  private keyOf(id: number): string {
    return decode(this.chars.w, this.keyAt[id]!, this.keyLen[id]!);
  }

  private labelOf(id: number): string {
    const n = this.labelLen[id]!;
    return n === KEY_LABEL
      ? decode(this.chars.w, this.keyAt[id]! + 2, this.keyLen[id]! - 2)
      : decode(this.chars.w, this.labelAt[id]!, n);
  }

  /** Copies a string into `chars`; returns its offset. */
  private write(s: string): number {
    const at = this.chars.alloc(s.length);
    const w = this.chars.w;
    for (let k = 0; k < s.length; k++) w[at + k] = s.charCodeAt(k);
    return at;
  }

  /** Sets a node's label (its key past the prefix when it is that, which every kind but a name's is). */
  private setLabel(id: number, label: string): void {
    const old = this.labelLen[id]!;
    this.labelLen[id] = 0;
    if (old > 0) this.chars.free(old);
    this.spaced[id] = SPACE.test(label) ? 1 : 0;
    let same = label.length === this.keyLen[id]! - 2;
    const w = this.chars.w;
    const at = this.keyAt[id]! + 2;
    for (let k = 0; same && k < label.length; k++) same = w[at + k] === label.charCodeAt(k);
    // (Owned only once written: `write` may compact `chars`, which moves every block `labelLen` says is held.)
    if (!same && label.length > 0) this.labelAt[id] = this.write(label);
    this.labelLen[id] = same ? KEY_LABEL : label.length;
  }

  /** The id of `key`, made (out of the graph) if it has none. */
  private intern(key: string, kind: NodeKind, label: string): number {
    const h = hashOf(key);
    const known = this.ids.get(key, h);
    if (known >= 0) return known;
    const id = this.freeIds.pop() ?? this.top++;
    if (id >= this.state.length) this.columns(id + 1);
    this.state[id] = NAMED;
    this.kind[id] = KIND_CODE[kind];
    this.ni[id] = this.nl[id] = this.refs[id] = this.itemsCap[id] = this.linksCap[id] = 0;
    this.labelLen[id] = 0;
    // The key is owned (`keyLen` set) only once written: `write` may compact `chars`, which moves every block of an
    // id not FREE by its `keyAt`/`keyLen`; a length set first would copy a stale block in and size the array short.
    this.keyLen[id] = 0;
    const at = this.write(key);
    this.keyAt[id] = at;
    this.keyLen[id] = key.length;
    this.hash[id] = h;
    this.setLabel(id, label);
    this.ids.put(id);
    return id;
  }

  /** Room for node ids below `n`. */
  private columns(n: number): void {
    this.state = grown(this.state, n);
    this.kind = grown(this.kind, n);
    this.spaced = grown(this.spaced, n);
    this.itemsAt = grown(this.itemsAt, n);
    this.ni = grown(this.ni, n);
    this.itemsCap = grown(this.itemsCap, n);
    this.linksAt = grown(this.linksAt, n);
    this.nl = grown(this.nl, n);
    this.linksCap = grown(this.linksCap, n);
    this.refs = grown(this.refs, n);
    this.keyAt = grown(this.keyAt, n);
    this.keyLen = grown(this.keyLen, n);
    this.hash = grown(this.hash, n);
    this.labelAt = grown(this.labelAt, n);
    this.labelLen = grown(this.labelLen, n);
  }

  /** Frees an id that is out of the graph and named by nothing. */
  private release(id: number): void {
    if (this.state[id] === LIVE || this.refs[id]! > 0) return;
    this.ids.delete(id);
    this.state[id] = FREE;
    // (Each block is disowned before it is given back: `free` may move every block it still owns.)
    const chars = this.keyLen[id]! + Math.max(0, this.labelLen[id]!);
    const items = this.itemsCap[id]!;
    const links = this.linksCap[id]!;
    this.labelLen[id] = this.itemsCap[id] = this.linksCap[id] = 0;
    this.chars.free(chars);
    if (items > 0) this.itemWords.free(items);
    if (links > 0) this.linkWords.free(links);
    this.freeIds.push(id);
  }

  /** Takes a node out of the graph when nothing holds it: no item and no link. */
  private settle(id: number): void {
    if (this.state[id] !== LIVE || this.ni[id]! > 0 || this.nl[id]! > 0) return;
    this.state[id] = NAMED;
    this.liveNodes--;
    this.release(id);
  }

  /**
   * Resizes a node's block of items (`links` false) or links to `size` words (doubled when full from 4, halved when a
   * quarter used past 8, as the per-node arrays before it), keeping the words in use.
   */
  private resize(id: number, links: boolean, size: number): void {
    const arena = links ? this.linkWords : this.itemWords;
    const at = arena.alloc(size);
    // (Read after `alloc`, which may have moved every block.)
    const cap = links ? this.linksCap : this.itemsCap;
    const offs = links ? this.linksAt : this.itemsAt;
    const used = links ? this.nl[id]! * 2 : this.ni[id]!;
    const w = arena.w;
    if (used > 0) w.copyWithin(at, offs[id]!, offs[id]! + used);
    const old = cap[id]!;
    // (Owned before the old block is given back: `free` may move every block too.)
    offs[id] = at;
    cap[id] = size;
    if (old > 0) arena.free(old);
  }

  /** Room for `n` more words in a node's block of items or links. */
  private room(id: number, links: boolean, n: number): void {
    const cap = (links ? this.linksCap : this.itemsCap)[id]!;
    const used = links ? this.nl[id]! * 2 : this.ni[id]!;
    if (used + n > cap) this.resize(id, links, Math.max(4, cap * 2, used + n));
  }

  /** Gives half a block back when at most a quarter of it is used (an item churned off a busy node). */
  private shrink(id: number, links: boolean): void {
    const cap = (links ? this.linksCap : this.itemsCap)[id]!;
    const used = links ? this.nl[id]! * 2 : this.ni[id]!;
    if (cap > 8 && used <= cap >> 2) this.resize(id, links, cap >> 1);
  }

  /** Puts an item in the graph, replacing what an earlier copy of it put there. */
  add(item: ContextItem, now: number): void {
    const x = extract(item, now, this.memo);
    // A packed word must stay an int32: ids in use and every id this item could intern (its nodes, and its authors,
    // which neither `MAX_NODES` nor `MAX_NODES_PER_ITEM` bounds) stay under `maxIds`, slots under `MAX_INDEX`. Checked
    // before an earlier copy leaves: a copy refused here leaves the one held.
    if (this.top - this.freeIds.length + x.nodes.size + x.authors.length > this.maxIds) return;
    const h = hashOf(item.id);
    const replacing = this.slots.get(item.id, h) >= 0;
    if (!replacing && this.freeSlots.length === 0 && this.itemAt.length >= MAX_INDEX) return;
    if (replacing) this.remove(item.id);
    const slot = this.freeSlots.pop() ?? this.itemAt.length;
    if (slot >= this.placedAt.length) {
      this.placedAt = grown(this.placedAt, slot + 1);
      this.placedLen = grown(this.placedLen, slot + 1);
      this.slotHash = grown(this.slotHash, slot + 1);
    }
    const nodes = scratchNodes;
    const links = scratchLinks;
    const authors = scratchAuthors;
    nodes.length = links.length = authors.length = 0;
    for (const [key, n] of x.nodes) {
      let id = this.idOf(key);
      if (id < 0 || this.state[id] !== LIVE) {
        if (this.liveNodes >= MAX_NODES) continue;
        if (id < 0) id = this.intern(key, n.kind, n.label);
        else this.setLabel(id, n.label);
        this.kind[id] = KIND_CODE[n.kind];
        this.state[id] = LIVE;
        this.liveNodes++;
      } else if (n.kind === "name" && this.spaced[id] === 0 && SPACE.test(n.label)) this.setLabel(id, n.label);
      this.room(id, false, 1);
      this.itemWords.w[this.itemsAt[id]! + this.ni[id]!++] = (slot << MASK_BITS) | n.mask;
      nodes.push(id);
    }
    for (const [a, b, mask] of x.links) {
      const ia = this.liveId(a);
      const ib = this.liveId(b);
      if (ia < 0 || ib < 0 || !this.bump(ia, ib, mask)) continue;
      links.push(ia, ib, this.bump(ib, ia, mask) ? mask | BOTH : mask);
    }
    for (const k of x.authors) {
      const id = this.intern(k, KINDS[k[0]!] ?? "name", "");
      this.refs[id]!++;
      authors.push(id);
    }
    const n = 2 + nodes.length + links.length + authors.length;
    const at = this.placedWords.alloc(n);
    const p = this.placedWords.w;
    p[at] = nodes.length;
    p[at + 1] = links.length / 3;
    let k = at + 2;
    for (const v of nodes) p[k++] = v;
    for (const v of links) p[k++] = v;
    for (const v of authors) p[k++] = v;
    if (slot >= this.flags.length) {
      const grownFlags = new Uint8Array(this.flags.length * 2);
      grownFlags.set(this.flags);
      this.flags = grownFlags;
    }
    this.flags[slot] = (x.automated ? AUTOMATED_FLAG : 0) | (x.bound ? BOUND_FLAG : 0);
    this.itemAt[slot] = item.id;
    this.slotHash[slot] = h;
    this.slots.put(slot);
    this.placedAt[slot] = at;
    this.placedLen[slot] = n;
    if (x.long.length > 0) this.long.set(slot, x.long);
  }

  /** Adds one statement of a link from one node to another; false when the first is full (then nothing is added). */
  private bump(from: number, to: number, mask: number): boolean {
    const l = this.linkWords.w;
    const at = this.linksAt[from]!;
    const n = this.nl[from]!;
    for (let k = at; k < at + n * 2; k += 2) {
      if (l[k]! >> MASK_BITS !== to) continue;
      l[k]! |= mask;
      l[k + 1]!++;
      return true;
    }
    if (n >= MAX_LINKS) return false;
    this.room(from, true, 2);
    const w = this.linkWords.w;
    const end = this.linksAt[from]! + n * 2;
    w[end] = (to << MASK_BITS) | mask;
    w[end + 1] = 1;
    this.nl[from] = n + 1;
    this.refs[to]!++;
    return true;
  }

  /** Takes back one statement of a link from one node to another; the link goes with its last statement. */
  private unbump(from: number, to: number): void {
    const l = this.linkWords.w;
    const at = this.linksAt[from]!;
    const end = at + this.nl[from]! * 2;
    for (let k = at; k < end; k += 2) {
      if (l[k]! >> MASK_BITS !== to) continue;
      if (--l[k + 1]! > 0) return;
      l.copyWithin(k, k + 2, end);
      this.nl[from]!--;
      this.shrink(from, true);
      this.refs[to]!--;
      this.release(to);
      return;
    }
  }

  /** Takes an item out: its edges, the links it stated, and nodes nothing else holds. */
  remove(id: string): void {
    const slot = this.slots.get(id, hashOf(id));
    if (slot < 0) return;
    this.memo.sentences.clear();
    this.memo.people.clear();
    this.slots.delete(slot);
    this.long.delete(slot);
    this.itemAt[slot] = undefined;
    this.freeSlots.push(slot);
    // (Only `add` places words: the block stays where it is until it is given back below.)
    const p = this.placedWords.w;
    const at = this.placedAt[slot]!;
    const len = this.placedLen[slot]!;
    this.placedLen[slot] = 0;
    const nodesEnd = at + 2 + p[at]!;
    const linksEnd = nodesEnd + p[at + 1]! * 3;
    for (let k = nodesEnd; k < linksEnd; k += 3) {
      this.unbump(p[k]!, p[k + 1]!);
      if (p[k + 2]! & BOTH) this.unbump(p[k + 1]!, p[k]!);
    }
    for (let k = at + 2; k < nodesEnd; k++) {
      const node = p[k]!;
      const xs = this.itemWords.w;
      const start = this.itemsAt[node]!;
      const n = this.ni[node]!;
      for (let i = start; i < start + n; i++) {
        if (xs[i]! >> MASK_BITS !== slot) continue;
        xs.copyWithin(i, i + 1, start + n);
        this.ni[node] = n - 1;
        this.shrink(node, false);
        break;
      }
      this.settle(node);
    }
    // A node kept only by a link whose last item just left: gone with it.
    for (let k = nodesEnd; k < linksEnd; k += 3) {
      this.settle(p[k]!);
      this.settle(p[k + 1]!);
    }
    for (let k = linksEnd; k < at + len; k++) {
      this.refs[p[k]!]!--;
      this.release(p[k]!);
    }
    this.placedWords.free(len);
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
      const id = this.idOf(k);
      if (id >= 0) banned.add(id);
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
    const words = new Set<number>();
    for (const s of seeds) {
      if (!s.parent) continue;
      const id = this.idOf(s.key);
      if (id >= 0) words.add(id);
    }
    let frontier = [...isSeed].filter((id) => !words.has(id));
    for (let hop = 1; hop <= LINK_HOPS && frontier.length > 0; hop++) {
      const next: number[] = [];
      for (const key of frontier) {
        const from = act.get(key)!;
        const nl = this.nl[key]!;
        // A person's few links (addresses, first name, organisation) each carry them whole; an organisation's many
        // people share its activation.
        const fan = nl > 12 ? Math.sqrt(nl) : 1;
        const lw = this.linkWords.w;
        const at = this.linksAt[key]!;
        for (let k = 0; k < nl * 2; k += 2) {
          if (late()) break;
          const word = lw[at + k]!;
          const other = word >> MASK_BITS;
          const mask = word & MASK;
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
          if (hop === 1 && mask & ALIAS && nl <= 12 && this.ni[key]! <= HUB) near.add(other);
        }
      }
      frontier = next.filter((id) => this.state[id] === LIVE);
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
      const ni = this.ni[key]!;
      if (this.state[key] !== LIVE || ni > HUB) continue;
      const kind = this.kind[key]!;
      const spread = a / Math.log2(2 + ni);
      const reached = isSeed.has(key) ? 0 : this.linkMask(key, isSeed);
      let label: string | undefined;
      const iw = this.itemWords.w;
      const at = this.itemsAt[key]!;
      for (let k = 0; k < ni; k++) {
        const word = iw[at + k]!;
        const slot = word >> MASK_BITS;
        const mask = word & MASK;
        if (kind === KIND_DAY && !(mask & CONSTRAINS)) continue;
        const s = spread * this.weightOf(mask);
        const per = best.get(slot) ?? new Map<string, number>();
        if (s > (per.get(origin) ?? 0)) per.set(origin, s);
        best.set(slot, per);
        masks.set(slot, (masks.get(slot) ?? 0) | mask | reached);
        const v = via.get(slot) ?? [];
        label ??= this.labelOf(key);
        if (v.length < 6 && !v.includes(label)) v.push(label);
        via.set(slot, v);
        if (kind !== KIND_DAY) viaName.add(slot);
        if (mask & CONSTRAINS) binding.add(slot);
        if (kind === KIND_ID && isSeed.has(key)) byRef.add(slot);
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
    const p = this.placedWords.w;
    for (const [slot, per] of best) {
      let s = 0;
      for (const x of per.values()) s += x;
      if (s < opt.floor) continue;
      const at = this.placedAt[slot]!;
      const end = at + this.placedLen[slot]!;
      let speaks = false;
      for (let k = at + 2 + p[at]! + p[at + 1]! * 3; k < end && !speaks; k++) speaks = near.has(p[k]!);
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
    const at = this.linksAt[id]!;
    for (let k = 0; k < this.nl[id]! * 2; k += 2) {
      const word = this.linkWords.w[at + k]!;
      if (word & (ALIAS | bit("member"))) out.add(this.keyOf(word >> MASK_BITS));
    }
    return out;
  }

  /** For a one-word name (a first name), how many people go by it: its alias links to other names; else 0. */
  private peopleCalled(id: number): number {
    if (this.state[id] !== LIVE || this.kind[id] !== KIND_NAME || this.spaced[id] === 1) return 0;
    let n = 0;
    const w = this.linkWords.w;
    const at = this.linksAt[id]!;
    for (let k = 0; k < this.nl[id]! * 2; k += 2) {
      if (!(w[at + k]! & ALIAS)) continue;
      // Its key starts "n:".
      const other = this.keyAt[w[at + k]! >> MASK_BITS]!;
      if (this.chars.w[other] === 110 && this.chars.w[other + 1] === 58) n++;
    }
    return n;
  }

  /** The link types by which a non-seed node was reached from the seeds (for learning). */
  private linkMask(id: number, seeds: Set<number>): number {
    let mask = 0;
    if (this.state[id] !== LIVE) return 0;
    const w = this.linkWords.w;
    const at = this.linksAt[id]!;
    for (let k = at; k < at + this.nl[id]! * 2; k += 2) if (seeds.has(w[k]! >> MASK_BITS)) mask |= w[k]! & MASK;
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
