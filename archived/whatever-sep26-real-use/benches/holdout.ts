/**
 * Holdout needed-miss. Same live-session bloat + tight paste as primary; different entities.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../../packages/cli/src/memory-hook";
import {
  LIVE_THREADS,
  SEED_THREADS,
  SHORT_N,
  TRAP_N,
  fatPrompt,
  packetText,
  scorePacket,
  sessionTurns,
  shortJunk,
  toolLog,
  trapLine,
} from "./score";

type Case = { id: string; cue: string; gold: string[]; stale?: string[] };

const CASES: Case[] = [
  { id: "stripe-402", cue: "checkout returns 402", gold: ["Stripe"] },
  { id: "redis-slow", cue: "session store is slow", gold: ["Redis"] },
  { id: "pnpm-hang", cue: "install is hanging on the lockfile", gold: ["pnpm"] },
  { id: "fly-prod", cue: "prod is down in iad", gold: ["Fly"] },
  { id: "overwrite-email", cue: "what sends welcome mail?", gold: ["Resend"], stale: ["Sendgrid"] },
  { id: "neon-timeout", cue: "connection timed out on the dashboard query", gold: ["Neon"] },
  { id: "r2-upload", cue: "upload avatar fails", gold: ["R2"] },
  { id: "statsig-assign", cue: "the experiment is not assigning users", gold: ["Statsig"] },
  { id: "datadog-apm", cue: "apm traces are missing in us1", gold: ["Datadog"] },
  { id: "kafka-lag", cue: "consumer lag on the billing topic", gold: ["Kafka"] },
  { id: "planetscale-branch", cue: "the database branch never promoted", gold: ["PlanetScale"] },
  { id: "clickhouse-slow", cue: "the analytics query is scanning too much", gold: ["ClickHouse"] },
  { id: "amplitude-event", cue: "the event never landed", gold: ["Amplitude"] },
  { id: "snowflake-wh", cue: "the warehouse query timed out", gold: ["Snowflake"] },
  { id: "auth0-social", cue: "the social login never linked", gold: ["Auth0"] },
  { id: "mongo-doc", cue: "the document never indexed", gold: ["MongoDB"] },
  { id: "fastly-shield", cue: "the shield never purged", gold: ["Fastly"] },
  { id: "bq-sched", cue: "the scheduled query never finished", gold: ["BigQuery"] },
  { id: "cio-drip", cue: "the drip never sent", gold: ["Customer.io"] },
  { id: "typeform-survey", cue: "the survey never submitted", gold: ["Typeform"] },
  { id: "mixpanel-cohort", cue: "the cohort never populated", gold: ["Mixpanel"] },
  { id: "sentry-dsn", cue: "the dsn never verified", gold: ["Sentry"] },
  { id: "secret-infisical", cue: "the secret never rotated", gold: ["Infisical"] },
  { id: "image-depot", cue: "the image never built", gold: ["Depot"] },
  { id: "cert-le", cue: "the cert never renewed", gold: ["Let's Encrypt"] },
  { id: "search-algolia", cue: "the index never ranked", gold: ["Algolia"] },
  { id: "replay-fs", cue: "the tape never replayed", gold: ["FullStory"] },
  { id: "graphite-stack", cue: "the stack never reviewed", gold: ["Graphite"] },
  { id: "baseten-model", cue: "the model never served", gold: ["Baseten"] },
  { id: "airtable-formula", cue: "the formula never computed", gold: ["Airtable"] },
  { id: "figjam-canvas", cue: "the canvas never exported", gold: ["FigJam"] },
  { id: "theme-shopify", cue: "the storefront never compiled", gold: ["Shopify"] },
  { id: "transcript-aai", cue: "the diarization never finished", gold: ["AssemblyAI"] },
  { id: "webhook-hookdeck", cue: "the webhook never signed", gold: ["Hookdeck"] },
  { id: "cron-render", cue: "the cron never scheduled", gold: ["Render"] },
  { id: "caption-rev", cue: "the caption never aligned", gold: ["Rev"] },
  { id: "graph-neptune", cue: "the graph never queried", gold: ["Neptune"] },
  { id: "throttle-envoy", cue: "the throttle never enforced", gold: ["Envoy"] },
  { id: "watermark-spark", cue: "the watermark never committed", gold: ["Spark"] },
  { id: "dlq-pubsub", cue: "the dlq never flushed", gold: ["Pub/Sub"] },
  { id: "lease-zk", cue: "the lease never expired", gold: ["ZooKeeper"] },
  { id: "sidecar-linkerd", cue: "the sidecar never warmed", gold: ["Linkerd"] },
];

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eden-hold-"));
}

function withEnv<T>(dir: string, fn: () => T): T {
  const keys = ["EDEN_MEMORY_DIR", "EDEN_MEMORY", "EDEN_KNOW", "EDEN_HOME", "EDEN_MEMORY_X", "EDEN_MEMORY_MIN", "EDEN_MEMORY_CAP"];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    process.env.EDEN_MEMORY_DIR = dir;
    process.env.EDEN_MEMORY = "on";
    process.env.EDEN_KNOW = "0";
    delete process.env.EDEN_HOME;
    delete process.env.EDEN_MEMORY_X;
    delete process.env.EDEN_MEMORY_MIN;
    delete process.env.EDEN_MEMORY_CAP;
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function rememberThread(salt: number, buried?: string): void {
  memoryHookResponse({
    hook_event_name: "Stop",
    messages: sessionTurns(salt, buried),
  });
}

function liveBloat(dir: string, salt: number): void {
  withEnv(dir, () => {
    for (let i = 0; i < LIVE_THREADS; i++) rememberThread(salt + i);
    memoryHookResponse({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: toolLog("holdout leftover recap", salt),
    });
    memoryHookResponse({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_response: toolLog("holdout file dump leftover recap", salt + 3),
    });
    memoryHookResponse({
      hook_event_name: "PostToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "catalog" },
      tool_response: toolLog("holdout search leftover recap", salt + 5),
    });
  });
}

function seed(dir: string): void {
  withEnv(dir, () => {
    const half = Math.floor(SEED_THREADS / 2);
    for (let i = 0; i < half; i++) rememberThread(500 + i);
    for (let i = 0; i < TRAP_N; i++) {
      memoryHookResponse({ hook_event_name: "Stop", messages: [{ role: "user", content: trapLine(i) }] });
    }
    for (let i = 0; i < SHORT_N; i++) {
      memoryHookResponse({ hook_event_name: "Stop", messages: [{ role: "user", content: shortJunk(i) }] });
    }
    rememberThread(600, "Payments are Stripe.");
    rememberThread(601, "Cache is Redis.");
    rememberThread(602, "Package manager is pnpm.");
    rememberThread(603, "Deploy is Fly.io.");
    rememberThread(604, "Email is Sendgrid.");
    rememberThread(605, "Email is Resend.");
    rememberThread(606, "The database is Neon.");
    rememberThread(607, "Object store is R2.");
    rememberThread(608, "Feature flags are Statsig.");
    rememberThread(609, "APM is Datadog.");
    rememberThread(610, "The billing topic is Kafka.");
    rememberThread(611, "The database branch is PlanetScale.");
    rememberThread(612, "Analytics warehouse is ClickHouse.");
    rememberThread(613, "Events are Amplitude.");
    rememberThread(614, "Warehouse is Snowflake.");
    rememberThread(615, "Social login is Auth0.");
    rememberThread(616, "Documents live in MongoDB.");
    rememberThread(617, "Shield is Fastly.");
    rememberThread(618, "Scheduled queries are BigQuery.");
    rememberThread(619, "Drips are Customer.io.");
    rememberThread(620, "Surveys are Typeform.");
    rememberThread(621, "Cohorts live in Mixpanel.");
    rememberThread(622, "Error tracking is Sentry.");
    rememberThread(623, "Secrets are Infisical.");
    rememberThread(624, "Image builds are Depot.");
    rememberThread(625, "Certificates are Let's Encrypt.");
    rememberThread(626, "Search is Algolia.");
    rememberThread(627, "Session replay is FullStory.");
    rememberThread(628, "Review is Graphite.");
    rememberThread(629, "Serving is Baseten.");
    rememberThread(630, "Spreadsheets are Airtable.");
    rememberThread(631, "Whiteboards are FigJam.");
    rememberThread(632, "Themes are Shopify.");
    rememberThread(633, "Transcription is AssemblyAI.");
    rememberThread(634, "Signing is Hookdeck.");
    rememberThread(635, "Timers are Render.");
    rememberThread(636, "Captions are Rev.");
    rememberThread(637, "Vertices are Neptune.");
    rememberThread(638, "Limits are Envoy.");
    rememberThread(639, "Offsets are Spark.");
    rememberThread(640, "Dead letters are Pub/Sub.");
    rememberThread(641, "Locks are ZooKeeper.");
    rememberThread(642, "Mesh is Linkerd.");
    for (let i = half; i < SEED_THREADS; i++) rememberThread(500 + i);
  });
}

function submit(dir: string, cue: string): string {
  return withEnv(dir, () =>
    packetText(memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: fatPrompt(cue, "tight") })),
  );
}

const root = tmp();
try {
  seed(root);
  let miss = 0;
  const missed: string[] = [];
  for (const c of CASES) {
    const dir = tmp();
    try {
      cpSync(root, dir, { recursive: true });
      liveBloat(dir, 900 + CASES.indexOf(c) * LIVE_THREADS);
      const s = scorePacket(submit(dir, c.cue), c.gold, c.stale ?? []);
      if (!s.hit) {
        miss++;
        missed.push(`${c.id}:${s.reason}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`holdout: ${miss}`);
  console.log(`holdout_n: ${CASES.length}`);
  console.log(`seed_threads: ${SEED_THREADS}`);
  console.log(`live_threads: ${LIVE_THREADS}`);
  console.log(`missed: ${missed.join(",") || "-"}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
