/**
 * D7's slot table (P3.3): the ~15 slots a user states facts about, each with its subject aliases, its value class and
 * its default scope, and the reading that finds them in what the user typed. A slot is a keyed current value (D6):
 * the store supersedes it by `(scope, slot)` (A4 §3.1–3.2), the ledger keys it by `(scope, slot)` (A4 §4), and D26's
 * residual reads it by its aliases and its value class.
 *
 * - **Values.** A value of a slot's class is named by its canonical form ("postgres" for "PostgreSQL"). A value
 *   outside the class counts only for a pattern that names the slot (its subject or D7's `deploy`/`PRs go` forms), and
 *   only as one capitalized or identifier-shaped token with a letter that is not in the status lexicon, no
 *   placeholder, day, month or colour ("the auth provider is Zitadel"; never "the auth is broken", "the deploy is
 *   Friday"). A version slot's value is a version number, alone or after the slot's alias ("node 22"). A value read by
 *   its class alone ends its clause, but for a version or an edition word (`yarn berry` → yarn, `postgres 16`): a noun
 *   after it names a part of it ("jest mocks", "the yarn lockfile").
 * - **Forms** (D7, its additional R8 forms, and A4 §3.1's retractions), read clause by clause:
 *   - `S is V`, `S = V`, `S: V`; `S is not V` invalidates V; `S is A, not B` sets A and invalidates B;
 *   - `use/using/with A for B` (B names the slot; also `uses A as its B`), and `…, not C` invalidates C;
 *   - `use A (not|instead of|rather than) B` sets A and invalidates B, in the slot whose class holds them;
 *   - `(we|<scope>) (switched|moved|migrated) (X) (from B) to A` and `… to A from B`, X naming the slot or nothing;
 *   - a bare `(we|i) (always) use V (here)`, when V is in exactly one slot's class;
 *   - retractions, D7's and A4 §3.1's only: `we (don't|do not|no longer) use V (anymore)`, `we're dropping V`, `we
 *     dropped V`, `we're not (on|using) V anymore`, `we're no longer on V`: V invalidated, with no successor;
 *   - `we're (on|using|now on) V`; R8's `everything is V now`; `our <alias> run(s) on V`; `we (deploy|host) (to|on)
 *     V`, with no other subject or object; `PRs go (against|into) V`; `<scope path> (uses|runs) V`;
 *   - D7's `use A for X, not B` when X names no slot (A's and B's class do), and a switch of a component ("switched
 *     the api to fastify from express") when its values share a class, each read in the other's slot;
 *   - words that say where or when, not what ("here", "now", "across the repo", "last month", "in the spring");
 *   - `it's V` after a clause about a slot, in the same sentence ("we're not on heroku anymore, it's render").
 * - **No slot** in a question, a conditional ("if we use pnpm, …"), a reminder ("don't forget to use …"), an
 *   instruction that only mentions a value ("use vitest's fake timers"), a status ("the db is down"), or a value of
 *   no class without its slot named ("we use Redis for caching", "use a Set instead of an array").
 * - **Another instance.** A word before the subject names another instance of it ("the staging database", "end-to-end
 *   tests"), whose value is not the slot's: such a subject states no slot.
 * - **Common words.** A value that is also an everyday word ("main", "next", "render", "express") is read only where
 *   its slot is named in the same sentence: "we switched to main" is a checkout, not the base branch.
 */
import { stripPastes } from "./memory-authority";
import { isUntyped, noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";

export type SlotId =
  | "auth.provider"
  | "pkg.manager"
  | "db.engine"
  | "orm"
  | "test.runner"
  | "node.version"
  | "lang.version"
  | "framework"
  | "deploy.target"
  | "ci.system"
  | "formatter"
  | "linter"
  | "commit.style"
  | "branch.base"
  | "gh.account";

/** What one clause states of a slot: the value it sets, if any, and the values it invalidates (canonical forms). */
export interface SlotStatement {
  slot: SlotId;
  value?: string;
  was: string[];
}

/** A row's slots as it stores them (A4 §3.1): `v` the value it sets, `x` the values it invalidates. */
export interface SlotRef {
  k: SlotId;
  v?: string;
  x?: string[];
}

interface SlotSpec {
  /** How a bullet names the slot ("auth provider — apps/web: Clerk · …"). */
  label: string;
  /** `subject_aliases`: the words that name the slot. */
  aliases: readonly string[];
  /** `value_class`: each canonical value and the other names it goes by; `version` for a version number. */
  values: Readonly<Record<string, readonly string[]>> | "version";
  /** `default_scope` (D7): where a statement naming no scope is written. */
  scope: "root" | "working";
}

/** D7's slots, in the order a value of two classes is given to (`biome`: formatter, then linter). */
const TABLE: Readonly<Record<SlotId, SlotSpec>> = {
  "auth.provider": {
    label: "auth provider",
    aliases: [
      "auth provider",
      "authentication provider",
      "login provider",
      "identity provider",
      "auth",
      "authentication",
    ],
    values: {
      clerk: [],
      auth0: [],
      nextauth: ["next-auth", "auth.js", "authjs"],
      "supabase auth": [],
      cognito: ["aws cognito"],
      "firebase auth": [],
      lucia: [],
      okta: [],
      "better-auth": ["better auth"],
      workos: [],
      kinde: [],
      stytch: [],
      keycloak: [],
    },
    scope: "working",
  },
  "pkg.manager": {
    label: "package manager",
    aliases: ["package manager", "pkg manager"],
    values: { pnpm: [], npm: [], yarn: [], bun: [] },
    scope: "root",
  },
  "db.engine": {
    label: "database",
    aliases: ["database engine", "db engine", "database", "db"],
    values: {
      postgres: ["postgresql"],
      mysql: [],
      sqlite: ["sqlite3"],
      mongodb: ["mongo"],
      mariadb: [],
      cockroachdb: ["cockroach"],
      dynamodb: [],
    },
    scope: "working",
  },
  orm: {
    label: "ORM",
    aliases: ["orm"],
    values: {
      drizzle: [],
      prisma: [],
      typeorm: [],
      sequelize: [],
      kysely: [],
      "mikro-orm": ["mikroorm"],
      sqlalchemy: [],
      gorm: [],
    },
    scope: "working",
  },
  "test.runner": {
    label: "test runner",
    aliases: ["test runner", "test framework", "unit tests", "tests", "testing"],
    values: {
      vitest: [],
      jest: [],
      mocha: [],
      playwright: [],
      cypress: [],
      "bun test": [],
      ava: [],
      pytest: [],
      jasmine: [],
    },
    scope: "working",
  },
  "node.version": {
    label: "node version",
    aliases: ["node.js version", "node version", "node.js", "nodejs", "node"],
    values: "version",
    scope: "working",
  },
  "lang.version": {
    label: "language version",
    aliases: [
      "language version",
      "typescript version",
      "ts version",
      "python version",
      "go version",
      "rust version",
      "typescript",
      "python",
    ],
    values: "version",
    scope: "working",
  },
  framework: {
    label: "framework",
    aliases: ["web framework", "frontend framework", "backend framework", "framework"],
    values: {
      "next.js": ["nextjs", "next"],
      remix: [],
      fastify: [],
      express: [],
      nestjs: [],
      hono: [],
      react: [],
      vue: [],
      svelte: [],
      sveltekit: [],
      astro: [],
      nuxt: [],
      angular: [],
      django: [],
      flask: [],
      fastapi: [],
      rails: [],
    },
    scope: "working",
  },
  "deploy.target": {
    label: "deploy target",
    aliases: [
      "deploy target",
      "deployment target",
      "hosting provider",
      "deployments",
      "deployment",
      "deploys",
      "deploy",
      "hosting",
    ],
    values: {
      vercel: [],
      "fly.io": ["fly"],
      netlify: [],
      render: [],
      heroku: [],
      aws: [],
      eks: [],
      cloudflare: [],
      railway: [],
      k8s: ["kubernetes"],
      gcp: [],
      azure: [],
      digitalocean: [],
    },
    scope: "root",
  },
  "ci.system": {
    label: "CI",
    aliases: ["continuous integration", "ci system", "ci provider", "ci"],
    values: {
      "github actions": ["gh actions"],
      circleci: [],
      "gitlab ci": [],
      buildkite: [],
      jenkins: [],
      "travis ci": ["travis"],
    },
    scope: "root",
  },
  formatter: {
    label: "formatter",
    aliases: ["code formatter", "formatter", "formatting"],
    values: { prettier: [], biome: [], dprint: [], black: [], gofmt: [], rustfmt: [] },
    scope: "working",
  },
  linter: {
    label: "linter",
    aliases: ["linter", "linting", "lint"],
    values: { eslint: [], biome: [], oxlint: [], tslint: [], ruff: [], pylint: [], flake8: [], "golangci-lint": [] },
    scope: "working",
  },
  "commit.style": {
    label: "commit style",
    aliases: ["commit message style", "commit convention", "commit messages", "commit style", "commits"],
    values: { "conventional commits": [], gitmoji: [] },
    scope: "root",
  },
  "branch.base": {
    label: "base branch",
    aliases: ["base branch", "default branch"],
    values: { main: [], master: [], develop: [], trunk: [] },
    scope: "root",
  },
  "gh.account": {
    label: "GitHub account",
    aliases: ["github account", "github user", "gh account", "github", "gh"],
    values: {},
    scope: "root",
  },
};

export const SLOT_IDS = Object.keys(TABLE) as readonly SlotId[];
/** D7's `default_scope`, by slot. */
export const DEFAULT_SCOPES: Readonly<Record<SlotId, "root" | "working">> = Object.fromEntries(
  SLOT_IDS.map((slot) => [slot, TABLE[slot].scope]),
) as Record<SlotId, "root" | "working">;
/** D7's status lexicon: a word in it is a state, never a value. */
export const STATUS_LEXICON: ReadonlySet<string> = new Set(
  "broken down failing flaky slow fixed working done weird annoying wrong fine ok good bad new old".split(" "),
);
/** Values that are also everyday words: read only where the sentence names their slot (see the header). */
const COMMON_WORDS = new Set([
  "main",
  "master",
  "develop",
  "trunk",
  "next",
  "render",
  "express",
  "remix",
  "fly",
  "react",
  "black",
  "rails",
  "ava",
  "mocha",
  "lucia",
]);

/** The slot's display name. */
export function slotLabel(slot: SlotId): string {
  return TABLE[slot].label;
}

/** The slot's subject aliases. */
export function slotAliases(slot: SlotId): readonly string[] {
  return TABLE[slot].aliases;
}

/** Every name of a canonical value in the slot's class (the value itself first); a version is its own only name. */
export function valueNames(slot: SlotId, value: string): string[] {
  const values = TABLE[slot].values;
  return values === "version" ? [value] : [value, ...(values[value] ?? [])];
}

/** Whether a value is in the slot's class (an out-of-class value was accepted by its shape). */
export function inClass(slot: SlotId, value: string): boolean {
  const values = TABLE[slot].values;
  return values === "version" ? VERSION.test(value) : Object.hasOwn(values, value);
}

/** Whether a name of a value is also an everyday word, which needs its slot named to count (see the header). */
export function commonWord(name: string): boolean {
  return COMMON_WORDS.has(name.toLowerCase());
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VERSION = /^\d+(?:\.\d+){0,2}$/;

/** Each class name (a value or another name of it), longest first, with its slot and canonical value. */
const NAMES: readonly { name: string; slot: SlotId; value: string }[] = SLOT_IDS.flatMap((slot) => {
  const values = TABLE[slot].values;
  if (values === "version") return [];
  return Object.entries(values).flatMap(([value, others]) => [value, ...others].map((name) => ({ name, slot, value })));
}).sort((a, b) => b.name.length - a.name.length);

/** Each alias, longest first, with its slot. */
const ALIASES: readonly { alias: string; slot: SlotId }[] = SLOT_IDS.flatMap((slot) =>
  TABLE[slot].aliases.map((alias) => ({ alias, slot })),
).sort((a, b) => b.alias.length - a.alias.length);
const ALIAS = ALIASES.map(({ alias }) => escape(alias)).join("|");
const VERSION_ALIAS = ALIASES.filter(({ slot }) => TABLE[slot].values === "version")
  .map(({ alias }) => escape(alias))
  .join("|");

/** Words a form names a slot by besides its aliases and its values' names (`PRs go against V`, `we host on V`). */
const FORM_WORDS: Partial<Record<SlotId, readonly string[]>> = {
  "branch.base": ["prs", "pull requests"],
  "deploy.target": ["host", "hosts", "hosted", "deployed"],
};

/** A slot's words: its aliases, its values' names and its forms' own words. */
function slotWords(slot: SlotId): string[] {
  const values = TABLE[slot].values;
  const names = values === "version" ? [] : Object.entries(values).flatMap(([value, others]) => [value, ...others]);
  return [...TABLE[slot].aliases, ...names, ...(FORM_WORDS[slot] ?? [])];
}

/**
 * The words a slot's words are found by, with the slots each may name: a name of several words by its longest, which
 * any text holding the name holds ("github actions" by "actions", "web framework" by "framework").
 */
const WORD_SLOTS = new Map<string, Set<SlotId>>();
for (const slot of SLOT_IDS)
  for (const phrase of slotWords(slot)) {
    const word = phrase.split(" ").reduce((longest, part) => (part.length > longest.length ? part : longest));
    WORD_SLOTS.set(word, (WORD_SLOTS.get(word) ?? new Set()).add(slot));
  }

/**
 * Whether a text may state a slot (any slot, without `slot`): every form names it by one of its words. A cheap test
 * before `slotsIn`, which reads a text's clauses: a store's rows are read again by every hook process.
 */
export function mayStateSlot(text: string, slot?: SlotId): boolean {
  for (const raw of text.toLowerCase().split(/[^a-z0-9@+_.-]+/)) {
    const slots = WORD_SLOTS.get(raw.replace(/^[.-]+|[.-]+$/g, ""));
    if (slots && (!slot || slots.has(slot))) return true;
  }
  return false;
}

/** The slot an alias names (whole words, any case). */
function slotOfAlias(text: string): SlotId | undefined {
  const lower = text.toLowerCase().trim();
  return ALIASES.find(({ alias }) => alias === lower)?.slot;
}

/** The slots a text names by an alias, anywhere in it, as whole words. */
function aliasedSlots(text: string): SlotId[] {
  const found: SlotId[] = [];
  for (const match of text.toLowerCase().matchAll(new RegExp(String.raw`(?<![\w.-])(?:${ALIAS})(?![\w-])`, "g"))) {
    const slot = slotOfAlias(match[0]);
    if (slot && !found.includes(slot)) found.push(slot);
  }
  return found;
}

/** Words before or after a value that say where, when or how firmly, not what ("here", "now", "across the repo"). */
const FILLER = new RegExp(
  String.raw`(?:\s+(?:here|now|too|please|again|instead|everywhere|anymore|any more|these days|for now|today|` +
    String.raw`across the (?:repo|board|codebase)|in this repo|repo-wide|for everything|for all of it|` +
    String.raw`(?:last|this|next) (?:week|month|year|sprint|quarter)|(?:a|one|two|few) (?:days?|weeks?|months?) ago|` +
    String.raw`since \S+|in (?:the )?(?:spring|summer|autumn|fall|winter)|in (?:q[1-4]|20\d\d)|earlier this year))+$`,
  "i",
);
const LEADING = /^(?:(?:the|our|my|its|their|a|an|this|that)\s+)+/i;
/** A token D7 accepts outside a class: capitalized, or with a digit, an inner capital, a dot, a hyphen or an `@`. */
const SHAPED = /^(?:[A-Z][\w.@+-]*|[\w.@+-]*(?:\d|[a-z][A-Z]|\w[._@-]\w)[\w.@+-]*)$/;
/**
 * Words that are never a value outside a class, whatever their case: pronouns and states, placeholders, and the
 * days, months and colours a status or a plan names ("The deploy is Friday", "CI is Red again").
 */
const NOT_A_VALUE = new Set(
  (
    "it this that there here them one being something nothing none different same custom todo tbd tba wip n/a na " +
    "unknown yes no true false null undefined monday tuesday wednesday thursday friday saturday sunday january " +
    "february march april may june july august september october november december red green yellow blue orange " +
    "white grey gray purple pink"
  ).split(" "),
);
/**
 * What may follow a value its class reads (`yarn berry`, `postgres 16`): a version or an edition word. A noun after
 * it names a part of the value, not the value ("jest mocks", "the yarn lockfile", "Vercel previews").
 */
const QUALIFIER = /^(?:v?\d+(?:\.\d+){0,2}(?:\.x)?|berry|classic|modern|lts|stable|latest|nightly|canary|beta)$/i;
/** A clause longer than this is no statement of a slot, and is not read (every form fits well under it). */
const CLAUSE_MAX = 300;

/** A value phrase without its articles, its closing punctuation and the words that say where or when. */
function trimmed(phrase: string): string {
  const end = /[.,;:!?)"'`]+$/;
  return phrase.trim().replace(end, "").replace(FILLER, "").replace(end, "").replace(LEADING, "").trim();
}

/** The class name a phrase opens with: its slot, canonical value, the name as typed, and what follows it. */
function leadingName(phrase: string, slot?: SlotId): { slot: SlotId; value: string; typed: string; rest: string }[] {
  const lower = phrase.toLowerCase();
  return NAMES.filter(
    (entry) =>
      (!slot || entry.slot === slot) &&
      lower.startsWith(entry.name) &&
      !/[\w'-]/.test(lower.charAt(entry.name.length) || " "),
  ).map((entry) => ({
    slot: entry.slot,
    value: entry.value,
    typed: phrase.slice(0, entry.name.length),
    rest: phrase.slice(entry.name.length).trim(),
  }));
}

/** A version number a phrase opens with, alone or after a version slot's alias ("node 22", "v20.11"). */
function leadingVersion(phrase: string, slot?: SlotId): { slot?: SlotId; value: string } | undefined {
  const match = new RegExp(String.raw`^(?:(${VERSION_ALIAS})\s+)?v?(\d+(?:\.\d+){0,2})(?:\.x)?(?![\w.])`, "i").exec(
    phrase,
  );
  if (!match) return undefined;
  const named = match[1] ? slotOfAlias(match[1]) : undefined;
  if (named && slot && named !== slot) return undefined;
  return { ...(named || slot ? { slot: named ?? slot } : {}), value: match[2]! };
}

/**
 * How a value is read: by its class alone; or for a slot a pattern names, any value of its class or, unless
 * `classOnly`, one shaped token (D7's rule for a value outside the class).
 */
type Reading = { slot: SlotId; classOnly?: boolean } | { slot?: undefined };

/**
 * The value a phrase gives, read as `reading` allows (see the header): a class name at its start (with a version or
 * an edition word after it, or anything after it when the slot is named), a version, or, for a named slot, one shaped
 * token with a letter that is no status word, no placeholder and names no slot itself ("tests run in CI" names no test
 * runner). `named` are the slots the sentence names, which an everyday word needs.
 */
function readValue(
  raw: string,
  reading: Reading,
  named: readonly SlotId[],
): { slot: SlotId; value: string; typed: string }[] {
  const phrase = trimmed(raw);
  if (!phrase) return [];
  const slot = reading.slot;
  if (slot && TABLE[slot].values === "version") {
    const version = leadingVersion(phrase, slot);
    return version ? [{ slot, value: version.value, typed: version.value }] : [];
  }
  if (!slot) {
    const version = leadingVersion(phrase);
    if (version?.slot && /^\S+\s+\S+$/.test(phrase.split(/\s+/).slice(0, 2).join(" ")))
      return [{ slot: version.slot, value: version.value, typed: version.value }];
  }
  const names = leadingName(phrase, slot).filter(
    (name) => (slot || !name.rest || QUALIFIER.test(name.rest)) && !STATUS_LEXICON.has(name.rest),
  );
  const fit = names.filter((name) => !commonWord(name.typed) || named.includes(name.slot));
  if (fit.length) return fit;
  if (!slot || reading.classOnly || names.length) return [];
  const token = slot === "gh.account" ? accountToken(phrase) : phrase;
  if (!token || /\s|\//.test(token) || !SHAPED.test(token) || !/[a-z]/i.test(token)) return [];
  const lower = token.toLowerCase();
  if (STATUS_LEXICON.has(lower) || NOT_A_VALUE.has(lower) || slotOfAlias(lower)) return [];
  return [{ slot, value: lower, typed: token }];
}

/**
 * `readValue`, but a value said for one environment is that environment's ("sqlite for local dev", "node 18 in CI"),
 * whatever the form: it reads none; a deploy target is production's anyway ("we deploy to fly.io in production").
 */
function valueOf(
  raw: string,
  reading: Reading,
  named: readonly SlotId[],
): { slot: SlotId; value: string; typed: string }[] {
  const env = ENVIRONMENT.exec(` ${raw}`)?.[0];
  const found = readValue(raw, reading, named);
  return env ? found.filter(({ slot }) => slot === "deploy.target" && /\bprod/i.test(env)) : found;
}

/** A GitHub account in a phrase: its identifier-shaped token ("my work account acme-dev"), else the phrase. */
function accountToken(phrase: string): string {
  const words = phrase.split(/\s+/);
  return words.find((word) => /[-_\d]/.test(word)) ?? (words.length === 1 ? phrase : "");
}

/** Clause leads that say nothing of the slot ("remember that", "btw", "actually"). */
const LEAD = new RegExp(
  String.raw`^(?:(?:and|so|but|also|btw|fyi|note|reminder|remember(?: that)?|just so you know|heads up|` +
    String.raw`for the record|actually|ok|okay|oh|well|i think|i believe|pretty sure|to be clear|please)\b[:,]?\s*)+`,
  "i",
);
/** A sentence that asks or supposes (it states nothing). */
const ASKS = new RegExp(
  String.raw`^(?:what|which|who|whom|whose|where|when|why|how|do|does|did|is|are|was|were|can|could|should|` +
    String.raw`would|will|shall|have|has|if|unless|whenever|once|suppose|assuming|in case|whether|maybe|perhaps)\b`,
  "i",
);
const NOT = String.raw`(?:not|instead of|rather than)`;
/** `…, not B` after a value: B is invalidated. */
const AND_NOT = new RegExp(String.raw`^(.*?)(?:,\s*|\s+)${NOT}\s+(.+)$`, "i");

/** The sentences of a text: at sentence punctuation before a space, at line breaks, and at semicolons. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|;\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** A sentence's clauses: at commas and at `and`/`but`, a clause opening with `not` staying with the one before. */
function clausesOf(sentence: string): string[] {
  const parts = sentence.split(/,\s+|\s+(?:and|but|so|while)\s+/i);
  const clauses: string[] = [];
  for (const part of parts) {
    if (clauses.length && new RegExp(String.raw`^${NOT}\b`, "i").test(part)) clauses.push(`${clauses.pop()}, ${part}`);
    else clauses.push(part);
  }
  return clauses.map((clause) => clause.trim().replace(LEAD, "").trim()).filter(Boolean);
}

/** One clause's statement, the slot found by `read` and values set and invalidated by its phrases. */
interface Found {
  slot: SlotId;
  value?: string;
  was: string[];
}

/** A value phrase with a trailing `, not B` split off: the value, and B's phrase. */
function splitNot(phrase: string): { value: string; not?: string } {
  const match = AND_NOT.exec(phrase);
  return match ? { value: match[1]!, not: match[2]! } : { value: phrase };
}

/** An environment a value is said for: another instance of the slot's subject. */
const ENVIRONMENT =
  /\s(?:for|in|on)\s+(?:the\s+)?(?:local(?:\s+dev)?|dev|development|tests?|testing|staging|prod|production|ci)\b|\slocally\b/i;

/** The statement a phrase sets in a slot it names, with any `, not B` it carries. */
function setNamed(reading: Reading & { slot: SlotId }, phrase: string, named: readonly SlotId[]): Found[] {
  const { value, not } = splitNot(phrase);
  const set = valueOf(value, reading, [...named, reading.slot])[0];
  if (!set) return [];
  const was = not ? valueOf(not, reading, [...named, reading.slot]).map((found) => found.value) : [];
  return [{ slot: reading.slot, value: set.value, was }];
}

/** A value phrase read by its class: the statement when the value is in exactly one slot's class. */
function setByClass(phrase: string, named: readonly SlotId[]): Found[] {
  const sets = valueOf(phrase, {}, named);
  return sets.length === 1 ? [{ slot: sets[0]!.slot, value: sets[0]!.value, was: [] }] : [];
}

/**
 * The jobs a slot's value does, as `use A for X, not B` names them when X is no alias ("use Kysely for queries"). Any
 * other X is a part or an instance of the work ("for analytics", "for the global install"), not the slot.
 */
const PURPOSES: Partial<Record<SlotId, readonly string[]>> = {
  orm: ["queries", "query building", "data access", "models"],
  "db.engine": ["storage", "persistence", "data"],
  "auth.provider": ["login", "logins", "sign-in", "sessions"],
  "pkg.manager": ["dependencies", "deps"],
  framework: ["routing", "rendering", "the ui"],
  "ci.system": ["builds", "pipelines"],
};

/** Optional words between a subject and its verb ("we just switched", "we've since moved"). */
const ADVERBS = String.raw`(?:\s+(?:just|recently|finally|already|now|also|since|then|eventually|officially|all))*`;
const SUBJECT = String.raw`(?:we|i|they|it|the team|\S+\/\S+)(?:'ve|'re|\s+have|\s+had|\s+are)?`;
/** What may stand before a copula's subject: a place ("In apps/web"), an article or a possessive. */
const COPULA_LEAD = String.raw`^(?:(?:in|for|on)\s+\S+,?\s+)?(?:the\s+|our\s+|my\s+|its\s+|this repo'?s\s+|\S+\/\S+'s\s+)?`;
/** Words between a copula and its value that say how, not what ("is hosted on", "is handled by"). */
const COPULA_HOW = String.raw`(?:now\s+|still\s+|actually\s+|currently\s+|just\s+)?(?:(?:hosted|running|deployed|pinned|set)\s+(?:on|to)\s+|handled by\s+|on\s+)?`;

const COPULA = new RegExp(String.raw`${COPULA_LEAD}(${ALIAS})\s*(?:\s(?:is|are)\s+${COPULA_HOW}|=\s*|:\s*)(.+)$`, "i");
const COPULA_NOT = new RegExp(
  String.raw`${COPULA_LEAD}(${ALIAS})\s+(?:is not|isn'?t|is no longer|are not|aren'?t|are no longer)\s+(.+)$`,
  "i",
);
/** `V is our S` ("Clerk is our auth provider"): the copula the other way round. */
const COPULA_BACK = new RegExp(
  String.raw`^(\S+(?:\s+\S+)?)\s+(?:is|=)\s+(?:our|the|its)\s+(?:main\s+|default\s+|primary\s+|current\s+)?(${ALIAS})$`,
  "i",
);
const USE_FOR = new RegExp(
  String.raw`\b(?:use|uses|using|with)\s+(.+?)\s+(?:for|as)\s+(?:the\s+|our\s+|its\s+|all\s+)?(${ALIAS})\b(.*)$`,
  "i",
);
/**
 * `use A not B`, and D7's `use A for X, not B` where X names no alias but the slot's job (A's and B's class name the
 * slot, `PURPOSES`): "use Kysely for queries, not Prisma", not "use npm for the global install, not pnpm" (one task).
 */
const USE_NOT = new RegExp(
  String.raw`(?:^|\b(?:we|i)\s+(?:always\s+)?)use\s+(\S+(?:\s+\S+)?)(?:\s+for\s+([^,]{1,30}?))?\s*,?\s+${NOT}\s+(\S+(?:\s+\S+)?)`,
  "i",
);
const SWITCH = new RegExp(String.raw`^(?:${SUBJECT}${ADVERBS}\s+)?(?:switched|moved|migrated)\b(.*)$`, "i");
const REPLACED = new RegExp(
  String.raw`^${SUBJECT}${ADVERBS}\s+(?:replaced|swapped)\s+(.+?)\s+(?:with|for)\s+(.+)$`,
  "i",
);
/**
 * D7's and A4 §3.1's retractions only: `we (don't|do not|no longer) use V (anymore)`, `we're dropping V`, `we dropped
 * V`, `we're not (on|using) V anymore`, `we're no longer (on|using) V`. V must end its clause (`valued`).
 */
const RETRACT = new RegExp(
  String.raw`^we${ADVERBS}\s+(?:(?:don'?t|do not|no longer)\s+use|(?:'ve\s+|have\s+)?dropped)\s+(.+)$|` +
    String.raw`^we(?:'re|\s+are)${ADVERBS}\s+(?:dropping|no longer\s+(?:on|using))\s+(.+)$|` +
    String.raw`^we(?:'re\s+not|\s+are\s+not|\s+aren'?t)\s+(?:on|using)\s+(.+?\s+any ?more)[.!]*$`,
  "i",
);
const BARE_USE = new RegExp(
  String.raw`^(?:(?:we|i|let'?s)\s+)?(?:(?:always|now|also|still|just|currently|mostly)\s+)?` +
    String.raw`(?:use|went with|go with|chose|picked|settled on|standardized on|decided on)\s+(.+)$`,
  "i",
);
const ON = /^we(?:'re|\s+are)\s+(?:now\s+)?(?:on|using)\s+(?:now\s+)?(.+)$/i;
/** R8's `everything is V now`, read by V's class. */
const EVERYTHING = /^everything(?:'s|\s+is)\s+(?:now\s+)?(?:on\s+|in\s+)?(.+)$/i;
const RUNS_ON = new RegExp(
  String.raw`^(?:(?:our|the|all)\s+)?(${ALIAS})\s+(?:run|runs|go|goes|are run|is run|use|uses|are using|is using)` +
    String.raw`(?:\s+(?:on|with|in|through|via|by|to|against))?\s+(.+)$`,
  "i",
);
/**
 * A practice that names its slot, with the tool it is done with ("we lint with biome"): only with "we", since an
 * instruction is one task ("install the dependencies with npm" sets no package manager).
 */
const VERB_WITH =
  /^we\s+(?:always\s+)?(lint|format|test|install|package)\s+(?:\S+\s+){0,2}?(?:with|using|via)\s+(.+)$/i;
const VERB_SLOTS: Readonly<Record<string, SlotId>> = {
  lint: "linter",
  format: "formatter",
  test: "test.runner",
  install: "pkg.manager",
  package: "pkg.manager",
};
/** D7's `we (deploy|host) (to|on) V`: no other subject or object, since a deploy of something is that thing's. */
const DEPLOY = /^we\s+(?:(?:now|currently|always)\s+)?(?:deploy|host)\s+(?:to|on)\s+(.+)$/i;
const PRS = /^(?:our\s+|all\s+)?(?:prs|pull requests)\s+(?:go|goes|should go|target)\s+(?:against|into|to)\s+(.+)$/i;
const PATH_USES = /^\S+\/\S+\s+(?:uses|runs|runs on|is on)\s+(.+)$/i;
const ANAPHORA = /^(?:now\s+)?(?:it'?s|it is)\s+(?:now\s+)?(.+)$/i;
/** A value read by its class with its slot named after it ("on GitHub Actions for CI"). */
const FOR_SLOT = new RegExp(String.raw`^(.+?)\s+(?:for|as)\s+(?:the\s+|our\s+|its\s+)?(${ALIAS})\b`, "i");

/** A switch's subject that is the whole app or one side of it, not another instance ("the api", "our backend"). */
const WHOLE_APP = /^(?:(?:the|our|its)\s+)?(?:api|app|backend|frontend|server|client|web)$/i;

/** A switch's tail after its verb: `X from B to A`, `X to A from B`, or `X from B`. */
function switchOf(tail: string, named: readonly SlotId[]): Found[] {
  const shapes = [
    /^(.*?)\bfrom\s+(.+?)\s+to\s+(.+)$/i,
    /^(.*?)\bto\s+(.+?)\s+from\s+(.+)$/i,
    /^(.*?)\bto\s+(.+)$/i,
    /^(.*?)\bfrom\s+(.+)$/i,
  ];
  for (const [at, shape] of shapes.entries()) {
    const match = shape.exec(tail.trim());
    if (!match) continue;
    const subject = match[1]!;
    const [to, from] = at === 0 ? [match[3], match[2]] : at === 1 ? [match[2], match[3]] : at === 2 ? [match[2]] : [];
    const fromOnly = at === 3 ? match[2] : undefined;
    const slot = aliasedSlots(subject)[0];
    // X names something that is no slot ("the helpers", "branches"): the switch is about it, not a slot, unless X is
    // the whole app or one side of it and the switch goes from one value of a class to another ("switched the api to
    // fastify from express"); "the docs site", "the users table" are other instances. A path in X says where ("we
    // switched apps/web from Auth0 to Clerk").
    const rest = subject
      .replace(/\S*\/\S*/g, " ")
      .replace(/\b(?:over|everything|all|it|things|stuff|back|fully|entirely)\b/gi, "");
    // An alias with another word beside it is another instance ("the e2e tests"), but for a word naming the whole
    // app or one side of it ("web auth").
    const qualified = rest
      .toLowerCase()
      .replace(new RegExp(String.raw`(?<![\w-])(?:${ALIAS})(?![\w-])`, "g"), " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !/^(?:the|our|its)$/.test(word) && !WHOLE_APP.test(word));
    if (slot && qualified.length) return [];
    const reading: Reading = slot ? { slot } : {};
    let sets = to ? valueOf(to, reading, named) : [];
    let olds = from ? valueOf(from, reading, named) : [];
    // One side's class names the slot the other is read in ("to fastify from express": express is a framework there).
    const within = (phrase: string, found: ReturnType<typeof valueOf>) =>
      found.flatMap((other) => valueOf(phrase, { slot: other.slot, classOnly: true }, [...named, other.slot]));
    if (to && from && sets.length && !olds.length) olds = within(from, sets);
    else if (to && from && olds.length && !sets.length) sets = within(to, olds);
    // A switch of the component X ("the api") changes a slot when its old and new values share one's class.
    const classChange = !!from && sets.some((set) => olds.some((old) => old.slot === set.slot));
    if (!slot && /\w{3,}/.test(rest) && !(classChange && WHOLE_APP.test(rest.trim()))) return [];
    if (fromOnly) {
      const gone = valueOf(fromOnly, reading, named);
      return gone[0] ? [{ slot: gone[0].slot, was: [gone[0].value] }] : [];
    }
    return changeOf(sets, olds);
  }
  return [];
}

/** A change from the old values to one of the new: the new one sharing a slot with an old one, else the first. */
function changeOf(sets: ReturnType<typeof valueOf>, olds: ReturnType<typeof valueOf>): Found[] {
  const pick = sets.find((set) => olds.some((old) => old.slot === set.slot)) ?? sets[0];
  if (!pick) return [];
  const was = olds.filter((old) => old.slot === pick.slot && old.value !== pick.value).map((old) => old.value);
  return [{ slot: pick.slot, value: pick.value, was }];
}

/** `use A not B`: A and B in one slot's class (B's slot when A's is in none), A set and B invalidated. */
function useNot(a: string, b: string, named: readonly SlotId[]): Found[] {
  const sets = valueOf(a, {}, named);
  // B may run on into the rest of the clause ("not npm for scripts"): its first word, then.
  const whole = valueOf(b, {}, named);
  const olds = whole.length ? whole : valueOf(b.split(/\s+/)[0]!, {}, named);
  if (sets.length) return changeOf(sets, olds);
  const old = olds[0];
  const set = old && valueOf(a, { slot: old.slot }, named)[0];
  return old && set ? [{ slot: old.slot, value: set.value, was: [old.value] }] : [];
}

/** What a clause states when one of D7's forms reads it; undefined when the form does not match. */
type Reader = (clause: string, named: readonly SlotId[], previous: readonly Found[]) => Found[] | undefined;
const alias = (text: string) => slotOfAlias(text)!;

/** D7's forms (see the header), in the order they are tried: the first that states something wins. */
const READERS: readonly Reader[] = [
  (clause, named) => {
    const match = COPULA_NOT.exec(clause);
    const gone = match && valueOf(match[2]!, { slot: alias(match[1]!) }, named)[0];
    return gone ? [{ slot: gone.slot, was: [gone.value] }] : undefined;
  },
  (clause, named) => {
    const match = COPULA.exec(clause);
    if (!match) return undefined;
    // A person's own setup is no repo's slot ("my node version is 18"); an account is a person's by nature.
    if (/^my\s/i.test(clause) && alias(match[1]!) !== "gh.account") return [];
    return setNamed({ slot: alias(match[1]!) }, match[2]!, named);
  },
  (clause, named) => {
    const match = COPULA_BACK.exec(clause);
    return match ? setNamed({ slot: alias(match[2]!) }, match[1]!, named) : undefined;
  },
  (clause, named) => {
    const match = USE_FOR.exec(clause);
    if (!match) return undefined;
    const slot = alias(match[2]!);
    const found = setNamed({ slot }, match[1]!, named);
    const not = splitNot(match[3]!).not;
    if (found[0] && not) found[0].was.push(...valueOf(not, { slot }, named).map((old) => old.value));
    return found;
  },
  (clause, named) => {
    const match = USE_NOT.exec(clause);
    if (!match) return undefined;
    const found = useNot(match[1]!, match[3]!, named);
    const job = match[2]?.trim().toLowerCase();
    return job && !found.every(({ slot }) => PURPOSES[slot]?.includes(job)) ? [] : found;
  },
  (clause, named) => {
    const match = SWITCH.exec(clause);
    return match ? switchOf(match[1]!, named) : undefined;
  },
  (clause, named) => {
    const match = REPLACED.exec(clause);
    return match ? useNot(match[2]!, match[1]!, named) : undefined;
  },
  (clause, named) => {
    const match = RETRACT.exec(clause);
    const gone = match ? valueOf(match[1] ?? match[2] ?? match[3]!, {}, named) : [];
    const pick = gone.find((found) => named.includes(found.slot)) ?? gone[0];
    return pick ? [{ slot: pick.slot, was: [pick.value] }] : undefined;
  },
  (clause, named) => {
    const match = RUNS_ON.exec(clause);
    return match ? setNamed({ slot: alias(match[1]!), classOnly: true }, match[2]!, named) : undefined;
  },
  (clause, named) => {
    const match = VERB_WITH.exec(clause);
    return match
      ? setNamed({ slot: VERB_SLOTS[match[1]!.toLowerCase()]!, classOnly: true }, match[2]!, named)
      : undefined;
  },
  (clause, named) => {
    const match = DEPLOY.exec(clause);
    return match ? setNamed({ slot: "deploy.target" }, match[1]!, named) : undefined;
  },
  (clause, named) => {
    const match = PRS.exec(clause);
    return match ? setNamed({ slot: "branch.base" }, match[1]!, named) : undefined;
  },
  (clause, named, previous) => {
    const match = ANAPHORA.exec(clause);
    return match && previous.length ? setNamed({ slot: previous.at(-1)!.slot }, match[1]!, named) : undefined;
  },
];

/** D7's forms read by the value's class alone (`we're on V`, `<scope> uses V`, the bare `use V`). */
function valued(clause: string, named: readonly SlotId[]): Found[] | undefined {
  const match = ON.exec(clause) ?? EVERYTHING.exec(clause) ?? PATH_USES.exec(clause) ?? BARE_USE.exec(clause);
  if (!match) return undefined;
  const forSlot = FOR_SLOT.exec(match[1]!);
  return forSlot ? setNamed({ slot: alias(forSlot[2]!) }, forSlot[1]!, named) : setByClass(match[1]!, named);
}

/** A reminder to do something ("don't forget to use …"), which states no slot (as D9's fix 2 states no rule). */
const REMINDER = /^(?:don'?t|do not|never) forget to\b|^(?:remember|make sure) to\b/i;

/**
 * The statements of one sentence, a question, a conditional or a reminder giving none. A clause of a value alone
 * after a clause read by its class is read the same way ("we use pnpm and vitest"). A slot gets one value in a
 * sentence, its first.
 */
function sentenceStatements(sentence: string): Found[] {
  const plain = sentence.trim().replace(LEAD, "");
  if (/\?\s*$/.test(plain) || ASKS.test(plain) || REMINDER.test(plain)) return [];
  const named = aliasedSlots(plain);
  const found: Found[] = [];
  let byClass = false;
  for (const clause of clausesOf(plain)) {
    if (ASKS.test(clause)) break;
    if (clause.length > CLAUSE_MAX) continue;
    const context = [...named, ...found.map((f) => f.slot)];
    let read: Found[] | undefined;
    for (const reader of READERS) if ((read = reader(clause, context, found))) break;
    const stated: Found[] = read?.length
      ? read
      : (valued(clause, context) ?? (byClass ? setByClass(clause, context) : []));
    byClass = !read?.length && stated.length > 0;
    // One value per slot in a sentence: a later clause's names a part of it ("postgres, it's PG15").
    found.push(...stated.filter((f) => f.value === undefined || !found.some((o) => o.slot === f.slot && o.value)));
  }
  return found;
}

/** Bounded memo of readings: every delivery point and every write reads rows' texts again. */
const READINGS = new Map<string, SlotStatement[]>();
const READINGS_KEPT = 4_096;

/** The slot statements a typed text makes (see the header), sentence by sentence, each (slot, value) once. */
export function slotsIn(text: string): SlotStatement[] {
  const key = String(text ?? "");
  const known = READINGS.get(key);
  if (known) return known;
  const out: SlotStatement[] = [];
  for (const sentence of sentencesOf(key))
    for (const found of sentenceStatements(sentence)) {
      const was = [...new Set(found.was.filter((value) => value !== found.value))];
      const same = out.find((s) => s.slot === found.slot && s.value === found.value);
      if (same) same.was = [...new Set([...same.was, ...was])];
      else if (found.value !== undefined || was.length)
        out.push({ slot: found.slot, ...(found.value === undefined ? {} : { value: found.value }), was });
    }
  if (READINGS.size >= READINGS_KEPT) READINGS.clear();
  READINGS.set(key, out);
  return out;
}

/** D12 first: the slot statements of a text without its pasted spans (`eden memory extract`). */
export function extractSlots(text: string): SlotStatement[] {
  return slotsIn(stripPastes(String(text ?? "")));
}

/** A text's slots as a row stores them. */
export function slotRefs(statements: readonly SlotStatement[]): SlotRef[] {
  return statements.map(({ slot, value, was }) => ({
    k: slot,
    ...(value === undefined ? {} : { v: value }),
    ...(was.length ? { x: [...was] } : {}),
  }));
}

/**
 * A note's slots: the keys its row stores, else, for a fact the user typed that was written before P3.3 kept keys, the
 * keys its text states. A row the user did not type, a rule and an episode state none (D6, A4 §3.0).
 */
export function noteSlots(note: ProvenanceNote): readonly SlotRef[] {
  if (note.slots) return note.slots;
  if (isUntyped(note) || note.rules?.length || noteKindToken(note) !== "fact") return [];
  const body = stripPacketLabel(String(note.text ?? "")).body;
  return mayStateSlot(body) ? slotRefs(slotsIn(body)) : [];
}

/** Whether a text names the slot by one of its aliases, as a whole word. */
export function namesSlot(text: string, slot: SlotId): boolean {
  return aliasedSlots(text).includes(slot);
}

/**
 * The slots a name of a value is in, by class ("biome": formatter and linter); none for a version, whose number alone
 * names no slot.
 */
export function slotsOfName(name: string): SlotId[] {
  const lower = name.toLowerCase();
  return [...new Set(NAMES.filter((entry) => entry.name === lower).map((entry) => entry.slot))];
}

/** A canonical value as a text types it ("Auth0", "PostgreSQL"), else the value itself. */
export function typedValue(text: string, slot: SlotId, value: string): string {
  for (const name of valueNames(slot, value)) {
    const match = new RegExp(String.raw`(?<![\w.@/-])${escape(name)}(?![\w@/-]|\.\w)`, "i").exec(text);
    if (match) return match[0];
  }
  return value;
}

/**
 * A4 §5.1 step 4a's slot detector (R2 §6.1b; A7 §1 layer 2): which slots a cue asks about, so each one's live value is
 * looked up by key (STRONG, A7 §4) whatever words the cue shares with the row stating it. It reads the user's own
 * words: the typed prompt, and on a continuation the proposal it accepts (`AgentMemory.recall`). R2's cold-start
 * lexicon, calibrated as R2 asks: no prompt of the silence set (`memory-silence-seeds.json`: R1's dev negatives and
 * R8's 98, A7 §4's seeds) names a slot by it.
 * - **A seed** (`SEEDS`) names its slot alone: a phrase that names nothing else ("package manager", "test runner",
 *   "lockfile", ".nvmrc", "install the dependencies"). Calibration leaves out every word the silence set holds: bare
 *   "install" ("how do I install node on Ubuntu"), "database", "auth", "node", "deploy", "ci", "test".
 * - **A word of a slot's topic** (its aliases and R2's cold-start words: "database", "login", "spec", "sso") names it
 *   only in a cue about this project (`OURS`: "we", "our", "us", "this repo"): "what database do we use?" asks for this
 *   repo's value; "explain database indexes", "how does SSO work with SAML?" or "the log in the console" do not. No
 *   silence prompt holds an ownership word, and "let us", "tell us" are none.
 * - **A bundle** (A7 §7, indirect need): a cue setting up this project ("how do I set up the repo on a new laptop?")
 *   names the slots a setup needs, the package manager and the node version (`SETUP_BUNDLE`). A7's "env location" is
 *   no D7 slot, so it has no key to look up.
 *
 * A phrase is matched as words of the cue's prose, never inside a path or a filename ("login" in `app/login.ts`): a
 * path is STRONG evidence of its own. Each slot's phrases are one regular expression, compiled once.
 */
const SEEDS: Readonly<Record<SlotId, readonly string[]>> = {
  "auth.provider": ["auth provider", "authentication provider", "login provider", "identity provider"],
  "pkg.manager": [
    "package manager",
    "pkg manager",
    "deps",
    "install deps",
    "install the deps",
    "install dependencies",
    "install the dependencies",
    "install packages",
    "install the packages",
    "installs",
    "installing",
    "reinstall",
    "lockfile",
    "lock file",
    "add a package",
    "add package",
  ],
  "db.engine": ["database engine", "db engine"],
  orm: [],
  "test.runner": ["test runner", "test framework"],
  "node.version": ["node.js version", "node version", ".nvmrc", "nvmrc", "nvm"],
  "lang.version": [
    "language version",
    "typescript version",
    "ts version",
    "python version",
    "go version",
    "rust version",
  ],
  framework: ["web framework", "frontend framework", "backend framework"],
  "deploy.target": ["deploy target", "deployment target", "hosting provider"],
  "ci.system": ["ci system", "ci provider"],
  formatter: [],
  linter: [],
  "commit.style": ["commit message style", "commit convention", "commit style"],
  "branch.base": ["base branch", "default branch"],
  "gh.account": ["github account", "github user", "gh account"],
};

/** R2 §6.1b's cold-start words beyond D7's aliases: words of a slot's topic, naming it in a cue about this project. */
const TOPIC_WORDS: Partial<Record<SlotId, readonly string[]>> = {
  "auth.provider": ["login", "log in", "sign in", "sign-in", "signin", "sso"],
  "test.runner": ["spec", "specs", "test suite"],
  formatter: ["reformat"],
};

/**
 * A cue about the user's own project: "we", "our", "this repo", and "us" in lowercase, not after "let", "tell" (see
 * `cuedSlots`): "US hosting" is a country.
 */
const OURS =
  /(?<![a-z0-9])(?:we|we['’](?:re|ve|d)|our|ours|this (?:repo|monorepo|workspace|project|codebase|app|service))(?![a-z0-9])/i;
const US = /(?<![A-Za-z0-9])(?<!\b(?:[Ll]et|[Tt]ell|[Ss]how|[Gg]ive|[Hh]elp|[Ss]end|[Aa]sk) )us(?![A-Za-z0-9])/;
/** A cue setting up this project (A7 §7's bundle): a setup word, and this repo, a new machine, or a local setup. */
const SETUP = /(?<![a-z0-9])(?:set ?up|onboard(?:ing)?|get(?:ting)? started|bootstrap(?:ping)?)(?![a-z0-9])/i;
const SETUP_HERE =
  /(?<![a-z0-9])(?:(?:the|this) (?:repo|project|codebase|monorepo|workspace)|locally|(?:new|my) (?:laptop|machine|computer))(?![a-z0-9])/i;
export const SETUP_BUNDLE: readonly SlotId[] = ["pkg.manager", "node.version"];

/** The slots each phrase names, and one expression matching any of them as words of a cue's prose (see the header). */
function lexicon(bySlot: (slot: SlotId) => readonly string[]): { slots: Map<string, SlotId[]>; re: RegExp } {
  const slots = new Map<string, SlotId[]>();
  for (const slot of SLOT_IDS)
    for (const phrase of bySlot(slot)) slots.set(phrase, [...(slots.get(phrase) ?? []), slot]);
  const alternation = [...slots.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|");
  // A character before the phrase is consumed rather than looked behind for: a look-behind at every position of a
  // long prompt cost ten times as much.
  return { slots, re: new RegExp(`(?:^|[^\\w./-])(${alternation})(?![\\w/-]|\\.\\w)`, "gi") };
}

const SEED_LEXICON = lexicon((slot) => SEEDS[slot]);
const TOPIC_LEXICON = lexicon((slot) => [...TABLE[slot].aliases, ...(TOPIC_WORDS[slot] ?? [])]);

/** The slots a lexicon's phrases name in a cue. */
function named(cue: string, { slots, re }: ReturnType<typeof lexicon>): Set<SlotId> {
  return new Set([...cue.matchAll(re)].flatMap((match) => slots.get(match[1]!.toLowerCase()) ?? []));
}

/** The slots a cue asks about (see the header): each one's live value is looked up by key. */
export function cuedSlots(text: string): SlotId[] {
  const cue = String(text ?? "");
  const ours = OURS.test(cue) || US.test(cue);
  const hits = named(cue, SEED_LEXICON);
  if (ours) for (const slot of named(cue, TOPIC_LEXICON)) hits.add(slot);
  if (SETUP.test(cue) && (ours || SETUP_HERE.test(cue))) for (const slot of SETUP_BUNDLE) hits.add(slot);
  return SLOT_IDS.filter((slot) => hits.has(slot));
}
