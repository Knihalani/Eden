/**
 * coding-worlds: seeded generator of realistic multi-session coding-agent transcripts
 * (Claude Code–shaped: short user asks, narrated assistant turns, tool results dropped —
 * exactly what packages/cli/src/memory-hook.ts feeds AgentMemory.observe()).
 *
 * Each world = one project, ~60 sessions in chronological order. Session kinds:
 *   bug      symptom → investigation → root cause → fix (multi-hop chain)
 *   decide   "we chose X over Y because Z" during feature work
 *   rule     user states a convention / constraint
 *   env      an environment fact (port, db name, url, env var, ...) — some later UPDATED
 *   filler   unrelated tasks sharing vocabulary (files, services) = distractors
 *
 * Probes are asked as if in a NEW session later: half are direct questions, half are
 * task statements ("ECONNRESET is back in the email worker") the way a user actually
 * opens a session. Families: bugchain, rationale, rule, env (+ update/negative junk).
 */

export type Msg = { role: "user" | "assistant"; content: string };
export type Session = { kind: string; msgs: Msg[] };
export type Probe = {
  family: "bugchain" | "rationale" | "rule" | "env";
  form: "question" | "task";
  q: string;
  gold: string[];          // any of these substrings (normalized) in top-k = hit
  stale?: string[];        // superseded values: junk if ranked above every gold
  negative?: boolean;      // nothing relevant exists; forbidden[] appearing = junk
  forbidden?: string[];
};
export type World = { name: string; seed: number; sessions: Session[]; probes: Probe[] };

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
function shuffle<T>(r: () => number, xs: T[]): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const PROJECTS = ["atlas", "nimbus", "ledger-api", "quill", "harbor", "sparrow", "meridian"];
const FILES = [
  "src/auth/session.ts", "src/db/pool.ts", "lib/cache/lru.ts", "api/routes/orders.ts", "workers/email-queue.ts",
  "src/billing/invoice.ts", "src/search/indexer.ts", "pkg/ratelimit/bucket.go", "cmd/server/main.go", "app/models/user.py",
  "src/upload/s3.ts", "src/webhooks/stripe.ts", "src/jobs/scheduler.ts", "src/config/env.ts", "src/api/middleware/cors.ts",
  "src/reports/export.ts", "src/notifications/push.ts", "src/graphql/resolvers/cart.ts", "src/sync/replicator.ts", "src/pdf/render.ts",
];
const COMPONENTS = [
  "the email worker", "the checkout flow", "the search indexer", "the auth middleware", "the invoice generator",
  "the upload service", "the stripe webhook handler", "the job scheduler", "the CORS layer", "the report exporter",
  "the push notifier", "the cart resolver", "the replicator", "the PDF renderer", "the rate limiter", "the session store",
];
const SYMPTOMS = [
  "ECONNRESET errors", "a TypeError reading 'id' of undefined", "deadlock detected errors", "ETIMEDOUT after 30s",
  "429 Too Many Requests responses", "an OOM kill in production", "duplicate rows", "a 502 from the load balancer",
  "stale results after a write", "tokens expiring early", "a flaky timeout in CI", "intermittent 401s",
  "a memory leak over 6 hours", "corrupted PDF output", "a negative balance", "missing webhook events",
  "an infinite retry loop", "a null pointer in the serializer", "slow queries over 2s", "wrong timezone on invoices",
];
const CAUSES = [
  ["the connection pool max was 5 while the worker ran 8 concurrent jobs", "pool max was 5"],
  ["the JWT clock skew tolerance was zero", "clock skew tolerance was zero"],
  ["the LRU cache measured size in bytes but evicted by entry count", "measured size in bytes"],
  ["a missing await inside the retry loop swallowed the rejection", "missing await inside the retry loop"],
  ["migration 0041 dropped the index on orders.customer_id", "dropped the index on orders.customer_id"],
  ["the env var was read before dotenv had loaded", "read before dotenv had loaded"],
  ["the refresh token was rotated by two tabs at once", "rotated by two tabs at once"],
  ["the keep-alive agent capped sockets at 2", "capped sockets at 2"],
  ["Date.parse assumed local time instead of UTC", "assumed local time instead of UTC"],
  ["the batch size of 5000 exceeded the 1MB SQS limit", "exceeded the 1MB SQS limit"],
  ["the mutex was released before the write flushed", "released before the write flushed"],
  ["a regex with nested quantifiers backtracked catastrophically", "backtracked catastrophically"],
  ["the idempotency key was derived from the timestamp", "derived from the timestamp"],
  ["the scheduler used setInterval which drifted under load", "setInterval which drifted"],
  ["the CDN cached the 401 response for 60 seconds", "cached the 401 response"],
  ["float rounding in the cents conversion", "float rounding in the cents conversion"],
  ["the signature header was compared with == instead of a constant-time compare", "instead of a constant-time compare"],
  ["the worker pinned an old lockfile with a leaking version of undici", "leaking version of undici"],
  ["the health check pinged the replica not the primary", "pinged the replica not the primary"],
  ["a stale .d.ts shadowed the real module", "stale .d.ts shadowed the real module"],
];
const FIXES = [
  ["raised the pool max to 20 and added a semaphore around the worker", "semaphore around the worker"],
  ["added a 30 second leeway to the JWT validation", "30 second leeway"],
  ["switched eviction to count entries", "eviction to count entries"],
  ["added the missing await and a unit test for the rejection path", "added the missing await"],
  ["recreated the index in migration 0042", "migration 0042"],
  ["moved the dotenv import to the top of the entrypoint", "dotenv import to the top"],
  ["serialised refresh behind a BroadcastChannel lock", "BroadcastChannel lock"],
  ["set maxSockets to 64 on the agent", "maxSockets to 64"],
  ["forced UTC by appending Z before parsing", "appending Z before parsing"],
  ["chunked batches to 500 messages", "chunked batches to 500"],
  ["moved the release into a finally after flush", "finally after flush"],
  ["rewrote the regex with an atomic group and a length cap", "atomic group and a length cap"],
  ["derived the idempotency key from the order id", "idempotency key from the order id"],
  ["replaced setInterval with a self-correcting setTimeout", "self-correcting setTimeout"],
  ["added Cache-Control no-store on auth failures", "Cache-Control no-store"],
  ["switched cents to integer math with BigInt", "integer math with BigInt"],
  ["used crypto.timingSafeEqual for the signature", "timingSafeEqual"],
  ["bumped undici to 6.19 and regenerated the lockfile", "undici to 6.19"],
  ["pointed the health check at the primary", "health check at the primary"],
  ["deleted the stale .d.ts and added it to .gitignore", "deleted the stale .d.ts"],
];
const DECISIONS = [
  ["sqlite", "postgres", "the local cache", "it needs zero ops on developer laptops", "zero ops on developer laptops"],
  ["zod", "yup", "request validation", "it infers the TypeScript types for free", "infers the TypeScript types"],
  ["bun", "node", "the runtime", "startup time matters for the CLI", "startup time matters"],
  ["pnpm", "npm", "the package manager", "it dedupes the monorepo on disk", "dedupes the monorepo"],
  ["argon2", "bcrypt", "password hashing", "it is memory-hard and resists GPU attacks", "memory-hard"],
  ["tanstack query", "swr", "data fetching", "the devtools and cache invalidation are better", "devtools and cache invalidation"],
  ["drizzle", "prisma", "the ORM", "it has no codegen step and ships raw SQL", "no codegen step"],
  ["vitest", "jest", "the test runner", "it shares the vite config and runs in ESM natively", "runs in ESM natively"],
  ["hono", "express", "the HTTP framework", "it runs on edge runtimes without a shim", "edge runtimes without a shim"],
  ["ulid", "uuid v4", "primary keys", "ulids sort by creation time in the b-tree", "sort by creation time"],
  ["temporal", "bullmq", "background workflows", "retries and history are durable out of the box", "durable out of the box"],
  ["s3 presigned urls", "proxying uploads", "file uploads", "it keeps large bodies off the API pods", "keeps large bodies off the API pods"],
  ["opentelemetry", "vendor SDKs", "tracing", "we can swap backends without touching call sites", "swap backends without touching call sites"],
  ["cursor pagination", "offset pagination", "the list endpoints", "offsets get slow past page 1000", "slow past page 1000"],
  ["a monorepo", "polyrepo", "the repo layout", "shared types stay in sync in one PR", "shared types stay in sync"],
  ["tailwind", "css modules", "styling", "design tokens live in one config", "design tokens live in one config"],
];
const RULES = [
  ["always run bun test before committing", "run bun test before committing", ["commit these changes", "wrap this up and commit"]],
  ["never use the any type, use unknown and narrow", "use unknown and narrow", ["type this payload", "fix the type errors in the parser"]],
  ["commit messages must be imperative mood with no emoji", "imperative mood with no emoji", ["write the commit message", "commit this"]],
  ["do not edit anything under generated/, it is overwritten by codegen", "overwritten by codegen", ["fix the type error in generated/client.ts", "there is a lint error under generated/"]],
  ["never commit .env, secrets go in 1password", "secrets go in 1password", ["add the API key config", "wire up the stripe secret"]],
  ["put integration tests under tests/integration not next to the source", "under tests/integration", ["add an integration test for checkout", "write a test that hits the real db"]],
  ["prefer named exports, default exports are banned", "default exports are banned", ["create a new module for the mailer", "export the helper"]],
  ["use two space indentation and no semicolons", "no semicolons", ["format this file", "clean up the formatting"]],
  ["do not add new dependencies without asking first", "without asking first", ["add a date library", "install lodash for this"]],
  ["always open a PR against develop not main", "against develop not main", ["open a PR", "push this up for review"]],
  ["log with pino, never console.log in src/", "never console.log", ["add some logging here", "print the request for debugging"]],
  ["feature flags go through the flags service, never hardcode", "never hardcode", ["gate this behind a flag", "turn the new checkout on for 10% of users"]],
  ["migrations must be reversible with a down step", "reversible with a down step", ["write a migration for the new column", "add the index migration"]],
  ["do not touch the pricing table without finance sign-off", "without finance sign-off", ["update the pricing tiers", "change the enterprise price"]],
];
const ENV = [
  ["the dev server", "port", ["3000", "4100", "5173"], "what port does the dev server run on"],
  ["the database", "name", ["atlas_dev", "atlas_local", "app_dev"], "what is the local database name"],
  ["staging", "url", ["staging.example.dev", "stg.example.dev", "staging-2.example.dev"], "what is the staging url"],
  ["the API key", "env var", ["APP_API_KEY", "SERVICE_API_KEY", "API_TOKEN"], "which env var holds the API key"],
  ["the default branch", "name", ["main", "develop", "trunk"], "what is the default branch"],
  ["CI", "provider", ["GitHub Actions", "Buildkite", "CircleCI"], "which CI provider do we use"],
  ["the node version", "version", ["20.11", "22.4", "18.19"], "which node version does the project pin"],
  ["the redis instance", "port", ["6379", "6380", "6390"], "what port is redis on"],
  ["the docker compose db service", "name", ["db", "postgres", "pg"], "what is the compose service name for the database"],
  ["the test database", "name", ["atlas_test", "app_test", "test_db"], "what database do the tests use"],
  ["the metrics endpoint", "path", ["/metrics", "/internal/metrics", "/_metrics"], "what path serves metrics"],
  ["the deploy command", "command", ["make deploy", "bun run deploy", "./scripts/ship.sh"], "how do we deploy"],
];
const FILLER_TASKS = [
  "rename the helper in {file} to something clearer", "add jsdoc to the exports in {file}", "split {file} into two modules",
  "bump the dependencies and fix the lockfile", "make {component} log its timings", "add a README section for {component}",
  "convert {file} to use async iterators", "tidy the imports in {file}", "add a retry to {component}", "write unit tests for {file}",
  "make the linter pass in {file}", "add a feature flag around {component}", "remove the dead code in {file}", "add metrics to {component}",
];
const SMALLTALK = [
  "Sounds good.", "Thanks, that works.", "Great, moving on.", "ok", "cool", "Looks right to me.", "Nice, ship it.", "Let's do the next one.",
  "Hmm, one sec.", "Yep.", "Perfect.", "Can you double check?", "Alright.", "Done on my side.",
];
const ASSISTANT_SHORT = [
  "Let me look at that.", "I'll check the file first.", "Running the tests now.", "One moment, reading the logs.", "Looking into it.",
  "I'll trace where that value comes from.", "Let me reproduce it locally.", "Checking the git history for that file.",
];

function bugSession(r: () => number, i: number, used: Set<number>): { s: Session; probes: Probe[] } {
  let ci = Math.floor(r() * CAUSES.length);
  while (used.has(ci)) ci = (ci + 1) % CAUSES.length;
  used.add(ci);
  const comp = COMPONENTS[ci % COMPONENTS.length];
  const sym = SYMPTOMS[ci % SYMPTOMS.length];
  const file = FILES[ci % FILES.length];
  const [cause, causeKey] = CAUSES[ci];
  const [fix, fixKey] = FIXES[ci];
  const other = pick(r, FILES.filter((f) => f !== file));
  const msgs: Msg[] = [
    { role: "user", content: pick(r, [`We're seeing ${sym} from ${comp} since this morning, can you look?`, `${comp} is throwing ${sym} in prod`, `Can you dig into ${sym} in ${comp}?`]) },
    { role: "assistant", content: pick(r, ASSISTANT_SHORT) },
    { role: "assistant", content: `I read ${other} and ${file}. The stack trace for ${sym} points into ${file}, so ${comp} is where it starts.` },
    { role: "user", content: pick(r, ["Any idea why?", "What's causing it?", "Ok, what's the root cause?", "Hm, why though?"]) },
    { role: "assistant", content: `Root cause: ${cause}. That is why ${comp} shows ${sym}.` },
    { role: "user", content: pick(r, ["Fix it please.", "Can you patch that?", "Go ahead and fix it."]) },
    { role: "assistant", content: `I ${fix} in ${file}. Ran bun test, everything passes. The ${sym} in ${comp} should be gone.` },
    { role: "user", content: pick(r, SMALLTALK) },
  ];
  const probes: Probe[] = [
    { family: "bugchain", form: "question", q: pick(r, [`what was the root cause of ${sym} in ${comp}?`, `why was ${comp} giving ${sym}?`, `what caused ${sym} in ${comp} last time?`]), gold: [causeKey] },
    { family: "bugchain", form: "task", q: pick(r, [`${sym} again in ${comp}`, `${comp} is back to ${sym}, same as before`, `I think ${sym} in ${comp} regressed`]), gold: [causeKey, fixKey] },
    { family: "bugchain", form: "question", q: pick(r, [`how did we fix ${sym} in ${comp}?`, `what was the fix for ${sym} in ${comp}?`]), gold: [fixKey] },
    { family: "bugchain", form: "question", q: pick(r, [`which file did we change to fix ${sym} in ${comp}?`, `where did the ${sym} fix for ${comp} land?`]), gold: [file] },
  ];
  return { s: { kind: "bug", msgs }, probes };
}

function decideSession(r: () => number, used: Set<number>): { s: Session; probes: Probe[] } {
  let di = Math.floor(r() * DECISIONS.length);
  while (used.has(di)) di = (di + 1) % DECISIONS.length;
  used.add(di);
  const [x, y, what, why, whyKey] = DECISIONS[di];
  const file = pick(r, FILES);
  const msgs: Msg[] = [
    { role: "user", content: pick(r, [`Let's set up ${what}. ${x} or ${y}?`, `I need ${what} wired in. Thoughts on ${x} vs ${y}?`, `Pick something for ${what}.`]) },
    { role: "assistant", content: `I would go with ${x} over ${y} for ${what} because ${why}.` },
    { role: "user", content: pick(r, [`ok go with ${x}`, `${x} it is`, `agreed, use ${x}`]) },
    { role: "assistant", content: `We decided on ${x} instead of ${y} for ${what} because ${why}. I wired it into ${file} and added a smoke test.` },
    { role: "user", content: pick(r, SMALLTALK) },
  ];
  const probes: Probe[] = [
    { family: "rationale", form: "question", q: pick(r, [`why did we pick ${x} for ${what}?`, `why ${x} and not ${y}?`, `what was the reasoning behind ${x}?`]), gold: [whyKey] },
    { family: "rationale", form: "task", q: pick(r, [`should we move ${what} to ${y}?`, `someone suggested switching to ${y}, worth it?`, `I'm considering ${y} for ${what}`]), gold: [whyKey] },
  ];
  return { s: { kind: "decide", msgs }, probes };
}

function ruleSession(r: () => number, used: Set<number>): { s: Session; probes: Probe[] } {
  let ri = Math.floor(r() * RULES.length);
  while (used.has(ri)) ri = (ri + 1) % RULES.length;
  used.add(ri);
  const [rule, key, tasks] = RULES[ri] as [string, string, string[]];
  const file = pick(r, FILES);
  const msgs: Msg[] = [
    { role: "user", content: pick(r, [`Can you tidy ${file}?`, `Small cleanup in ${file} please`, `Refactor ${file} a bit`]) },
    { role: "assistant", content: `Tidied ${file}: removed two unused imports and simplified the early returns.` },
    { role: "user", content: pick(r, [`One rule for this repo: ${rule}.`, `Going forward, ${rule}.`, `Please remember: ${rule}.`]) },
    { role: "assistant", content: `Understood, I'll follow that: ${rule}.` },
    { role: "user", content: pick(r, SMALLTALK) },
  ];
  const probes: Probe[] = [
    { family: "rule", form: "task", q: pick(r, tasks), gold: [key] },
    { family: "rule", form: "question", q: pick(r, [`what rules do we have about ${key.split(" ").slice(-2).join(" ")}?`, `remind me of the repo convention around ${key.split(" ").slice(0, 2).join(" ")}`]), gold: [key] },
  ];
  return { s: { kind: "rule", msgs }, probes };
}

function envSession(r: () => number, ei: number, valueIdx: number, prev: string | null): Session {
  const [thing, slot, vals] = ENV[ei] as [string, string, string[], string];
  const v = vals[valueIdx];
  const msgs: Msg[] = prev
    ? [
        { role: "user", content: pick(r, [`Heads up, ${thing} ${slot} changed from ${prev} to ${v}.`, `We moved ${thing} to ${v} (was ${prev}).`, `${thing} is now ${v}, not ${prev} anymore.`]) },
        { role: "assistant", content: `Noted: ${thing} ${slot} is now ${v}, replacing ${prev}. I updated the references.` },
      ]
    : [
        { role: "user", content: pick(r, [`FYI ${thing} ${slot} is ${v}.`, `For reference, ${thing} uses ${v}.`, `${thing}: ${v}`]) },
        { role: "assistant", content: `Got it, ${thing} ${slot} is ${v}. I'll use that.` },
      ];
  return { kind: "env", msgs };
}

function fillerSession(r: () => number): Session {
  const file = pick(r, FILES); const comp = pick(r, COMPONENTS);
  const task = pick(r, FILLER_TASKS).replace("{file}", file).replace("{component}", comp);
  const n = 2 + Math.floor(r() * 3);
  const msgs: Msg[] = [{ role: "user", content: task[0].toUpperCase() + task.slice(1) + "." }];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: "assistant", content: i === n - 1
      ? `Done: ${task}. Touched ${file} and ${pick(r, FILES)}; bun test is green (${40 + Math.floor(r() * 80)} tests).`
      : pick(r, ASSISTANT_SHORT) });
    if (i < n - 1) msgs.push({ role: "user", content: pick(r, SMALLTALK) });
  }
  return { kind: "filler", msgs };
}

export function makeWorld(seed: number, idx: number): World {
  const r = rng(seed);
  const name = PROJECTS[idx % PROJECTS.length];
  const sessions: Session[] = [];
  const probes: Probe[] = [];
  const usedC = new Set<number>(), usedD = new Set<number>(), usedR = new Set<number>();
  const envIdx = shuffle(r, ENV.map((_, i) => i)).slice(0, 8);
  const envState = new Map<number, number>();
  const plan: string[] = [];
  for (let i = 0; i < 10; i++) plan.push("bug");
  for (let i = 0; i < 8; i++) plan.push("decide");
  for (let i = 0; i < 8; i++) plan.push("rule");
  for (let i = 0; i < 8; i++) plan.push("env");
  for (let i = 0; i < 5; i++) plan.push("update");
  for (let i = 0; i < 22; i++) plan.push("filler");
  const order = shuffle(r, plan);
  // env facts must be stated before updated: emit initial env sessions first in order encountered
  let envCursor = 0;
  for (const kind of order) {
    if (kind === "bug") { const { s, probes: p } = bugSession(r, sessions.length, usedC); sessions.push(s); probes.push(...p); }
    else if (kind === "decide") { const { s, probes: p } = decideSession(r, usedD); sessions.push(s); probes.push(...p); }
    else if (kind === "rule") { const { s, probes: p } = ruleSession(r, usedR); sessions.push(s); probes.push(...p); }
    else if (kind === "env") {
      if (envCursor >= envIdx.length) { sessions.push(fillerSession(r)); continue; }
      const ei = envIdx[envCursor++]; envState.set(ei, 0); sessions.push(envSession(r, ei, 0, null));
    } else if (kind === "update") {
      const stated = [...envState.keys()].filter((k) => envState.get(k)! < 2);
      if (!stated.length) { sessions.push(fillerSession(r)); continue; }
      const ei = pick(r, stated); const vi = envState.get(ei)! + 1; envState.set(ei, vi);
      sessions.push(envSession(r, ei, vi, (ENV[ei][2] as string[])[vi - 1]));
    } else sessions.push(fillerSession(r));
  }
  for (const [ei, vi] of envState) {
    const [thing, slot, vals, q] = ENV[ei] as [string, string, string[], string];
    const stale = vals.slice(0, vi);
    probes.push({ family: "env", form: "question", q: q + "?", gold: [vals[vi]], stale });
    probes.push({ family: "env", form: "task", q: pick(r, [`I need to point the new script at ${thing}`, `set up ${thing} in the new service`, `configure ${thing} for the worker`]), gold: [vals[vi]], stale });
  }
  // negative probes: env things never mentioned in this world
  const unseen = ENV.map((_, i) => i).filter((i) => !envState.has(i));
  for (const ei of unseen.slice(0, 4)) {
    const [, , , q] = ENV[ei] as [string, string, string[], string];
    const forbidden = [...envState].map(([k, vi]) => (ENV[k][2] as string[])[vi]);
    probes.push({ family: "env", form: "question", q: q + "?", gold: [], negative: true, forbidden });
  }
  return { name, seed, sessions, probes };
}

export function makeWorlds(n = 5, base = 20260912): World[] {
  return Array.from({ length: n }, (_, i) => makeWorld(base + i * 7919, i));
}
