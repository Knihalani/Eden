/**
 * coding-baselines: compares Eden's BrainMemory retrieval against three
 * simple, well-known non-Eden retrieval baselines on the EXACT SAME corpus
 * and queries as coding-holdout.ts.
 *
 * World/query generation (domains, styles, buildWorld) is copied verbatim
 * from coding-holdout.ts, line for line, so all 4 systems see identical
 * facts and queries generated in one script run. It is deliberately NOT
 * re-imported as a module: coding-holdout.ts is a top-level script (has no
 * exports), and `import`ing it would re-execute its own full BrainMemory
 * benchmark as a side effect. Copying keeps this file the single source of
 * truth for "one run, one table" while staying byte-identical to the
 * generation logic coding-holdout.ts uses (same SEED, same PRNG, same call
 * order — including the post-world junk-probe `sample()` call, which is
 * kept only to consume the same PRNG draws so later worlds match
 * coding-holdout.ts's own corpus exactly).
 *
 * Baselines (naming matches benchmarks/memory-bakeoff/run.ts):
 *   lastk            - no ranking at all; last K=5 turns observed
 *   storeall-overlap - every turn stored, raw token-overlap count, top-K=5
 *   storeall-bm25    - every turn stored, real BM25 (k1=1.2, b=0.75), top-K=5
 *
 * Scoring mirrors coding-holdout.ts: miss = gold regex not matched anywhere
 * in the joined top-K retrieved text, tallied per (domain, style).
 *
 * stdout: one comparison table (hit@5 + per-style breakdown) for all four
 * systems, followed by a per-domain / per-style detail section per system.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../../src/index";
import { BrainMemory } from "../../src/brain-memory";

const SEED = Number(process.env.EDEN_CODING_SEED || "20260912");
const K = Number(process.env.EDEN_CODING_K || "5");
const WORLDS_PER_DOMAIN = Number(process.env.EDEN_CODING_WORLDS || "5");
const ROOT = mkdtempSync(join(tmpdir(), "coding-baselines-"));

// ============================================================================
// Everything from here down to buildWorld() is copied verbatim from
// coding-holdout.ts so all four systems race on an identical corpus.
// ============================================================================

// ---------- seeded PRNG ----------
let seed = SEED >>> 0;
function rnd(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
function sample<T>(a: readonly T[], n: number): T[] {
  return shuffle([...a]).slice(0, n);
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- domains ----------
type Style =
  | "exact"
  | "paraphrase"
  | "update"
  | "multihop"
  | "numeric"
  | "negation"
  | "distractor"
  | "rationale"
  | "which-file";
type Fact = { text: string; buried?: boolean; late?: boolean };
type Query = { q: string; want: RegExp; style: Style; stale?: RegExp; facts: Fact[] };
type Gen = (people: string[]) => Query;

type Domain = { name: string; people: string[]; noise: string[]; gens: Record<Style, Gen[]> };

function pairQuery(
  style: Style,
  text: string,
  q: string,
  want: string | RegExp,
  extra: Partial<Query> = {},
): Query {
  return { style, facts: [{ text }], q, want: typeof want === "string" ? new RegExp(esc(want), "i") : want, ...extra };
}

const ENGINEERS = [
  "Priya", "Mateus", "Wing", "Oleander", "Farrukh", "Beatrix", "Njeri",
  "Soledad", "Tomasz", "Aoibhinn", "Kwabena", "Rosalind",
];

// ============================================================================
// 1. build-and-test
// ============================================================================
const SERVICES1 = [
  "auth-service", "checkout-service", "search-service", "billing-service",
  "notifications-service", "inventory-service", "reporting-service", "gateway-service",
];
const TEST_CMDS = ["pnpm test:unit", "pnpm test:e2e", "pnpm test:integration", "pnpm vitest run", "pnpm jest --runInBand"];
const LINT_CMDS = ["pnpm lint", "pnpm eslint .", "pnpm biome check ."];
const BUILD_CMDS = ["pnpm build", "pnpm turbo build", "pnpm tsc -b"];
const TEST_ENV_VARS = ["TEST_TIMEOUT_MS", "CI_RETRY_COUNT", "DATABASE_URL_TEST", "MOCK_EXTERNAL_APIS"];
const TEST_FILES = ["src/checkout/checkout.spec.ts", "src/search/indexer.spec.ts", "src/billing/invoice.spec.ts", "src/auth/session.spec.ts"];

const buildAndTest: Domain = {
  name: "build-and-test",
  people: ENGINEERS,
  noise: [
    "$ pnpm install\nDone in 4.1s",
    "warning: unused variable 'tmp' in helpers.ts",
    "Compiled successfully in 3.87s",
    "diff --git a/src/utils/format.ts b/src/utils/format.ts\n+export function pad(n: number) {}",
    "✔ 214 tests passed, 3 skipped (18.2s)",
    "anyone want coffee before standup",
    "happy friday team",
    "the office wifi keeps dropping again",
    "PR #482 merged: cleanup unused imports",
    "info: cache restored from key node-modules-abc123",
    "lol the deploy bot's commit messages are unhinged",
    "reminder: sprint planning moved to 2pm",
    "$ git status\nnothing to commit, working tree clean",
    "does anyone else's terminal font look tiny today",
    "npm WARN deprecated request@2.88.2: request has been deprecated",
    "the standup notes doc got moved to a new folder",
    "grabbing lunch, back in 30",
    "Error: connect ECONNREFUSED 127.0.0.1:5432 (transient, retried ok)",
  ],
  gens: {
    exact: [
      (P) => { const s = pick(SERVICES1), c = pick(TEST_CMDS); return pairQuery("exact", `Run ${s}'s tests with \`${c}\`.`, `How do I run ${s}'s tests?`, c); },
      (P) => { const c = pick(LINT_CMDS); return pairQuery("exact", `Lint the repo with \`${c}\`.`, `What command lints the code?`, c); },
      (P) => { const c = pick(BUILD_CMDS); return pairQuery("exact", `Build the repo with \`${c}\`.`, `What command builds the project?`, c); },
    ],
    paraphrase: [
      (P) => { const s = pick(SERVICES1), c = pick(TEST_CMDS); return pairQuery("paraphrase", `Run ${s}'s tests with \`${c}\`.`, `What's the test command for ${s}?`, c); },
      (P) => { const c = pick(LINT_CMDS); return pairQuery("paraphrase", `Lint the repo with \`${c}\`.`, `How do I check code style before committing?`, c); },
      (P) => { const c = pick(BUILD_CMDS); return pairQuery("paraphrase", `Build the repo with \`${c}\`.`, `Which command produces a production build?`, c); },
    ],
    update: [
      (P) => { const [v1, v2] = sample(["16", "18", "20", "22"], 2) as [string, string]; return { style: "update", facts: [{ text: `CI runs on Node ${v1}.` }, { text: `CI was upgraded to run on Node ${v2}.`, late: true }], q: `What Node version does CI use?`, want: new RegExp(`\\b${v2}\\b`), stale: new RegExp(`\\b${v1}\\b`) }; },
      (P) => { const [n1, n2] = sample([2, 3, 4, 5], 2) as [number, number]; return { style: "update", facts: [{ text: `Flaky tests are retried ${n1} times on CI.` }, { text: `The flaky-test retry count was raised to ${n2}.`, late: true }], q: `How many times does CI retry a flaky test?`, want: new RegExp(`\\b${n2}\\b`), stale: new RegExp(`\\b${n1}\\b`) }; },
    ],
    multihop: [
      (P) => { const s = pick(SERVICES1), f = pick(TEST_FILES), v = pick(TEST_ENV_VARS); return { style: "multihop", facts: [{ text: `The slow integration tests for ${s} live in \`${f}\`.` }, { text: `\`${f}\` requires the env var \`${v}\` to be set locally.` }], q: `Which env var do I need set to run the slow integration tests for ${s}?`, want: new RegExp(`\\b${v}\\b`) }; },
    ],
    numeric: [
      (P) => { const s = pick(SERVICES1), port = pick([3000, 3001, 4000, 4200, 5000, 8080, 8081, 9000]); return pairQuery("numeric", `${s} listens on port ${port} in local dev.`, `What port does ${s} run on locally?`, new RegExp(`\\b${port}\\b`)); },
      (P) => { const n = pick([8, 10, 12, 15, 20]); return pairQuery("numeric", `CI kills the build if it runs past ${n} minutes.`, `After how many minutes does CI time out a build?`, new RegExp(`\\b${n}\\b`)); },
      (P) => { const s = pick(SERVICES1), n = pick([2, 3, 5]); return pairQuery("numeric", `${s} tests are split into ${n} parallel shards on CI.`, `How many parallel shards does ${s} run its tests in?`, new RegExp(`\\b${n}\\b`)); },
    ],
    negation: [
      (P) => pairQuery("negation", `Do not run \`pnpm test\` in watch mode on CI; it will hang the runner.`, `Should I run tests in watch mode on CI?`, /do not|not run|hang|no\b/i),
      (P) => { const s = pick(SERVICES1); return pairQuery("negation", `${s}'s tests do not require Docker to run locally.`, `Do I need Docker to run ${s}'s tests locally?`, /do not require|no|don't need/i); },
      (P) => pairQuery("negation", `Lint failures do not block local commits, only CI.`, `Does a lint failure block me from committing locally?`, /do not block|no|not block/i),
    ],
    distractor: [
      (P) => { const ss = sample(SERVICES1, 8), cmds = ["pnpm test:auth", "pnpm test:checkout", "pnpm test:search", "pnpm test:billing", "pnpm test:notify", "pnpm test:inventory", "pnpm test:reports", "pnpm test:gateway"]; const facts = ss.map((s, i) => ({ text: `${s}'s tests are run with \`${cmds[i]}\`.` })); const i = Math.floor(rnd() * ss.length); return { style: "distractor", facts, q: `What command runs ${ss[i]}'s tests?`, want: new RegExp(esc(cmds[i]!)) }; },
    ],
    rationale: [
      (P) => { const n = pick([2, 3, 4]); return pairQuery("rationale", `We retry flaky tests up to ${n} times because the CI runners are noisy shared infrastructure and single failures are often unrelated to the code.`, `Why do we retry flaky tests instead of failing fast?`, /noisy shared infrastructure/i); },
      (P) => pairQuery("rationale", `Lint runs as a separate CI job from tests because it lets both jobs run in parallel and fail fast independently.`, `Why is lint a separate CI job from the test suite?`, /run in parallel and fail fast/i),
      (P) => { const s = pick(SERVICES1); return pairQuery("rationale", `${s}'s integration tests run against a real database instead of mocks because the mocks previously hid a whole class of transaction bugs.`, `Why do ${s}'s integration tests use a real database instead of mocks?`, /hid a whole class of transaction bugs/i); },
    ],
    "which-file": [
      (P) => pairQuery("which-file", `The flaky-test retry logic lives in \`scripts/test-retry.ts\`.`, `Which file implements the flaky-test retry logic?`, /scripts\/test-retry\.ts/i),
      (P) => pairQuery("which-file", `The CI pipeline is defined in \`.github/workflows/ci.yml\`.`, `Which file defines the CI pipeline?`, /\.github\/workflows\/ci\.yml/i),
      (P) => { const s = pick(SERVICES1); return pairQuery("which-file", `${s}'s test fixtures are seeded from \`fixtures/${s}/seed.sql\`.`, `Which file seeds ${s}'s test fixtures?`, new RegExp(esc(`fixtures/${s}/seed.sql`), "i")); },
    ],
  },
};

// ============================================================================
// 2. architecture-decisions
// ============================================================================
const CHOICES = [
  { chosen: "PostgreSQL", rejected: "MongoDB", category: "the orders database", reason: "we needed strong transactional guarantees for order totals", file: "src/orders/db.ts" },
  { chosen: "Redis", rejected: "Memcached", category: "the caching layer", reason: "we needed built-in pub/sub for cache invalidation events", file: "src/cache/redis-client.ts" },
  { chosen: "gRPC", rejected: "REST", category: "internal service-to-service calls", reason: "we needed strict typed contracts and lower latency between services", file: "src/rpc/grpc-server.ts" },
  { chosen: "Zustand", rejected: "Redux", category: "frontend state management", reason: "Redux boilerplate was slowing down feature velocity", file: "src/store/index.ts" },
  { chosen: "Kafka", rejected: "RabbitMQ", category: "the event bus", reason: "we needed durable log replay for the analytics pipeline", file: "src/events/kafka-client.ts" },
  { chosen: "Terraform", rejected: "Pulumi", category: "infrastructure as code", reason: "the team already had deep Terraform expertise", file: "infra/main.tf" },
  { chosen: "Vite", rejected: "Webpack", category: "the frontend build tool", reason: "cold start and HMR times were ten times faster", file: "vite.config.ts" },
  { chosen: "tRPC", rejected: "GraphQL", category: "the public API layer", reason: "we wanted end-to-end type safety without a schema layer", file: "src/api/trpc-router.ts" },
];

const architecture: Domain = {
  name: "architecture-decisions",
  people: ENGINEERS,
  noise: [
    "design doc got a lot of comments overnight",
    "can we push the RFC review to next week",
    "the whiteboard sketch from the meeting is on the wiki now",
    "someone left snacks in the design review room",
    "architecture sync moved to Thursdays",
    "diff --git a/docs/adr/0007.md b/docs/adr/0007.md\n+status: accepted",
    "the conference talk on this topic was pretty good",
    "anyone have strong opinions on monorepos vs polyrepos",
    "the diagram tool export looks blurry on retina screens",
    "reminder to update the architecture wiki page",
    "that RFC thread got long fast",
    "let's timebox the debate to 30 minutes",
    "the new hire onboarding doc references an old diagram",
    "haha the naming bikeshed continues",
    "someone bumped the design review to a bigger room",
  ],
  gens: {
    exact: [
      (P) => { const c = pick(CHOICES); return pairQuery("exact", `We chose ${c.chosen} over ${c.rejected} for ${c.category} because ${c.reason}.`, `What did we choose for ${c.category}?`, c.chosen); },
    ],
    paraphrase: [
      (P) => { const c = pick(CHOICES); return pairQuery("paraphrase", `We chose ${c.chosen} over ${c.rejected} for ${c.category} because ${c.reason}.`, `Which technology powers ${c.category}?`, c.chosen); },
      (P) => { const c = pick(CHOICES); return pairQuery("paraphrase", `We chose ${c.chosen} over ${c.rejected} for ${c.category} because ${c.reason}.`, `What did we end up using instead of ${c.rejected} for ${c.category}?`, c.chosen); },
    ],
    update: [
      (P) => { const c = pick(CHOICES), c2 = pick(CHOICES.filter((x) => x.category !== c.category)); return { style: "update", facts: [{ text: `We chose ${c.chosen} for ${c.category}.` }, { text: `We migrated ${c.category} to ${c2.chosen}; the previous choice could not scale with our traffic growth.`, late: true }], q: `What do we use for ${c.category} now?`, want: new RegExp(c2.chosen, "i"), stale: new RegExp(`\\b${c.chosen}\\b`, "i") }; },
    ],
    multihop: [
      (P) => { const c = pick(CHOICES); return { style: "multihop", facts: [{ text: `We chose ${c.chosen} for ${c.category}.` }, { text: `${c.category[0]!.toUpperCase() + c.category.slice(1)} is implemented in \`${c.file}\`.` }], q: `Which file implements the thing we decided to use ${c.chosen} for?`, want: new RegExp(esc(c.file), "i") }; },
    ],
    numeric: [
      (P) => { const n = pick([2, 3, 4, 5, 6]); return pairQuery("numeric", `We settled on ${n} read replicas for the reporting database.`, `How many read replicas does the reporting database have?`, new RegExp(`\\b${n}\\b`)); },
      (P) => { const n = pick([15, 30, 60, 90]); return pairQuery("numeric", `We chose a ${n}-minute cache TTL for the product catalog.`, `What TTL did we choose for the product catalog cache?`, new RegExp(`\\b${n}\\b`)); },
      (P) => { const n = pick([2, 3, 4]); return pairQuery("numeric", `We decided on a ${n}-service split for the checkout flow.`, `How many services did we split the checkout flow into?`, new RegExp(`\\b${n}\\b`)); },
    ],
    negation: [
      (P) => pairQuery("negation", `We decided not to use GraphQL for the public API, sticking with REST.`, `Are we using GraphQL for the public API?`, /decided not to|not use|no\b/i),
      (P) => pairQuery("negation", `We are not adopting a service mesh; the extra operational overhead was not worth it yet.`, `Did we adopt a service mesh?`, /not adopting|no\b|not worth/i),
      (P) => pairQuery("negation", `We rejected a NoSQL document store for the billing ledger because it does not give us strong consistency.`, `Did we choose a NoSQL store for the billing ledger?`, /rejected|not|no\b/i),
    ],
    distractor: [
      (P) => { const cs = sample(CHOICES, 8); const facts = cs.map((c) => ({ text: `We chose ${c.chosen} over ${c.rejected} for ${c.category}.` })); const i = Math.floor(rnd() * cs.length); return { style: "distractor", facts, q: `What did we choose for ${cs[i]!.category}?`, want: new RegExp(cs[i]!.chosen, "i") }; },
    ],
    rationale: [
      (P) => { const c = pick(CHOICES); return pairQuery("rationale", `We chose ${c.chosen} over ${c.rejected} for ${c.category} because ${c.reason}.`, `Why did we choose ${c.chosen} over ${c.rejected} for ${c.category}?`, new RegExp(esc(c.reason.split(" ").slice(-4).join(" ")), "i")); },
    ],
    "which-file": [
      (P) => { const c = pick(CHOICES); return pairQuery("which-file", `${c.category[0]!.toUpperCase() + c.category.slice(1)} is implemented in \`${c.file}\`.`, `Which file implements ${c.category}?`, new RegExp(esc(c.file), "i")); },
      (P) => { const c = pick(CHOICES); return pairQuery("which-file", `The decision to use ${c.chosen} for ${c.category} is recorded in \`docs/adr/${c.chosen.toLowerCase().replace(/[^a-z0-9]/g, "-")}.md\`.`, `Which file records the decision to use ${c.chosen}?`, new RegExp(esc(`docs/adr/${c.chosen.toLowerCase().replace(/[^a-z0-9]/g, "-")}.md`), "i")); },
    ],
  },
};

// ============================================================================
// 3. bug-fixes
// ============================================================================
const BUGS = [
  { file: "src/auth/session.ts", service: "auth-service", bug: "sessions expired 30 seconds after login", cause: "the TTL calculation used milliseconds instead of seconds", fix: "convert the TTL to seconds before writing it to Redis" },
  { file: "src/checkout/payment.ts", service: "checkout-service", bug: "duplicate charges were created on retry", cause: "the retry logic did not check for an existing idempotency key", fix: "add an idempotency key check before resubmitting the charge" },
  { file: "src/search/indexer.ts", service: "search-service", bug: "search results went stale after a product update", cause: "the indexer only listened for create events, not update events", fix: "subscribe the indexer to update events as well" },
  { file: "src/notifications/email.ts", service: "notifications-service", bug: "emails were sent twice to some users", cause: "a race condition between two worker instances processing the same queue message", fix: "add a distributed lock keyed by message id" },
  { file: "src/inventory/stock.ts", service: "inventory-service", bug: "stock counts went negative under high concurrency", cause: "the decrement was not wrapped in a database transaction", fix: "wrap the decrement in a transaction with row-level locking" },
  { file: "src/billing/invoice.ts", service: "billing-service", bug: "invoice totals were off by a cent for some currencies", cause: "rounding happened before currency conversion instead of after", fix: "round only after converting to the target currency" },
  { file: "src/gateway/rate-limit.ts", service: "gateway-service", bug: "legitimate users were rate-limited during traffic spikes", cause: "the rate limiter used a fixed window instead of a sliding window", fix: "switch the rate limiter to a sliding window algorithm" },
  { file: "src/reporting/aggregate.ts", service: "reporting-service", bug: "the nightly reporting job crashed with an out-of-memory error", cause: "database connections from each batch were never closed", fix: "close the DB connection pool after each batch completes" },
];

const bugFixes: Domain = {
  name: "bug-fixes",
  people: ENGINEERS,
  noise: [
    "diff --git a/src/misc/logger.ts b/src/misc/logger.ts\n-console.log(x)\n+logger.debug(x)",
    "ticket ENG-4021 needs triage",
    "the bug tracker migration finished overnight",
    "can someone re-run the flaky CI job on PR #501",
    "found a typo in the changelog, fixing now",
    "the incident postmortem doc is in the shared drive",
    "unrelated: the office plant finally died",
    "stack trace attached in the thread above",
    "reproduced locally after three tries",
    "closing this ticket as duplicate of ENG-3980",
    "the on-call rotation swapped for next week",
    "lol this bug has been open since March",
    "adding a regression test for this one",
    "the error only shows up under load, hard to repro",
    "sentry alert volume dropped after the last deploy",
  ],
  gens: {
    exact: [
      (P) => { const b = pick(BUGS); return pairQuery("exact", `The bug in \`${b.file}\` where ${b.bug} was fixed by ${b.fix}.`, `How was the bug in ${b.file} fixed?`, new RegExp(esc(b.fix.split(" ").slice(0, 5).join(" ")), "i")); },
    ],
    paraphrase: [
      (P) => { const b = pick(BUGS); return pairQuery("paraphrase", `The bug in \`${b.file}\` where ${b.bug} was fixed by ${b.fix}.`, `What was the resolution for the issue in ${b.file}?`, new RegExp(esc(b.fix.split(" ").slice(0, 5).join(" ")), "i")); },
      (P) => { const b = pick(BUGS); return pairQuery("paraphrase", `The bug in \`${b.file}\` where ${b.bug} was fixed by ${b.fix}.`, `How did we solve the problem where ${b.bug}?`, new RegExp(esc(b.fix.split(" ").slice(0, 5).join(" ")), "i")); },
    ],
    update: [
      (P) => { const b = pick(BUGS); return { style: "update", facts: [{ text: `The bug in \`${b.file}\` was fixed by ${b.fix}.` }, { text: `The fix for \`${b.file}\` regressed in production; the real fix was to add a monitoring alert and roll back the change entirely.`, late: true }], q: `What is the current fix for the bug in ${b.file}?`, want: /monitoring alert and roll back/i, stale: new RegExp(esc(b.fix.split(" ").slice(0, 4).join(" ")), "i") }; },
    ],
    multihop: [
      (P) => { const b = pick(BUGS); return { style: "multihop", facts: [{ text: `The bug where ${b.bug} was caused by ${b.cause}.` }, { text: `\`${b.file}\` is part of the ${b.service}.` }], q: `Which service had a bug caused by ${b.cause.split(" ").slice(0, 4).join(" ")}?`, want: new RegExp(esc(b.service), "i") }; },
    ],
    numeric: [
      (P) => { const b = pick(BUGS), n = pick([120, 250, 400, 600, 800]); return pairQuery("numeric", `The bug in \`${b.file}\` added ${n}ms of latency before it was fixed.`, `How much latency did the bug in ${b.file} add before the fix?`, new RegExp(`\\b${n}\\b`)); },
      (P) => { const b = pick(BUGS), v = pick(["1.4.2", "2.0.1", "2.3.1", "3.1.0"]); return pairQuery("numeric", `The fix for the bug in \`${b.file}\` shipped in version ${v}.`, `Which version shipped the fix for the bug in ${b.file}?`, new RegExp(esc(v))); },
    ],
    negation: [
      (P) => { const b = pick(BUGS); return pairQuery("negation", `The bug in \`${b.file}\` was not caused by the cache layer, contrary to initial suspicion.`, `Was the cache layer responsible for the bug in ${b.file}?`, /not caused|no\b|not\b/i); },
      (P) => { const b = pick(BUGS); return pairQuery("negation", `The bug in \`${b.file}\` does not affect the staging environment, only production.`, `Does the bug in ${b.file} affect staging?`, /does not affect|no\b|not\b/i); },
    ],
    distractor: [
      (P) => { const bs = sample(BUGS, 8); const facts = bs.map((b) => ({ text: `${b.file} had a bug where ${b.bug}.` })); const i = Math.floor(rnd() * bs.length); return { style: "distractor", facts, q: `What was the bug in ${bs[i]!.file}?`, want: new RegExp(esc(bs[i]!.bug.split(" ").slice(0, 4).join(" ")), "i") }; },
    ],
    rationale: [
      (P) => { const b = pick(BUGS); return pairQuery("rationale", `The bug where ${b.bug} happened because ${b.cause}.`, `Why did ${b.file} break?`, new RegExp(esc(b.cause.split(" ").slice(-4).join(" ")), "i")); },
      (P) => { const b = pick(BUGS); return pairQuery("rationale", `The bug where ${b.bug} happened because ${b.cause}.`, `What was wrong with ${b.file}?`, new RegExp(esc(b.cause.split(" ").slice(-4).join(" ")), "i")); },
    ],
    "which-file": [
      (P) => { const b = pick(BUGS); return pairQuery("which-file", `The bug where ${b.bug} was in \`${b.file}\`.`, `Which file had the bug where ${b.bug}?`, new RegExp(esc(b.file), "i")); },
    ],
  },
};

// ============================================================================
// 4. conventions-and-style
// ============================================================================
const CONVENTIONS = [
  { topic: "React component filenames", rule: "PascalCase", reason: "it matches the exported component name for quick lookup" },
  { topic: "commit messages", rule: "Conventional Commits format, e.g. feat(scope): subject", reason: "it powers automatic changelog generation" },
  { topic: "CSS class names", rule: "kebab-case with a BEM-style prefix", reason: "it avoids specificity fights across teams" },
  { topic: "test file names", rule: "suffixed with .test.ts", reason: "the test runner glob only picks up that suffix" },
  { topic: "import ordering", rule: "external packages before internal modules", reason: "it keeps diffs from reordering imports noisily" },
  { topic: "branch names", rule: "prefixed with the ticket id, like eng-1234-fix-login", reason: "it lets the CI bot auto-link the ticket" },
  { topic: "error messages", rule: "start lowercase with no trailing period", reason: "it matches Node's convention for Error.message" },
  { topic: "SQL migration files", rule: "named with a UTC timestamp prefix", reason: "it guarantees migrations apply in a deterministic order" },
];
const GEN_FILES = [
  { file: "src/generated/api-types.ts", tool: "openapi-generator" },
  { file: "src/generated/graphql-schema.ts", tool: "graphql-codegen" },
  { file: "prisma/generated/client.ts", tool: "prisma generate" },
  { file: "src/generated/i18n-keys.ts", tool: "i18n-extract" },
];

const conventions: Domain = {
  name: "conventions-and-style",
  people: ENGINEERS,
  noise: [
    "PR comment: nit, add a trailing comma here",
    "the style guide doc needs a table of contents",
    "prettier formatted this whole file, sorry for the noisy diff",
    "someone's editor keeps stripping trailing whitespace differently",
    "diff --git a/.eslintrc.json b/.eslintrc.json\n+\"no-console\": \"warn\"",
    "does the linter care about JSX quote style",
    "the code review bot left 12 comments on this one PR",
    "lol the bikeshedding on tabs vs spaces again",
    "someone added a new eslint plugin without discussion",
    "the style guide link in the README is broken",
    "reminder: squash commits before merging",
    "there's a typo in the contributing guide",
    "new intern asked about our naming conventions today",
    "the formatter config got out of sync with CI",
  ],
  gens: {
    exact: [
      (P) => { const c = pick(CONVENTIONS); return pairQuery("exact", `${c.topic[0]!.toUpperCase() + c.topic.slice(1)} use ${c.rule}.`, `What's the naming convention for ${c.topic}?`, new RegExp(esc(c.rule.split(",")[0]!.split(" ").slice(0, 3).join(" ")), "i")); },
    ],
    paraphrase: [
      (P) => { const c = pick(CONVENTIONS); return pairQuery("paraphrase", `${c.topic[0]!.toUpperCase() + c.topic.slice(1)} use ${c.rule}.`, `How should I format ${c.topic}?`, new RegExp(esc(c.rule.split(",")[0]!.split(" ").slice(0, 3).join(" ")), "i")); },
      (P) => { const c = pick(CONVENTIONS); return pairQuery("paraphrase", `${c.topic[0]!.toUpperCase() + c.topic.slice(1)} use ${c.rule}.`, `What style rule applies to ${c.topic}?`, new RegExp(esc(c.rule.split(",")[0]!.split(" ").slice(0, 3).join(" ")), "i")); },
    ],
    update: [
      (P) => ({ style: "update", facts: [{ text: `We used tabs for indentation.` }, { text: `We switched from tabs to 2-space indentation repo-wide.`, late: true }], q: `Do we use tabs or spaces for indentation?`, want: /2-space|spaces/i, stale: /tabs/i } as Query),
      (P) => { const [n1, n2] = sample([80, 100, 120], 2) as [number, number]; return { style: "update", facts: [{ text: `Max line length was ${n1} characters.` }, { text: `We relaxed the max line length to ${n2} characters.`, late: true }], q: `What is the max line length?`, want: new RegExp(`\\b${n2}\\b`), stale: new RegExp(`\\b${n1}\\b`) }; },
    ],
    multihop: [
      (P) => { return { style: "multihop", facts: [{ text: `Conventional Commits format is enforced for commit messages.` }, { text: `The commit-lint config that enforces Conventional Commits lives in \`.commitlintrc.js\`.` }], q: `Which file enforces the commit message format?`, want: /\.commitlintrc\.js/i }; },
    ],
    numeric: [
      (P) => { const n = pick([80, 100, 120]); return pairQuery("numeric", `Max line length is ${n} characters.`, `What is the max allowed line length?`, new RegExp(`\\b${n}\\b`)); },
      (P) => { const n = pick([300, 400, 500]); return pairQuery("numeric", `We split a module into smaller files once it passes ${n} lines.`, `At how many lines do we split a module into smaller files?`, new RegExp(`\\b${n}\\b`)); },
    ],
    negation: [
      (P) => pairQuery("negation", `Never commit directly to main; always open a pull request.`, `Can I push directly to main?`, /never|not allowed|no\b/i),
      (P) => { const g = pick(GEN_FILES); return pairQuery("negation", `Don't touch \`${g.file}\`, it's auto-generated by ${g.tool} and gets overwritten.`, `Should I hand-edit ${g.file}?`, /don't|do not|no\b/i); },
      (P) => pairQuery("negation", `We do not allow default exports in shared library modules.`, `Are default exports allowed in shared library modules?`, /do not allow|no\b|not allowed/i),
    ],
    distractor: [
      (P) => { const cs = sample(CONVENTIONS, 8); const facts = cs.map((c) => ({ text: `${c.topic[0]!.toUpperCase() + c.topic.slice(1)} use ${c.rule}.` })); const i = Math.floor(rnd() * cs.length); return { style: "distractor", facts, q: `What's the convention for ${cs[i]!.topic}?`, want: new RegExp(esc(cs[i]!.rule.split(",")[0]!.split(" ").slice(0, 3).join(" ")), "i") }; },
    ],
    rationale: [
      (P) => { const c = pick(CONVENTIONS); return pairQuery("rationale", `${c.topic[0]!.toUpperCase() + c.topic.slice(1)} use ${c.rule} because ${c.reason}.`, `Why do we use ${c.rule.split(",")[0]} for ${c.topic}?`, new RegExp(esc(c.reason.split(" ").slice(-4).join(" ")), "i")); },
    ],
    "which-file": [
      (P) => { const g = pick(GEN_FILES); return pairQuery("which-file", `Don't touch \`${g.file}\`, it's auto-generated by ${g.tool}.`, `Which file should I avoid editing directly because it's auto-generated?`, new RegExp(esc(g.file), "i")); },
      (P) => pairQuery("which-file", `The shared eslint config lives in \`packages/config/eslint-preset.js\`.`, `Which file defines the shared eslint config?`, /packages\/config\/eslint-preset\.js/i),
    ],
  },
};

// ============================================================================
// 5. environment-and-secrets
// ============================================================================
const ENV_ITEMS = [
  { name: "staging API key", var: "STAGING_API_KEY", file: "src/config/env.ts" },
  { name: "Stripe webhook secret", var: "STRIPE_WEBHOOK_SECRET", file: "src/payments/config.ts" },
  { name: "database URL", var: "DATABASE_URL", file: "src/db/connection.ts" },
  { name: "Sentry DSN", var: "SENTRY_DSN", file: "src/observability/sentry.ts" },
  { name: "JWT signing key", var: "JWT_SECRET", file: "src/auth/jwt.ts" },
  { name: "Redis connection string", var: "REDIS_URL", file: "src/cache/redis-client.ts" },
  { name: "feature flag service key", var: "LAUNCHDARKLY_SDK_KEY", file: "src/flags/client.ts" },
  { name: "uploads bucket name", var: "UPLOADS_BUCKET", file: "src/storage/s3.ts" },
];
const PORTS_SVC = [
  { svc: "Postgres", port: 5432 }, { svc: "Redis", port: 6379 }, { svc: "the local dev server", port: 4200 },
  { svc: "the API gateway", port: 8080 }, { svc: "the mock email server", port: 1080 }, { svc: "Elasticsearch", port: 9200 },
];
const SECRET_MOVES = [
  { action: "moved secrets to AWS Secrets Manager", reason: "a plaintext API key was accidentally committed and leaked last quarter" },
  { action: "rotated the database password", reason: "a former contractor's laptop was compromised" },
  { action: "added a pre-commit hook that blocks .env files", reason: "engineers kept accidentally staging local secrets" },
];

const environment: Domain = {
  name: "environment-and-secrets",
  people: ENGINEERS,
  noise: [
    "$ docker compose up -d\nAll services started",
    "staging deploy finished in 2m14s",
    "does anyone know why the vpn keeps dropping",
    "the onboarding doc for local setup needs an update",
    "diff --git a/.env.example b/.env.example\n+NEW_FEATURE_FLAG=false",
    "reminder to rotate your personal access token this month",
    "the office badge reader is broken again",
    "someone's local postgres is on a weird version",
    "deploy dashboard link changed, updating the wiki",
    "lol autocomplete keeps suggesting the wrong env var name",
    "the staging environment got wiped for a migration test",
    "anyone else's docker desktop eating all the RAM",
    "new laptop setup script needs a fix for M-series chips",
    "the runbook for incident response got a new section",
  ],
  gens: {
    exact: [
      (P) => { const e = pick(ENV_ITEMS); return pairQuery("exact", `The env var for the ${e.name} is \`${e.var}\`.`, `What's the env var name for the ${e.name}?`, new RegExp(esc(e.var))); },
    ],
    paraphrase: [
      (P) => { const e = pick(ENV_ITEMS); return pairQuery("paraphrase", `The env var for the ${e.name} is \`${e.var}\`.`, `Which environment variable holds the ${e.name}?`, new RegExp(esc(e.var))); },
      (P) => { const e = pick(ENV_ITEMS); return pairQuery("paraphrase", `The env var for the ${e.name} is \`${e.var}\`.`, `What do we call the config value for the ${e.name}?`, new RegExp(esc(e.var))); },
    ],
    update: [
      (P) => { const m = pick(SECRET_MOVES); return { style: "update", facts: [{ text: `Secrets used to live in a plain \`.env\` file.` }, { text: `We ${m.action}.`, late: true }], q: `Where do secrets live now?`, want: /Secrets Manager|pre-commit hook|rotated/i, stale: /plain `?\.env/i }; },
    ],
    multihop: [
      (P) => { const e = pick(ENV_ITEMS); return { style: "multihop", facts: [{ text: `The ${e.name} is stored in the env var \`${e.var}\`.` }, { text: `\`${e.var}\` is loaded in \`${e.file}\`.` }], q: `Which file loads the ${e.name}?`, want: new RegExp(esc(e.file), "i") }; },
    ],
    numeric: [
      (P) => { const s = pick(PORTS_SVC); return pairQuery("numeric", `${s.svc} runs on port ${s.port} locally.`, `What port does ${s.svc} use locally?`, new RegExp(`\\b${s.port}\\b`)); },
      (P) => { const n = pick([15, 30, 60, 90]); return pairQuery("numeric", `API keys are rotated every ${n} days.`, `How often are API keys rotated?`, new RegExp(`\\b${n}\\b`)); },
    ],
    negation: [
      (P) => pairQuery("negation", `Never commit \`.env.production\` to git.`, `Is it OK to commit .env.production?`, /never|not|no\b/i),
      (P) => { const e = pick(ENV_ITEMS); return pairQuery("negation", `The ${e.name} is not needed for local development, only staging and prod.`, `Do I need the ${e.name} for local development?`, /not needed|no\b/i); },
    ],
    distractor: [
      (P) => { const es = sample(ENV_ITEMS, 8); const facts = es.map((e) => ({ text: `The env var for the ${e.name} is \`${e.var}\`.` })); const i = Math.floor(rnd() * es.length); return { style: "distractor", facts, q: `What's the env var for the ${es[i]!.name}?`, want: new RegExp(esc(es[i]!.var)) }; },
    ],
    rationale: [
      (P) => { const m = pick(SECRET_MOVES); return pairQuery("rationale", `We ${m.action} because ${m.reason}.`, `Why did we ${m.action.startsWith("moved") ? "move secrets to Secrets Manager" : m.action}?`, new RegExp(esc(m.reason.split(" ").slice(-4).join(" ")), "i")); },
    ],
    "which-file": [
      (P) => pairQuery("which-file", `Required environment variables are validated in \`src/config/env-schema.ts\`.`, `Which file validates required environment variables?`, /src\/config\/env-schema\.ts/i),
      (P) => { const e = pick(ENV_ITEMS); return pairQuery("which-file", `\`${e.var}\` is loaded in \`${e.file}\`.`, `Which file loads the ${e.var} environment variable?`, new RegExp(esc(e.file), "i")); },
    ],
  },
};

// ============================================================================
// 6. dependency-and-versions
// ============================================================================
const DEPS = [
  { pkg: "react", version: "18.2.0", reason: "18.3 broke our custom test renderer", action: "pinned" },
  { pkg: "webpack", version: "4", reason: "upgrading past v4 breaks the legacy build pipeline for the admin app", action: "capped" },
  { pkg: "lodash", version: "4.17.21", reason: "it patches a prototype pollution vulnerability", action: "upgraded" },
  { pkg: "typescript", version: "5.3.3", reason: "5.4 changed decorator emit and broke our DI container", action: "pinned" },
  { pkg: "node", version: "20.11.0", reason: "we rely on its native fetch and test runner support", action: "required" },
  { pkg: "zod", version: "3.22.4", reason: "it's the schema validation library standardized on across all services", action: "standardized on", file: "src/schemas/index.ts" },
  { pkg: "eslint", version: "8", reason: "the flat config in v9 isn't compatible with our shared config package yet", action: "capped" },
  { pkg: "prisma", version: "5.7.0", reason: "5.8 introduced a breaking change to our migration shadow database setup", action: "pinned" },
];

const dependencies: Domain = {
  name: "dependency-and-versions",
  people: ENGINEERS,
  noise: [
    "$ pnpm outdated\n14 packages have newer versions",
    "dependabot opened another PR overnight",
    "the changelog for this release is huge",
    "someone's lockfile diff has 400 lines of noise",
    "diff --git a/package.json b/package.json\n-\"axios\": \"^1.4.0\"\n+\"axios\": \"^1.6.0\"",
    "renovate bot keeps opening duplicate PRs",
    "the security scanner flagged a transitive dependency",
    "lol another left-pad style incident almost happened",
    "npm audit fix broke something unrelated again",
    "the monorepo has three different versions of react somehow",
    "someone should write a script to dedupe the lockfile",
    "reminder: don't merge dependency bumps on a Friday",
    "the bundle size report shows a regression",
    "new intern asked why we're not on the latest version of everything",
  ],
  gens: {
    exact: [
      (P) => { const d = pick(DEPS); return pairQuery("exact", `We ${d.action} \`${d.pkg}\` at ${d.version} because ${d.reason}.`, `What version of ${d.pkg} do we use?`, new RegExp(esc(d.version))); },
    ],
    paraphrase: [
      (P) => { const d = pick(DEPS); return pairQuery("paraphrase", `We ${d.action} \`${d.pkg}\` at ${d.version} because ${d.reason}.`, `Which version of ${d.pkg} is in the lockfile?`, new RegExp(esc(d.version))); },
      (P) => { const d = pick(DEPS); return pairQuery("paraphrase", `We ${d.action} \`${d.pkg}\` at ${d.version} because ${d.reason}.`, `What's the current ${d.pkg} version we depend on?`, new RegExp(esc(d.version))); },
    ],
    update: [
      (P) => { const [v1, v2] = sample(["1.2.0", "1.3.0", "1.4.1", "2.0.0", "2.1.3"], 2) as [string, string]; const pkg = pick(["axios", "express", "moment", "uuid"]); return { style: "update", facts: [{ text: `We were on \`${pkg}\` ${v1}.` }, { text: `We upgraded \`${pkg}\` to ${v2} to patch a security vulnerability.`, late: true }], q: `What version of ${pkg} are we on now?`, want: new RegExp(esc(v2)), stale: new RegExp(esc(v1)) }; },
    ],
    multihop: [
      (P) => { const d = DEPS.find((x) => x.file)!; return { style: "multihop", facts: [{ text: `We standardized on \`${d.pkg}\` for schema validation.` }, { text: `\`${d.pkg}\` schemas live in \`${d.file}\`.` }], q: `Which file contains the schema validation setup for ${d.pkg}?`, want: new RegExp(esc(d.file!), "i") }; },
    ],
    numeric: [
      (P) => { const d = pick(DEPS.filter((x) => /^\d/.test(x.version))); return pairQuery("numeric", `We ${d.action} \`${d.pkg}\` at ${d.version}.`, `What major version of ${d.pkg} are we on?`, new RegExp(`\\b${d.version.split(".")[0]}\\b`)); },
      (P) => { const n = pick([2, 3, 4, 5]); return pairQuery("numeric", `We stay ${n} minor versions behind on \`typescript\` intentionally to let the ecosystem catch up.`, `How many minor versions behind on typescript do we stay intentionally?`, new RegExp(`\\b${n}\\b`)); },
    ],
    negation: [
      (P) => { const d = pick(DEPS); return pairQuery("negation", `Do not upgrade \`${d.pkg}\` past ${d.version}; it breaks things.`, `Is it safe to upgrade ${d.pkg} right now?`, /do not upgrade|no\b|breaks/i); },
      (P) => pairQuery("negation", `We do not use \`moment\` for new code anymore; it's frozen at its current version.`, `Should I use moment for new date-handling code?`, /do not use|no\b|frozen/i),
    ],
    distractor: [
      (P) => { const ds = sample(DEPS, 8); const facts = ds.map((d) => ({ text: `We ${d.action} \`${d.pkg}\` at ${d.version}.` })); const i = Math.floor(rnd() * ds.length); return { style: "distractor", facts, q: `What version of ${ds[i]!.pkg} do we use?`, want: new RegExp(esc(ds[i]!.version)) }; },
    ],
    rationale: [
      (P) => { const d = pick(DEPS); return pairQuery("rationale", `We ${d.action} \`${d.pkg}\` at ${d.version} because ${d.reason}.`, `Why is \`${d.pkg}\` ${d.action === "capped" ? "capped at" : d.action === "pinned" ? "pinned to" : "at"} ${d.version}?`, new RegExp(esc(d.reason.split(" ").slice(-4).join(" ")), "i")); },
    ],
    "which-file": [
      (P) => pairQuery("which-file", `Exact dependency versions are locked in \`pnpm-lock.yaml\`.`, `Which file pins our exact dependency versions?`, /pnpm-lock\.yaml/i),
      (P) => pairQuery("which-file", `Dependency version overrides live in the \`pnpm.overrides\` field of \`package.json\`.`, `Which file contains our dependency version overrides?`, /package\.json/i),
    ],
  },
};

const DOMAINS = [buildAndTest, architecture, bugFixes, conventions, environment, dependencies];
const STYLES: Style[] = ["exact", "paraphrase", "update", "multihop", "numeric", "negation", "distractor", "rationale", "which-file"];
const OFF_TOPIC = [
  "haha that meme in standup was great",
  "ugh mondays",
  "what's a good name for our new mascot bot",
  "lol ok sure",
  "thinking about learning to juggle at lunch",
];

// ---------- world building ----------
type Turn = { text: string; speaker: string; date: string; session: number; at: number };
type World = { domain: string; turns: Turn[]; queries: Query[]; buried: number };

function buildWorld(dom: Domain, idx: number): World {
  const queries: Query[] = [];
  for (const style of STYLES) {
    const n = style === "distractor" ? 1 : style === "multihop" ? 2 : 3;
    for (let i = 0; i < n; i++) queries.push(pick(dom.gens[style])(dom.people));
  }
  // dedupe: drop later queries whose fact text collides with an earlier one
  const seen = new Set<string>();
  const kept = queries.filter((q) => {
    const key = q.facts.map((f) => f.text).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // early facts, late facts (updates) in later sessions
  const early: Fact[] = [];
  const late: Fact[] = [];
  for (const q of kept) for (const f of q.facts) (f.late ? late : early).push(f);
  // mark ~25% of early single facts as buried
  let buried = 0;
  for (const f of shuffle([...early])) {
    if (buried >= Math.round(early.length * 0.25)) break;
    f.buried = true;
    buried++;
  }
  const turns: Turn[] = [];
  let at = 0;
  let session = 1;
  const day = (s: number) => `2026-03-${String(1 + s).padStart(2, "0")} 09:00`;
  const push = (text: string, s: number, speaker: string) => turns.push({ text, speaker, date: day(s), session: s, at: at++ });
  const noiseLine = () => pick(dom.noise);
  // session 1..n: plain facts with light noise
  for (const f of shuffle(early.filter((f) => !f.buried))) {
    push(noiseLine(), session, "speaker");
    push(f.text, session, "speaker");
    if (rnd() < 0.5) push(noiseLine(), session, "speaker");
    if (rnd() < 0.3) session++;
  }
  // buried sessions: 20+ noise messages with the fact somewhere in the middle
  for (const f of early.filter((f) => f.buried)) {
    session++;
    const len = 22 + Math.floor(rnd() * 8);
    const slot = 6 + Math.floor(rnd() * (len - 12));
    for (let i = 0; i < len; i++) push(i === slot ? f.text : noiseLine(), session, i % 2 ? "friend" : "speaker");
  }
  // late (supersession) facts in the final sessions
  for (const f of shuffle(late)) {
    session++;
    push(noiseLine(), session, "speaker");
    push(f.text, session, "speaker");
  }
  return { domain: dom.name + "-" + idx, turns, queries: kept, buried };
}

// ============================================================================
// Baselines. Naming + overlap logic matches benchmarks/memory-bakeoff/run.ts;
// BM25 here uses the standard k1=1.2 / b=0.75 params (run.ts uses k1=1.5).
// ============================================================================

const STOP = new Set(
  "the of is a an on to and in for this that with from into about these then still has out how what why was are you your its our not or no".split(" "),
);

function toks(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? []).filter((w) => w.length >= 2 && !STOP.has(w));
}

function overlapScore(q: string, doc: string): number {
  const hay = new Set(toks(doc));
  return toks(q).reduce((n, w) => n + +hay.has(w), 0);
}

function bm25(query: string, docs: string[], k: number): string[] {
  const N = docs.length || 1;
  const dl = docs.map((d) => Math.max(1, toks(d).length));
  const avgdl = dl.reduce((a, b) => a + b, 0) / N;
  const df = new Map<string, number>();
  const tfs: Map<string, number>[] = docs.map((d) => {
    const m = new Map<string, number>();
    for (const w of toks(d)) m.set(w, (m.get(w) || 0) + 1);
    for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
    return m;
  });
  const q = toks(query);
  const k1 = 1.2, b = 0.75; // standard BM25 params
  const scored = docs.map((d, i) => {
    let s = 0;
    const tf = tfs[i]!;
    for (const w of q) {
      const n = tf.get(w) || 0;
      if (!n) continue;
      const idf = Math.log((N - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5) + 1);
      s += (idf * (n * (k1 + 1))) / (n + k1 * (1 - b + b * (dl[i]! / avgdl)));
    }
    return { d, s };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.d);
}

interface Baseline {
  id: string;
  ingest(texts: string[]): void;
  retrieve(q: string, k: number): string[];
}

class LastKSys implements Baseline {
  id = "lastk";
  buf: string[] = [];
  ingest(texts: string[]) {
    this.buf.push(...texts);
  }
  retrieve(_q: string, k: number) {
    return this.buf.slice(-k);
  }
}

class OverlapStoreSys implements Baseline {
  id = "storeall-overlap";
  docs: string[] = [];
  ingest(texts: string[]) {
    for (const t of texts) if (t.trim()) this.docs.push(t.trim());
  }
  retrieve(q: string, k: number) {
    return this.docs
      .map((d) => ({ d, s: overlapScore(q, d) }))
      .filter((x) => x.s)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.d);
  }
}

class Bm25Sys implements Baseline {
  id = "storeall-bm25";
  docs: string[] = [];
  ingest(texts: string[]) {
    for (const t of texts) if (t.trim()) this.docs.push(t.trim());
  }
  retrieve(q: string, k: number) {
    return bm25(q, this.docs, k);
  }
}

function makeBaselines(): Baseline[] {
  return [new Bm25Sys(), new OverlapStoreSys(), new LastKSys()];
}

// ============================================================================
// Run all four systems (eden + 3 baselines) over the identical corpus.
// ============================================================================

type Tally = { n: number; miss: number };
type SysStats = {
  id: string;
  total: number;
  miss: number;
  byDomain: Map<string, Tally>;
  byStyle: Map<string, Tally>;
};

const bump = (m: Map<string, Tally>, k: string, miss: boolean) => {
  const t = m.get(k) || { n: 0, miss: 0 };
  t.n++;
  if (miss) t.miss++;
  m.set(k, t);
};

const SYS_IDS = ["eden", "storeall-bm25", "storeall-overlap", "lastk"];
const stats: Record<string, SysStats> = {};
for (const id of SYS_IDS) stats[id] = { id, total: 0, miss: 0, byDomain: new Map(), byStyle: new Map() };

function score(id: string, domain: string, style: Style, hit: boolean) {
  const s = stats[id]!;
  s.total++;
  if (!hit) s.miss++;
  bump(s.byDomain, domain, !hit);
  bump(s.byStyle, style, !hit);
}

const tAll = performance.now();

for (const dom of DOMAINS) {
  for (let w = 0; w < WORLDS_PER_DOMAIN; w++) {
    const world = buildWorld(dom, w);
    const dir = join(ROOT, world.domain);
    mkdirSync(dir, { recursive: true });

    // Eden
    const brain = new BrainMemory({ dir });
    brain.ingestTurns(world.turns);

    // Baselines: ingest the same turns, in the same order, as plain text.
    const baselines = makeBaselines();
    const turnTexts = world.turns.map((t) => t.text);
    for (const b of baselines) b.ingest(turnTexts);

    for (const q of world.queries) {
      const edenText = brain.retrieve(q.q, K).join("\n");
      score("eden", dom.name, q.style, q.want.test(edenText));
      for (const b of baselines) {
        const text = b.retrieve(q.q, K).join("\n");
        score(b.id, dom.name, q.style, q.want.test(text));
      }
    }

    // Preserve coding-holdout.ts's exact PRNG call sequence (its junk-probe
    // step draws from `sample()` between worlds) so later worlds match its
    // corpus byte-for-byte. The probes themselves aren't scored here.
    sample(OFF_TOPIC, 2);

    brain.close();
  }
}

const elapsedMs = performance.now() - tAll;

try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {}

// ============================================================================
// Report
// ============================================================================

const STYLE_LABEL: Record<Style, string> = {
  exact: "exact",
  paraphrase: "para",
  update: "update",
  multihop: "multihop",
  numeric: "numeric",
  negation: "negation",
  distractor: "distractor",
  rationale: "rationale",
  "which-file": "whichfile",
};

function pct(hit: number, n: number): string {
  return `${((100 * hit) / Math.max(1, n)).toFixed(1)}%`;
}

console.log(`# coding-baselines: seed=${SEED} K=${K} worlds=${DOMAINS.length * WORLDS_PER_DOMAIN} queries=${stats.eden!.total} elapsed=${Math.round(elapsedMs)}ms\n`);

// ---- compact comparison table ----
const ORDER = ["eden", "storeall-bm25", "storeall-overlap", "lastk"];
const nameW = 18;
const header =
  "system".padEnd(nameW) +
  "hit@5".padEnd(10) +
  "hit%".padEnd(8) +
  "| by style: " +
  STYLES.map((s) => STYLE_LABEL[s]).join(" ");
console.log(header);
console.log("-".repeat(header.length));
for (const id of ORDER) {
  const s = stats[id]!;
  const hit = s.total - s.miss;
  const styleCells = STYLES.map((st) => {
    const t = s.byStyle.get(st) || { n: 0, miss: 0 };
    const h = t.n - t.miss;
    return `${STYLE_LABEL[st]} ${pct(h, t.n)}`;
  }).join("  ");
  console.log(
    `${id.padEnd(nameW)}${`${hit}/${s.total}`.padEnd(10)}${pct(hit, s.total).padEnd(8)}| ${styleCells}`,
  );
}

// ---- full per-domain / per-style detail, per system ----
for (const id of ORDER) {
  const s = stats[id]!;
  const hit = s.total - s.miss;
  console.log(`\n# ${id}: hit ${hit}/${s.total} (${pct(hit, s.total)})`);
  console.log("#   by domain");
  for (const [k, t] of s.byDomain) {
    const h = t.n - t.miss;
    console.log(`#     ${k.padEnd(23)} hit ${String(h).padStart(3)}/${t.n}  (${pct(h, t.n)})`);
  }
  console.log("#   by style");
  for (const [k, t] of s.byStyle) {
    const h = t.n - t.miss;
    console.log(`#     ${k.padEnd(11)} hit ${String(h).padStart(3)}/${t.n}  (${pct(h, t.n)})`);
  }
}
