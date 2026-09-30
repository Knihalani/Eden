/**
 * World and cases for the hard memory bench (hard.ts). Pure data and seeded generators: no product import,
 * no clock, no network. Every sentence template, paraphrase, alias and negative below is hand-written.
 * The seeds only choose which template, value and position each generated item gets.
 */

export type Split = "dev" | "test";
export type RepoId = "acme-shop" | "acme-infra" | "acme-data";
export type Category =
  | "anchor"
  | "named"
  | "para"
  | "alias"
  | "path"
  | "repo"
  | "stale"
  | "distract"
  | "redundant"
  | "ack"
  | "nonhuman"
  | "chatter"
  | "offtopic";

/** A sentence the simulated user said that the oracle knows the meaning of. */
export type Statement = {
  id: string;
  session: number;
  repo: RepoId;
  text: string;
  /** World slot, e.g. `billing.db`, `repo:acme-shop.pkg`, `anchor.kestrel`. */
  slot: string;
  /** The value this sentence asserts for the slot (`none` = the slot was emptied). */
  value?: string;
  /** A value this sentence denies ("we do not use X"). */
  not?: string;
};

export type WorldEvent = { session: number; repo: RepoId; text: string; stmt?: Statement };

export type World = {
  sessions: number;
  events: WorldEvent[];
  statements: Statement[];
  filler: string[];
  /** Latest asserted value per slot, after the last session. */
  current: Map<string, string>;
  /** Base (unit, slot) pairs by split, and pairs with a history or a distractor. */
  pairs: { split: Split; unit: string; slot: SlotId; tag: "plain" | "history" | "staging" | "negation" }[];
};

export type HardCase = {
  id: string;
  split: Split;
  category: Category;
  repo: RepoId;
  /** The previous assistant message, when the case has one. */
  prev?: string;
  cue: string;
  needs: string[];
  /** Slots whose current value the cue itself states (the simulated context window). */
  states: string[];
};

const SEEDS = { world: 20260930, dev: 0xde7, test: 0x7e57 } as const;
const SESSIONS = 8;
export const FILLER_ROWS = 20000;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Cue text: kept as typed (lower case). */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

/** Stored text: a sentence starts with a capital. */
function sentence(template: string, vars: Record<string, string>): string {
  const text = fill(template, vars);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const REPOS: { id: RepoId; cwd: string }[] = [
  { id: "acme-shop", cwd: "/work/acme-shop" },
  { id: "acme-infra", cwd: "/work/acme-infra" },
  { id: "acme-data", cwd: "/work/acme-data" },
];

type Unit = { id: string; repo: RepoId; folder: string; filler: number; alias: Record<Split, string> };

/** `filler` is the unit's share of the 20k background rows: a few busy services, a long tail of quiet ones. */
export const UNITS: Unit[] = [
  { id: "billing", repo: "acme-shop", folder: "services/billing", filler: 4200,
    alias: { dev: "the invoicing service", test: "the thing that charges customers" } },
  { id: "storefront", repo: "acme-shop", folder: "apps/storefront", filler: 3600,
    alias: { dev: "the site shoppers browse", test: "the customer-facing shop" } },
  { id: "search", repo: "acme-shop", folder: "services/search", filler: 3000,
    alias: { dev: "product lookup", test: "the find-a-product backend" } },
  { id: "gateway", repo: "acme-infra", folder: "services/gateway", filler: 2500,
    alias: { dev: "the edge proxy", test: "the entry point for all inbound traffic" } },
  { id: "admin", repo: "acme-shop", folder: "apps/admin", filler: 1600,
    alias: { dev: "the back-office panel", test: "the internal staff console" } },
  { id: "ingest", repo: "acme-data", folder: "pipelines/ingest", filler: 1500,
    alias: { dev: "the CSV importer", test: "the raw-file loader" } },
  { id: "billing-worker", repo: "acme-shop", folder: "services/billing-worker", filler: 1100,
    alias: { dev: "the async invoicing runner", test: "the offline charging process" } },
  { id: "notifier", repo: "acme-infra", folder: "services/notifier", filler: 900,
    alias: { dev: "the service that sends emails and push alerts", test: "the messaging fan-out service" } },
  { id: "search-indexer", repo: "acme-shop", folder: "services/search-indexer", filler: 600,
    alias: { dev: "the catalog reindexing process", test: "the product-index builder" } },
  { id: "warehouse-api", repo: "acme-data", folder: "services/warehouse-api", filler: 450,
    alias: { dev: "the analytics query service", test: "the BI backend" } },
  { id: "scheduler", repo: "acme-infra", folder: "services/scheduler", filler: 250,
    alias: { dev: "the cron runner", test: "the thing that fires timed work" } },
  { id: "reports", repo: "acme-data", folder: "pipelines/reports", filler: 150,
    alias: { dev: "the nightly finance exports", test: "the spreadsheet generator" } },
  { id: "deployer", repo: "acme-infra", folder: "tools/deployer", filler: 90,
    alias: { dev: "our release tooling", test: "the rollout CLI" } },
  { id: "scoring", repo: "acme-data", folder: "services/scoring", filler: 60,
    alias: { dev: "the fraud model server", test: "the risk scorer" } },
];

/** Near-duplicate unit names: a cue about one must not pull the other's facts. */
const SIBLINGS: [string, string][] = [
  ["billing", "billing-worker"],
  ["search", "search-indexer"],
];

export type SlotId = "db" | "auth" | "ci" | "cache" | "queue" | "deploy" | "errors" | "tests";

type SlotDef = {
  /** Every fact template contains this word, and so does every named cue. */
  key: string;
  values: string[];
  facts: string[];
  updates: string[];
  /** "We moved X from A to B": value-bearing, but not always with the key word. */
  migrations: string[];
  drops: string[];
  negations: string[];
  named: Record<Split, string[]>;
  /** Paraphrases share no content word with any fact template of the slot. */
  para: Record<Split, string[]>;
  /** `{p}` is a file path inside the unit's folder. */
  path: Record<Split, string[]>;
  files: string[];
};

export const SLOTS: Record<SlotId, SlotDef> = {
  db: {
    key: "database",
    values: ["Postgres", "MySQL", "SQLite", "DynamoDB", "MongoDB", "CockroachDB", "Cassandra", "MariaDB"],
    facts: ["The {u} database is {v}.", "{u} keeps its data in a {v} database.", "Our {u} database runs on {v}."],
    updates: ["The {u} database is now {v}."],
    migrations: ["We moved {u} from {old} to {v}.", "We migrated the {u} database off {old} and onto {v}."],
    drops: [],
    negations: ["{u} does not use {x}.", "We never adopted {x} for {u}."],
    named: {
      dev: ["which database does {u} use?", "what database is {u} on?"],
      test: ["what's the {u} database?", "{u} database: which one is it?"],
    },
    para: {
      dev: ["where does {u} store its records?", "what datastore sits behind {u}?",
        "which engine holds the tables for {u}?"],
      test: ["what does {u} persist rows into?", "what storage backend lives underneath {u}?",
        "when {u} saves an order, where does it end up?"],
    },
    path: {
      dev: ["{p} keeps timing out on connect. which database is this talking to?"],
      test: ["{p} has a slow query. what database engine is underneath it?"],
    },
    files: ["src/db/pool.ts", "src/repo/queries.ts", "migrations/0042_add_index.sql"],
  },
  auth: {
    key: "auth",
    values: ["Clerk", "Auth0", "Okta", "Cognito", "Keycloak", "WorkOS"],
    facts: ["{u} auth is handled by {v}.", "Auth for {u} goes through {v}.", "The {u} auth provider is {v}."],
    updates: ["The {u} auth provider is now {v}."],
    migrations: ["{u} switched auth from {old} to {v}.", "We replaced {old} with {v} in {u}."],
    drops: [],
    negations: ["{u} does not use {x}.", "We never adopted {x} for {u}."],
    named: {
      dev: ["what does {u} use for auth?", "who handles auth for {u}?"],
      test: ["which auth setup does {u} have?", "{u} auth: what is it?"],
    },
    para: {
      dev: ["how do people sign in to {u}?", "who issues login tokens for {u}?", "how does {u} know who a user is?"],
      test: ["what identity service does {u} trust?", "which vendor verifies passwords for {u}?",
        "where do sessions come from when someone logs into {u}?"],
    },
    path: {
      dev: ["{p} rejects every login. what auth setup sits behind it?"],
      test: ["{p} keeps redirecting in a loop. which auth vendor is this?"],
    },
    files: ["src/auth/session.ts", "middleware/require-user.ts", "src/login/callback.ts"],
  },
  ci: {
    key: "pipeline",
    values: ["GitHub Actions", "Buildkite", "CircleCI", "Jenkins", "GitLab CI", "Drone"],
    facts: ["The {u} CI pipeline runs on {v}.", "{u} has its CI pipeline on {v}.", "Every {u} pipeline builds on {v}."],
    updates: ["The {u} CI pipeline now runs on {v}."],
    migrations: ["We moved {u} from {old} to {v}.", "The {u} pipeline moved off {old} and onto {v}."],
    drops: [],
    negations: ["{u} does not use {x}.", "We never adopted {x} for {u}."],
    named: {
      dev: ["where does the {u} CI pipeline run?", "what does the {u} pipeline build on?"],
      test: ["which CI pipeline service does {u} use?", "{u} pipeline: which CI?"],
    },
    para: {
      dev: ["what executes the checks when I open a pull request against {u}?",
        "where do {u} changes get verified after a push?"],
      test: ["which system goes red when a commit to {u} breaks something?", "what automation gates merges into {u}?"],
    },
    path: {
      dev: ["{p} fails only in CI. which pipeline service runs it?"],
      test: ["{p} passes locally but not on the pipeline. which CI is that?"],
    },
    files: ["ci/config.yml", "scripts/ci-test.sh", "ci/steps.yml"],
  },
  cache: {
    key: "cache",
    values: ["Redis", "Memcached", "Varnish", "Hazelcast", "KeyDB"],
    facts: ["The {u} cache is {v}.", "{u} keeps a {v} cache in front of its reads.",
      "Hot reads in {u} hit a {v} cache."],
    updates: ["The {u} cache is now {v}."],
    migrations: ["We moved {u} from {old} to {v}.", "The {u} cache moved from {old} to {v}."],
    drops: ["{u} no longer has a cache; we removed {old}.", "We dropped {old} from {u} entirely."],
    negations: ["{u} does not use {x}.", "We never adopted {x} for {u}."],
    named: {
      dev: ["what cache does {u} use?", "which cache sits in front of {u}?"],
      test: ["{u} cache: which one?", "what's the {u} cache?"],
    },
    para: {
      dev: ["what stops {u} from going to storage on every request?", "where does {u} stash values it looks up often?"],
      test: ["what in-memory store does {u} lean on?", "what makes repeat lookups in {u} fast?"],
    },
    path: {
      dev: ["{p} returns old values after a write. which cache is involved?"],
      test: ["{p} misses constantly. what cache is it talking to?"],
    },
    files: ["src/cache/client.ts", "src/cache/keys.ts", "src/lib/memo.ts"],
  },
  queue: {
    key: "queue",
    values: ["Kafka", "RabbitMQ", "SQS", "NATS", "Pub/Sub"],
    facts: ["The {u} queue is {v}.", "{u} uses {v} as its job queue.",
      "Background jobs for {u} go through the {v} queue."],
    updates: ["The {u} queue is now {v}."],
    migrations: ["We moved {u} from {old} to {v}.", "The {u} queue moved from {old} to {v}."],
    drops: ["{u} no longer uses a queue; we removed {old}.", "We dropped {old} from {u} entirely."],
    negations: ["{u} does not use {x}.", "We never adopted {x} for {u}."],
    named: {
      dev: ["what queue does {u} use?", "which queue do {u} jobs go through?"],
      test: ["{u} queue: which one?", "what's the {u} queue?"],
    },
    para: {
      dev: ["what broker carries messages out of {u}?", "how does {u} hand work off to its workers?"],
      test: ["where do {u} async tasks get enqueued?", "what does {u} emit its domain messages onto?"],
    },
    path: {
      dev: ["{p} drops messages under load. which queue is behind it?"],
      test: ["{p} processes the same message twice. what queue does it read from?"],
    },
    files: ["src/events/publish.ts", "src/jobs/consumer.ts", "src/jobs/retry.ts"],
  },
  deploy: {
    key: "deploy",
    values: ["Kubernetes", "Fly.io", "Vercel", "ECS", "Heroku", "Cloud Run", "Nomad"],
    facts: ["The {u} deploy target is {v}.", "Each {u} deploy goes to {v}.", "We deploy {u} onto {v}."],
    updates: ["The {u} deploy target is now {v}."],
    migrations: ["We moved {u} from {old} to {v}.", "Every {u} deploy moved from {old} to {v}."],
    drops: [],
    negations: ["{u} does not use {x}.", "We never adopted {x} for {u}."],
    named: {
      dev: ["where does {u} deploy?", "what's the {u} deploy target?"],
      test: ["{u} deploy: where to?", "which platform do we deploy {u} on?"],
    },
    para: {
      dev: ["where does {u} live once it ships?", "what platform serves {u} to real traffic?"],
      test: ["once a {u} release is out, what is it sitting on?", "which infrastructure hosts {u} for customers?"],
    },
    path: {
      dev: ["{p} changed. where will the next deploy of it go?"],
      test: ["{p} needs a hotfix. which platform do we deploy it to?"],
    },
    files: ["deploy/manifest.yaml", "deploy/config.toml", "scripts/release.sh"],
  },
  errors: {
    key: "errors",
    values: ["Sentry", "Datadog", "Honeycomb", "Rollbar", "Bugsnag", "New Relic"],
    facts: ["{u} reports errors to {v}.", "Errors from {u} land in {v}.", "The {u} errors dashboard lives in {v}."],
    updates: ["{u} now reports errors to {v}."],
    migrations: ["We moved {u} from {old} to {v}.", "{u} errors moved from {old} to {v}."],
    drops: [],
    negations: ["{u} does not use {x}.", "We never adopted {x} for {u}."],
    named: {
      dev: ["where do {u} errors go?", "what collects {u} errors?"],
      test: ["{u} errors: where are they?", "which tool gets the {u} errors?"],
    },
    para: {
      dev: ["if {u} crashes, where do I find the stack trace?", "what pages us when {u} blows up?"],
      test: ["where would a {u} panic show up?", "where can I see {u} failures in prod?"],
    },
    path: {
      dev: ["{p} threw in prod last night. where do its errors go?"],
      test: ["{p} crashes on startup. where can I see the errors?"],
    },
    files: ["src/errors/report.ts", "src/main.ts", "src/lib/telemetry.ts"],
  },
  tests: {
    key: "tests",
    values: ["Vitest", "Jest", "pytest", "Playwright", "Mocha"],
    facts: ["{u} tests run with {v}.", "We run the {u} tests with {v}.", "The {u} tests use {v}."],
    updates: ["{u} tests now run with {v}."],
    migrations: ["We moved {u} from {old} to {v}.", "The {u} tests moved from {old} to {v}."],
    drops: [],
    negations: ["{u} does not use {x}.", "We never adopted {x} for {u}."],
    named: {
      dev: ["what runs the {u} tests?", "which framework do the {u} tests use?"],
      test: ["{u} tests: which runner?", "how do the {u} tests run?"],
    },
    para: {
      dev: ["what do I invoke to check {u} still works after a change?", "which harness executes the specs for {u}?"],
      test: ["what verifies {u} behaviour locally before I push?", "which tool drives the {u} suite?"],
    },
    path: {
      dev: ["{p} is flaky. what runs these tests?"],
      test: ["{p} needs a new case. what do the tests run under?"],
    },
    files: ["test/smoke.test.ts", "tests/test_api.py", "e2e/checkout.spec.ts"],
  },
};

type RepoSlot = "pkg" | "runtime" | "branch" | "format";

/** Facts only the working directory scopes: the prompt never names the repo. */
const REPO_FACTS: Record<RepoId, Record<RepoSlot, [string, string]>> = {
  "acme-shop": {
    pkg: ["In this repo we install dependencies with pnpm.", "pnpm"],
    runtime: ["This repo targets Node 22.", "Node 22"],
    branch: ["Pull requests in this repo target the main branch.", "main"],
    format: ["This repo formats code with Biome.", "Biome"],
  },
  "acme-infra": {
    pkg: ["Dependencies in this repo are managed with npm.", "npm"],
    runtime: ["This repo targets Node 20.", "Node 20"],
    branch: ["Pull requests in this repo target the trunk branch.", "trunk"],
    format: ["This repo formats code with Prettier.", "Prettier"],
  },
  "acme-data": {
    pkg: ["This repo manages Python dependencies with uv.", "uv"],
    runtime: ["This repo targets Python 3.12.", "Python 3.12"],
    branch: ["Pull requests in this repo target the develop branch.", "develop"],
    format: ["This repo formats code with Ruff.", "Ruff"],
  },
};

const REPO_CUES: Record<RepoSlot, Record<Split, string>> = {
  pkg: { dev: "how do I install dependencies here?", test: "which package manager should I run in this repo?" },
  runtime: { dev: "which runtime version does this repo target?", test: "what version do we build against here?" },
  branch: { dev: "which branch should my pull request target?", test: "what's the base branch for PRs here?" },
  format: { dev: "what formats the code in this repo?", test: "which formatter do we run here?" },
};

/** Rare codenames: a cue naming one should retrieve exactly one row. The known-pass floor. */
const ANCHORS: { split: Split; name: string; unit: string; text: string; cue: string }[] = [
  { split: "dev", name: "kestrel", unit: "billing", text: "Kestrel is the codename for the billing ledger rewrite.",
    cue: "what's Kestrel?" },
  { split: "dev", name: "osprey", unit: "search", text: "Osprey is the codename for the search relevance project.",
    cue: "Osprey?" },
  { split: "dev", name: "heron", unit: "gateway", text: "Heron is the codename for the gateway rate-limit work.",
    cue: "what's Heron again?" },
  { split: "test", name: "plover", unit: "ingest", text: "Plover is the codename for the ingest backfill.",
    cue: "Plover?" },
  { split: "test", name: "avocet", unit: "storefront", text: "Avocet is the codename for the storefront redesign.",
    cue: "what's Avocet?" },
  { split: "test", name: "tern", unit: "notifier", text: "Tern is the codename for the notifier digest emails.",
    cue: "what's Tern again?" },
];

/** A7 §2 `ack` turns after an assistant *report* (no proposal): must inject nothing (A5 silence b). */
const ACKS: Record<Split, string[]> = {
  dev: ["ok", "thanks", "cool", "great", "got it", "ok thanks", "nice", "sounds good", "continue", "keep going",
    "great thanks", "next"],
  test: ["thanks!", "cool thanks", "nice, thanks", "got it, thanks", "sounds good!", "great!", "ok cool", "go on",
    "ok, next", "ok great", "great, thanks", "cool cool"],
};

const REPORTS: Record<Split, string[]> = {
  dev: [
    "I updated services/billing/src/db/pool.ts to reuse connections, and the billing tests pass now.",
    "Done: the gateway auth middleware now rejects expired tokens, and I added a test for it.",
    "I rebased the search-indexer branch onto main and fixed the two conflicts in src/jobs/consumer.ts.",
    "The storefront deploy finished and the smoke tests are green.",
  ],
  test: [
    "I removed the unused cache client from services/notifier, and the build passes.",
    "The ingest pipeline run completed; 3 files were skipped because of schema errors.",
    "I renamed the reports export job and updated its README.",
    "Finished: warehouse-api now retries timeouts twice, and the suite is green.",
  ],
};

/** A5 silence (a): non-human submits. */
const NONHUMAN: Record<Split, string[]> = {
  dev: [
    "<task-notification>Background command \"bun test services/billing\" completed (exit code 0).</task-notification>",
    "<task-notification>Agent finished: searched the gateway auth middleware, 4 files matched.</task-notification>",
    "<task-notification>Background command \"docker compose up search\" exited with code 1.</task-notification>",
    "<task-notification>Background command \"bun run lint --filter admin\" completed (exit code 0)."
      + "</task-notification>",
  ],
  test: [
    "<task-notification>Background command \"pytest pipelines/ingest\" completed (exit code 0).</task-notification>",
    "<task-notification>Subagent finished reviewing the notifier queue consumer.</task-notification>",
    "<task-notification>Background command \"bun run build --filter storefront\" completed (exit code 0)."
      + "</task-notification>",
    "<task-notification>Background command \"make migrate\" in services/billing exited with code 2."
      + "</task-notification>",
  ],
};

/** Human turns that are not acks and ask nothing of memory. */
const CHATTER: Record<Split, string[]> = {
  dev: ["haha that's wild", "brb, grabbing coffee", "hmm let me think about that for a sec",
    "can you make that answer shorter?", "lol the build was slow again today", "wait, what did you just change?",
    "sorry, I meant the other file", "no rush on this one"],
  test: ["ugh, mondays", "that makes sense, I guess", "sorry, typo above", "no worries, take your time",
    "one sec, my laptop is updating", "heh, nice catch on that one", "can you say that again more simply?",
    "let's pause here for today"],
};

/** General questions that share vocabulary with stored facts: memory adds nothing (R1 hard lexical traps). */
const OFFTOPIC: Record<Split, string[]> = {
  dev: ["how does Postgres MVCC work in general?", "what's the difference between Redis and Memcached?",
    "explain what a Kafka consumer group is", "write a haiku about continuous integration",
    "how do I center a div with flexbox?", "what's the capital of Australia?", "what does HTTP 429 mean?",
    "give me a regex that matches an email address", "why is the sky blue?", "what is a database index, conceptually?"],
  test: ["how does Kubernetes schedule pods onto nodes?", "is DynamoDB eventually consistent by default?",
    "what's a good book on distributed systems?", "translate 'good morning' into French",
    "how do JWTs get signed?", "what's the time complexity of quicksort?", "explain the OAuth device flow simply",
    "how many bytes are in a kilobyte?", "what's the difference between a mutex and a semaphore?",
    "recommend a mechanical keyboard"],
};

const STAGING = {
  fact: "The {u} staging database is {v}.",
  cues: {
    prod: { dev: "which database does {u} use in production?", test: "what's the production database for {u}?" },
    staging: { dev: "what's the staging database for {u}?", test: "which database backs {u} staging?" },
  },
} as const;

const REDUNDANT: Record<Split, string[]> = {
  dev: ["Since {state}, {ask}", "Given that {state}, {ask}"],
  test: ["{state}. {ask}", "Context: {state}. {ask}"],
};

// Background rows: episodes that share unit names, paths and slot words with the facts, but never state a value.
const FILLER_TEMPLATES = [
  "{op} reviewed the {topic} change for {unit} in {path} on day {day}.",
  "Paired with {op} on {unit} {topic} cleanup on day {day}.",
  "Day {day}: closed ticket {ticket} about {unit} {topic} after a quick fix by {op}.",
  "{op} renamed {path} during the {unit} refactor on day {day}.",
  "Standup on day {day}: {op} said the {unit} {topic} work needs another pass.",
  "Moved ticket {ticket} for {unit} {topic} into the next sprint on day {day}.",
  "{op} left review comments on the {unit} {topic} PR on day {day}.",
  "Spent the afternoon of day {day} reading {unit} {topic} logs with {op}.",
  "{op} bumped the timeout in {path} for {unit} on day {day}.",
  "Wrote a runbook section on {unit} {topic} with {op} on day {day}.",
];

const FILLER_TOPICS = [
  "database", "migration", "schema", "tables", "records", "auth", "login", "session", "tokens", "pipeline",
  "build", "checks", "pull request", "cache", "queue", "events", "jobs", "workers", "deploy", "rollout",
  "production", "errors", "alerts", "stack traces", "tests", "flaky test", "dependencies", "config", "logging",
  "metrics", "latency", "retries", "timeouts", "webhooks", "api", "dashboard", "docs", "onboarding",
];

const FILLER_FILES = [
  "src/index.ts", "src/db/pool.ts", "src/auth/session.ts", "src/handlers/orders.ts", "src/jobs/consumer.ts",
  "config/prod.yaml", "test/smoke.test.ts", "package.json", "README.md", "src/cache/client.ts",
  "src/events/publish.ts", "src/lib/telemetry.ts", "deploy/manifest.yaml", "ci/config.yml",
];

const SLOT_IDS = Object.keys(SLOTS) as SlotId[];
const CORE_SLOTS: SlotId[] = ["db", "auth", "ci"];
/** After the 2 drops per split, each split's history pairs cycle through these (A→B, A→B, A→B→C, A→B→A). */
const HISTORY_KINDS = ["update", "migrate", "double", "revert"] as const;
const DROPS_PER_SPLIT = 2;

function unitOf(id: string): Unit {
  const u = UNITS.find((x) => x.id === id);
  if (!u) throw new Error(`unknown unit ${id}`);
  return u;
}

function slotKey(unit: string, slot: string): string {
  return `${unit}.${slot}`;
}

function otherValue(r: () => number, values: string[], not: string[]): string {
  const rest = values.filter((v) => !not.includes(v));
  return pick(r, rest);
}

/** Builds the timeline. `fillerRows` scales the background (the full bench uses FILLER_ROWS). */
export function buildWorld(fillerRows = FILLER_ROWS): World {
  const r = rng(SEEDS.world);
  const statements: Statement[] = [];
  const pairs: World["pairs"] = [];
  const say = (session: number, repo: RepoId, text: string, slot: string, value?: string, not?: string) => {
    const s: Statement = { id: `s${statements.length}`, session, repo, text, slot, value, not };
    statements.push(s);
  };

  for (const repo of REPOS) {
    for (const [slot, [text, value]] of Object.entries(REPO_FACTS[repo.id])) {
      say(0, repo.id, text, `repo:${repo.id}.${slot}`, value);
    }
  }
  for (const a of ANCHORS) say(0, unitOf(a.unit).repo, a.text, `anchor.${a.name}`, a.name);

  const values = new Map<string, string>();
  const all: { unit: Unit; slot: SlotId }[] = [];
  for (const unit of UNITS) {
    for (const slot of SLOT_IDS) {
      if (!CORE_SLOTS.includes(slot) && r() >= 0.7) continue;
      const def = SLOTS[slot];
      const v = pick(r, def.values);
      values.set(slotKey(unit.id, slot), v);
      all.push({ unit, slot });
      const text = sentence(pick(r, def.facts), { u: unit.id, v });
      say(r() < 0.5 ? 0 : 1, unit.repo, text, slotKey(unit.id, slot), v);
    }
  }

  // Tags: which pairs get a later change of value, a staging twin or a negation distractor.
  const order = shuffle(r, all);
  // Pairs alternate dev/test, so the first 2 × DROPS_PER_SPLIT droppable pairs give each split its drops.
  const droppable = order.filter((p) => SLOTS[p.slot].drops.length).slice(0, 2 * DROPS_PER_SPLIT);
  const history = [...droppable, ...order.filter((p) => !droppable.includes(p))].slice(0, 20);
  const staging = order.filter((p) => p.slot === "db" && !history.includes(p)).slice(0, 6);
  const negation = order.filter((p) => !history.includes(p) && !staging.includes(p)).slice(0, 8);
  const tagged = new Set([...history, ...staging, ...negation]);
  history.forEach((p, i) => {
    const key = slotKey(p.unit.id, p.slot);
    const def = SLOTS[p.slot];
    const old = values.get(key)!;
    const split: Split = i % 2 === 0 ? "dev" : "test";
    const cycle = (Math.floor(i / 2) - DROPS_PER_SPLIT) % HISTORY_KINDS.length;
    const kind = i < droppable.length ? "drop" : HISTORY_KINDS[cycle]!;
    pairs.push({ split, unit: p.unit.id, slot: p.slot, tag: "history" });
    const session = i < 10 ? 4 : 5;
    if (kind === "drop") {
      say(session, p.unit.repo, sentence(pick(r, def.drops), { u: p.unit.id, old }), key, "none");
      return;
    }
    const next = otherValue(r, def.values, [old]);
    const firstTemplate = kind === "update" || kind === "double" ? pick(r, def.updates) : pick(r, def.migrations);
    say(session, p.unit.repo, sentence(firstTemplate, { u: p.unit.id, old, v: next }), key, next);
    if (kind === "double") {
      const third = otherValue(r, def.values, [old, next]);
      say(6, p.unit.repo, sentence(pick(r, def.migrations), { u: p.unit.id, old: next, v: third }), key, third);
    } else if (kind === "revert") {
      const back = sentence("We moved {u} back to {v} after trying {old}.", { u: p.unit.id, old: next, v: old });
      say(6, p.unit.repo, back, key, old);
    }
  });
  staging.forEach((p, i) => {
    const key = slotKey(p.unit.id, p.slot);
    const v = otherValue(r, SLOTS.db.values, [values.get(key)!]);
    pairs.push({ split: i % 2 === 0 ? "dev" : "test", unit: p.unit.id, slot: p.slot, tag: "staging" });
    say(2, p.unit.repo, sentence(STAGING.fact, { u: p.unit.id, v }), `${key}.staging`, v);
  });
  negation.forEach((p, i) => {
    const key = slotKey(p.unit.id, p.slot);
    const def = SLOTS[p.slot];
    const x = otherValue(r, def.values, [values.get(key)!]);
    pairs.push({ split: i % 2 === 0 ? "dev" : "test", unit: p.unit.id, slot: p.slot, tag: "negation" });
    say(2, p.unit.repo, sentence(pick(r, def.negations), { u: p.unit.id, x }), key, undefined, x);
  });
  for (const p of all) {
    if (tagged.has(p)) continue;
    pairs.push({ split: r() < 0.5 ? "dev" : "test", unit: p.unit.id, slot: p.slot, tag: "plain" });
  }

  const filler = buildFiller(r, fillerRows);
  const events = interleave(r, statements, filler);
  const current = new Map<string, string>();
  for (const e of events) if (e.stmt?.value !== undefined) current.set(e.stmt.slot, e.stmt.value);
  return { sessions: SESSIONS, events, statements, filler: filler.map((f) => f.text), current, pairs };
}

type FillerRow = { text: string; repo: RepoId; session: number };

function buildFiller(r: () => number, rows: number): FillerRow[] {
  const total = UNITS.reduce((n, u) => n + u.filler, 0);
  const owners: Unit[] = [];
  for (const u of UNITS) {
    const n = Math.max(1, Math.round((u.filler * rows) / total));
    for (let i = 0; i < n; i++) owners.push(u);
  }
  const seen = new Set<string>();
  return shuffle(r, owners).map((unit, i) => {
    let text = "";
    for (let tries = 0; !text || seen.has(text); tries++) {
      text = sentence(pick(r, FILLER_TEMPLATES), {
        op: `op${String(Math.floor(r() * 90000) + 10000)}`,
        unit: unit.id,
        topic: pick(r, FILLER_TOPICS),
        path: `${unit.folder}/${pick(r, FILLER_FILES)}`,
        day: String(Math.floor((i * 700) / owners.length) + 1),
        ticket: `T-${i + 1}${tries ? `-${tries}` : ""}`,
      });
    }
    seen.add(text);
    return { text, repo: unit.repo, session: Math.floor((i * SESSIONS) / owners.length) };
  });
}

function interleave(r: () => number, statements: Statement[], filler: FillerRow[]): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let session = 0; session < SESSIONS; session++) {
    for (const repo of REPOS) {
      const batch: WorldEvent[] = filler
        .filter((f) => f.session === session && f.repo === repo.id)
        .map((f) => ({ session, repo: repo.id, text: f.text }));
      for (const s of statements) {
        if (s.session !== session || s.repo !== repo.id) continue;
        batch.splice(Math.floor(r() * (batch.length + 1)), 0, { session, repo: repo.id, text: s.text, stmt: s });
      }
      events.push(...batch);
    }
  }
  return events;
}

/** Generates one split's cases. Dev and test draw from disjoint pairs, templates and negatives. */
export function buildCases(world: World, split: Split): HardCase[] {
  const r = rng(SEEDS[split]);
  const cases: HardCase[] = [];
  const add = (c: Omit<HardCase, "id" | "split" | "states"> & Partial<HardCase>) => {
    const n = cases.filter((x) => x.category === c.category).length;
    const id = `${split}-${c.category}-${String(n + 1).padStart(2, "0")}`;
    cases.push({ states: [], ...c, id, split });
  };
  const mine = world.pairs.filter((p) => p.split === split);
  const plain = shuffle(r, mine.filter((p) => p.tag === "plain"));
  const repoOf = (unit: string) => unitOf(unit).repo;
  const pathFor = (unit: string, slot: SlotId) => `${unitOf(unit).folder}/${pick(r, SLOTS[slot].files)}`;

  for (const a of ANCHORS.filter((x) => x.split === split)) {
    add({ category: "anchor", repo: repoOf(a.unit), cue: a.cue, needs: [`anchor.${a.name}`] });
  }
  for (const p of plain.slice(0, 30)) {
    const cue = fill(pick(r, SLOTS[p.slot].named[split]), { u: p.unit });
    add({ category: "named", repo: repoOf(p.unit), cue, needs: [slotKey(p.unit, p.slot)] });
  }
  for (const p of shuffle(r, plain).slice(0, 30)) {
    const cue = fill(pick(r, SLOTS[p.slot].para[split]), { u: p.unit });
    add({ category: "para", repo: repoOf(p.unit), cue, needs: [slotKey(p.unit, p.slot)] });
  }
  for (const p of shuffle(r, plain).slice(0, 10)) {
    const cue = fill(pick(r, SLOTS[p.slot].para[split]), { u: unitOf(p.unit).alias[split] });
    add({ category: "alias", repo: repoOf(p.unit), cue, needs: [slotKey(p.unit, p.slot)] });
  }
  for (const p of shuffle(r, plain).slice(0, 20)) {
    const cue = fill(pick(r, SLOTS[p.slot].path[split]), { p: pathFor(p.unit, p.slot) });
    add({ category: "path", repo: repoOf(p.unit), cue, needs: [slotKey(p.unit, p.slot)] });
  }
  const repoSlots = Object.keys(REPO_CUES) as RepoSlot[];
  REPOS.forEach((repo, i) => {
    for (const [j, slot] of repoSlots.entries()) {
      if ((i + j) % 2 !== (split === "dev" ? 0 : 1)) continue;
      add({ category: "repo", repo: repo.id, cue: REPO_CUES[slot][split], needs: [`repo:${repo.id}.${slot}`] });
    }
  });
  for (const p of mine.filter((x) => x.tag === "history")) {
    const need = [slotKey(p.unit, p.slot)];
    add({ category: "stale", repo: repoOf(p.unit), cue: fill(pick(r, SLOTS[p.slot].named[split]), { u: p.unit }),
      needs: need });
    add({ category: "stale", repo: repoOf(p.unit), cue: fill(pick(r, SLOTS[p.slot].path[split]),
      { p: pathFor(p.unit, p.slot) }), needs: need });
  }
  for (const p of mine.filter((x) => x.tag === "staging")) {
    const key = slotKey(p.unit, p.slot);
    add({ category: "distract", repo: repoOf(p.unit), cue: fill(STAGING.cues.prod[split], { u: p.unit }),
      needs: [key] });
    add({ category: "distract", repo: repoOf(p.unit), cue: fill(STAGING.cues.staging[split], { u: p.unit }),
      needs: [`${key}.staging`] });
  }
  for (const p of mine.filter((x) => x.tag === "negation")) {
    add({ category: "distract", repo: repoOf(p.unit), cue: fill(pick(r, SLOTS[p.slot].named[split]), { u: p.unit }),
      needs: [slotKey(p.unit, p.slot)] });
  }
  for (const [a, b] of SIBLINGS) {
    for (const unit of [a, b]) {
      const other = unit === a ? b : a;
      const shared = mine.filter((p) => p.unit === unit && p.tag === "plain"
        && world.current.has(slotKey(other, p.slot)));
      for (const p of shared.slice(0, 2)) {
        add({ category: "distract", repo: repoOf(unit), cue: fill(pick(r, SLOTS[p.slot].named[split]), { u: unit }),
          needs: [slotKey(unit, p.slot)] });
      }
    }
  }
  const byUnit = new Map<string, typeof plain>();
  for (const p of plain) byUnit.set(p.unit, [...(byUnit.get(p.unit) ?? []), p]);
  const multi = shuffle(r, [...byUnit.values()].filter((ps) => ps.length >= 2));
  for (const ps of multi.slice(0, 12)) {
    const [x, y] = shuffle(r, ps) as [(typeof ps)[number], (typeof ps)[number]];
    const said = statementFor(world, slotKey(x.unit, x.slot));
    const state = said.text.replace(/[.!?]+$/, "");
    const ask = fill(pick(r, SLOTS[y.slot].named[split]), { u: y.unit });
    const cue = fill(pick(r, REDUNDANT[split]), { state: lowerFirst(state), ask });
    add({ category: "redundant", repo: repoOf(x.unit), cue, needs: [slotKey(y.unit, y.slot)],
      states: [slotKey(x.unit, x.slot)] });
  }
  const repoIds = REPOS.map((x) => x.id);
  ACKS[split].forEach((ack, i) => {
    add({ category: "ack", repo: pick(r, repoIds), prev: REPORTS[split][i % REPORTS[split].length], cue: ack,
      needs: [] });
  });
  for (const cue of NONHUMAN[split]) add({ category: "nonhuman", repo: pick(r, repoIds), cue, needs: [] });
  for (const cue of CHATTER[split]) add({ category: "chatter", repo: pick(r, repoIds), cue, needs: [] });
  for (const cue of OFFTOPIC[split]) add({ category: "offtopic", repo: pick(r, repoIds), cue, needs: [] });
  return cases;
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** The statement that set a slot's current value. */
export function statementFor(world: World, slot: string): Statement {
  const value = world.current.get(slot);
  const found = world.statements.filter((s) => s.slot === slot && s.value === value).at(-1);
  if (!found) throw new Error(`no statement for ${slot}`);
  return found;
}
