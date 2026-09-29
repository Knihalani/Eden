/**
 * Real-use needed-miss on the Claude hook path (lower better).
 * Each trial: copy a store grown from long threads, observe more fat turns, then
 * UserPromptSubmit a kilobyte paste with the question last. Dump-all cannot score 0.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { memoryHookResponse } from "../../packages/cli/src/memory-hook";
import {
  LIVE_THREADS,
  PASTE_SENTENCES,
  SEED_THREADS,
  SHORT_N,
  TRAP_N,
  type Glue,
  fatPrompt,
  packetText,
  scorePacket,
  sessionTurns,
  shortJunk,
  toolLog,
  trapLine,
} from "./score";

type Need = {
  id: string;
  cue: string;
  gold: string[];
  stale?: string[];
  files?: string[];
  persist?: boolean;
  glue?: Glue;
  /** Fact observed mid-trial after live bloat — not in the pre-seed store. */
  liveGold?: string;
};

const NEED: Need[] = [
  { id: "login-broken", cue: "why is login broken?", gold: ["Clerk"] },
  { id: "burial-nonce", cue: "where is the nonce field kept?", gold: ["refresh_token"] },
  { id: "persist-nonce", cue: "where is the nonce field kept?", gold: ["refresh_token"], persist: true, glue: "para" },
  { id: "tool-sha", cue: "which sha did git log -1 print?", gold: ["c3f8a91b2e4d"] },
  {
    id: "tool-exit",
    cue: "what failed in the session suite?",
    gold: ["test_refresh_token", "NEEDLE_7f3a"],
  },
  { id: "overwrite-db", cue: "what database do we use?", gold: ["sqlite"], stale: ["postgres"] },
  { id: "overwrite-ci", cue: "what node version does ci use?", gold: ["Node 18"], stale: ["Node 16"] },
  {
    id: "two-hop",
    cue: "What country is the sport of Zane from?",
    gold: ["Canada"],
    stale: ["Scotland"],
  },
  { id: "commit-rule", cue: "commit these changes", gold: ["before committing"] },
  {
    id: "wrong-tab",
    cue: "where is the flake?",
    gold: ["auth.test.ts"],
    stale: ["billing.ts"],
    files: ["billing.ts"],
  },
  { id: "sso-bounce", cue: "SSO keeps bouncing me back to the splash", gold: ["Clerk"] },
  { id: "jwt-callback", cue: "got Invalid JWT on the callback", gold: ["Clerk"] },
  { id: "inbound-sigs", cue: "those inbound signatures are failing again", gold: ["Svix"], stale: ["Hookdeck"] },
  { id: "alias-flags", cue: "flags is stuck on the old checkout variant", gold: ["LaunchDarkly"], stale: ["GrowthBook"] },
  {
    id: "hop3-city",
    cue: "what city is the incident rotation primary based in?",
    gold: ["Lisbon"],
    stale: ["Porto"],
  },
  { id: "canary-digest", cue: "which digest did we roll the canary back to?", gold: ["sha256:9f3c1a7eb2d4"], stale: ["sha256:4ab80c11d9e7"] },
  { id: "idp-handler", cue: "IdP bounce is 500ing, where's that handler?", gold: ["apps/web/app/sso/callback/route.ts"] },
  {
    id: "hop3-region",
    cue: "which region owns the deploy?",
    gold: ["eu-central"],
    stale: ["us-east"],
  },
  { id: "drain-overwrite", cue: "what is the log drain?", gold: ["Better Stack"], stale: ["Axiom"] },
  {
    id: "hop4-continent",
    cue: "what continent is the author of Helix from?",
    gold: ["Africa"],
    stale: ["Europe"],
  },
  {
    id: "hop5-country",
    cue: "what country is the spouse of the author of Helix from?",
    gold: ["Kenya"],
    stale: ["France"],
  },
  { id: "notion-doc", cue: "the spec page never synced", gold: ["Notion"] },
  { id: "figma-file", cue: "the mock never exported", gold: ["Figma"] },
  { id: "loom-rec", cue: "the walkthrough never uploaded", gold: ["Loom"] },
  { id: "gha-pipeline", cue: "the pipeline yaml never ran", gold: ["GitHub Actions"] },
  { id: "vercel-alias", cue: "the production alias never propagated", gold: ["Vercel"] },
  { id: "grafana-board", cue: "the onboard dashboard is empty", gold: ["Grafana"] },
  { id: "linear-cycle", cue: "the cycle never closed", gold: ["Linear"] },
  { id: "clip-loom", cue: "the clip never rendered", gold: ["Loom"] },
  { id: "nightly-gha", cue: "the nightly never ran", gold: ["GitHub Actions"] },
  { id: "seat-workos", cue: "the seat never provisioned", gold: ["WorkOS"] },
  { id: "span-honey", cue: "the span never sampled", gold: ["Honeycomb"] },
  { id: "probe-prom", cue: "the probe never scraped", gold: ["Prometheus"] },
  { id: "gate-ld", cue: "the gate never flipped", gold: ["LaunchDarkly"] },
  { id: "ttl-cf", cue: "the ttl never expired", gold: ["Cloudflare"] },
  { id: "replica-ps", cue: "the replica never promoted", gold: ["PlanetScale"] },
  { id: "scan-ch", cue: "the scan never compacted", gold: ["ClickHouse"] },
  { id: "identity-auth0", cue: "the identity never linked", gold: ["Auth0"] },
  { id: "consumer-kafka", cue: "the consumer never caught up", gold: ["Kafka"] },
  { id: "shard-mongo", cue: "the shard never split", gold: ["MongoDB"] },
  { id: "bucket-r2", cue: "the bucket never listed", gold: ["R2"] },
  { id: "fixture-bun", cue: "the fixture never loaded", gold: ["Bun"] },
  { id: "card-stripe", cue: "the card never captured", gold: ["Stripe"] },
  { id: "trace-dd", cue: "the trace never sampled", gold: ["Datadog"] },
  { id: "queue-redis", cue: "the queue never popped", gold: ["Redis"] },
  { id: "lockfile-pnpm", cue: "the lockfile never resolved", gold: ["pnpm"] },
  { id: "region-fly", cue: "the region never booted", gold: ["Fly"] },
  { id: "slot-cal", cue: "the slot never booked", gold: ["Cal.com"] },
  { id: "visitor-intercom", cue: "the visitor never assigned", gold: ["Intercom"] },
  { id: "cluster-k8s", cue: "the cluster never scaled", gold: ["Kubernetes"] },
  { id: "runbook-pd", cue: "the runbook never paged", gold: ["PagerDuty"] },
  { id: "heatmap-fs", cue: "the heatmap never recorded", gold: ["FullStory"] },
  { id: "invoice-cb", cue: "the invoice never finalized", gold: ["Chargebee"] },
  { id: "board-sanity", cue: "the board never published", gold: ["Sanity"] },
  { id: "secret-inf", cue: "the vault never rotated", gold: ["Infisical"] },
  { id: "pixel-meta", cue: "the pixel never fired", gold: ["Meta"] },
  { id: "sandbox-e2b", cue: "the sandbox never provisioned", gold: ["E2B"] },
  { id: "badge-sp", cue: "the badge never flipped", gold: ["Statuspage"] },
  { id: "cell-hex", cue: "the cell never scheduled", gold: ["Hex"] },
  { id: "snippet-gist", cue: "the snippet never synced", gold: ["GitHub"] },
  { id: "warp-tunnel", cue: "the warp never connected", gold: ["Cloudflare"] },
  { id: "tarball-npm", cue: "the tarball never published", gold: ["npm"] },
  { id: "story-linear", cue: "the story never pointed", gold: ["Linear"] },
  { id: "locale-crowdin", cue: "the locale never translated", gold: ["Crowdin"] },
  { id: "mapper-prisma", cue: "the mapper never migrated", gold: ["Prisma"] },
  { id: "asset-vite", cue: "the asset never fingerprinted", gold: ["Vite"] },
  { id: "worker-inngest", cue: "the worker never queued", gold: ["Inngest"] },
  { id: "embedding-pinecone", cue: "the embedding never stored", gold: ["Pinecone"] },
  { id: "draft-ghost", cue: "the draft never published", gold: ["Ghost"] },
  { id: "prompt-helicone", cue: "the prompt never cached", gold: ["Helicone"] },
  { id: "bloom-meili", cue: "the bloom never queried", gold: ["Meilisearch"] },
  { id: "webhook-svix", cue: "the webhook never delivered", gold: ["Svix"], liveGold: "Endpoints are Svix." },
  { id: "cron-temporal", cue: "the cron never fired", gold: ["Temporal"], liveGold: "Schedules are Temporal." },
  { id: "caption-deepgram", cue: "the caption never generated", gold: ["Deepgram"], liveGold: "Subtitles are Deepgram." },
  { id: "lag-redpanda", cue: "the lag never drained", gold: ["Redpanda"], liveGold: "Brokers are Redpanda." },
  { id: "migration-atlas", cue: "the migration never applied", gold: ["Atlas"] },
  { id: "graph-neo4j", cue: "the graph never traversed", gold: ["Neo4j"] },
  { id: "throttle-kong", cue: "the throttle never applied", gold: ["Kong"] },
  { id: "watermark-flink", cue: "the watermark never advanced", gold: ["Flink"] },
  { id: "dlq-sqs", cue: "the dlq never replayed", gold: ["SQS"], liveGold: "Dead letters are SQS." },
  { id: "lease-etcd", cue: "the lease never renewed", gold: ["etcd"] },
  { id: "outbox-debezium", cue: "the outbox never drained", gold: ["Debezium"] },
  { id: "sidecar-istio", cue: "the sidecar never injected", gold: ["Istio"] },
];

const QUIET = [
  "what's 17 times 23?",
  "thanks",
  "lol",
  "continue",
  "lgtm",
  "ok go",
  "sounds good",
  "ship it",
  "got it",
  "nice",
  "cool",
  "will do",
];

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eden-use-"));
}

function withEnv<T>(dir: string, fn: () => T, extra: Record<string, string | undefined> = {}): T {
  const keys = [
    "EDEN_MEMORY_DIR",
    "EDEN_MEMORY",
    "EDEN_KNOW",
    "EDEN_HOME",
    "EDEN_MEMORY_X",
    "EDEN_MEMORY_MIN",
    "EDEN_MEMORY_CAP",
  ];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    process.env.EDEN_MEMORY_DIR = dir;
    process.env.EDEN_MEMORY = extra.EDEN_MEMORY ?? "on";
    process.env.EDEN_KNOW = "0";
    delete process.env.EDEN_HOME;
    delete process.env.EDEN_MEMORY_X;
    delete process.env.EDEN_MEMORY_MIN;
    delete process.env.EDEN_MEMORY_CAP;
    for (const [k, v] of Object.entries(extra)) {
      if (k === "EDEN_MEMORY") continue;
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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

function tool(name: string, result: string, input?: Record<string, unknown>): void {
  memoryHookResponse({
    hook_event_name: "PostToolUse",
    tool_name: name,
    ...(input ? { tool_input: input } : {}),
    tool_response: result,
  });
}

function liveBloat(dir: string, salt: number): void {
  withEnv(dir, () => {
    for (let i = 0; i < LIVE_THREADS; i++) rememberThread(salt + i);
    tool("Bash", toolLog("npm test leftover recap", salt), { command: "npm test -- --runInBand" });
    tool("Read", toolLog("file dump leftover recap", salt + 7));
    tool("Grep", toolLog("search leftover recap", salt + 11), { pattern: "catalog" });
    tool("Edit", toolLog("patch leftover recap", salt + 13), { file_path: "src/widget/catalog.ts" });
    tool("Write", toolLog("write leftover recap", salt + 17), { file_path: "tmp/catalog.md" });
    tool("WebFetch", toolLog("fetch leftover recap", salt + 19), { url: "https://example.invalid/catalog" });
  });
}

function seed(dir: string): void {
  withEnv(dir, () => {
    const half = Math.floor(SEED_THREADS / 2);
    for (let i = 0; i < half; i++) rememberThread(i);
    for (let i = 0; i < TRAP_N; i++) {
      memoryHookResponse({
        hook_event_name: "Stop",
        messages: [{ role: "user", content: trapLine(i) }],
      });
    }
    for (let i = 0; i < SHORT_N; i++) {
      memoryHookResponse({
        hook_event_name: "Stop",
        messages: [{ role: "user", content: shortJunk(i) }],
      });
    }

    rememberThread(100, "Auth is Clerk.");
    rememberThread(101, "The nonce field is refresh_token.");
    rememberThread(102, "The database is postgres.");
    rememberThread(103, "The database is sqlite.");
    rememberThread(104, "CI is Node 16.");
    rememberThread(105, "CI is Node 18.");
    rememberThread(106, "Lacrosse originated in Scotland.");
    rememberThread(107, "Lacrosse originated in Canada.");
    rememberThread(108, "Player Zane plays lacrosse.");
    rememberThread(109, "Always run tests before committing.");
    rememberThread(110, "The flake is in auth.test.ts.");
    rememberThread(111, "Hookdeck signs the CI deploy hooks.");
    rememberThread(112, "Svix verifies our inbound webhook signatures.");
    rememberThread(113, "experiments is our name for GrowthBook.");
    rememberThread(114, "flags is our name for LaunchDarkly.");
    rememberThread(115, "The support rota is named Otter.");
    rememberThread(116, "Otter's primary is Luis.");
    rememberThread(117, "Luis is based in Porto.");
    rememberThread(118, "The incident rotation is named Badger.");
    rememberThread(119, "Badger's primary is Priya.");
    rememberThread(120, "Priya is based in Lisbon.");
    rememberThread(121, "Canary was on sha256:4ab80c11d9e7 before the rollback.");
    rememberThread(122, "We rolled the canary back to sha256:9f3c1a7eb2d4.");
    rememberThread(123, "Magic-link handler lives at apps/web/app/magic/link/route.ts.");
    rememberThread(124, "IdP bounce handler lives at apps/web/app/sso/callback/route.ts.");
    rememberThread(125, "The owner of the deploy is Noor.");
    rememberThread(126, "The team of Noor is Edge.");
    rememberThread(127, "The region of Atlas is us-east.");
    rememberThread(128, "The region of Edge is eu-central.");
    rememberThread(129, "Axiom is the log drain.");
    rememberThread(130, "Better Stack is the log drain.");
    rememberThread(131, "Helix is by Mira.");
    rememberThread(132, "Mira's spouse is Ken.");
    rememberThread(133, "Jules is a citizen of France.");
    rememberThread(134, "Ken is a citizen of Kenya.");
    rememberThread(135, "France is in Europe.");
    rememberThread(136, "Kenya is in Africa.");
    rememberThread(137, "Specs live in Notion.");
    rememberThread(138, "Mocks live in Figma.");
    rememberThread(139, "Walkthroughs are Loom.");
    rememberThread(140, "CI pipelines are GitHub Actions.");
    rememberThread(141, "Production aliases are Vercel.");
    rememberThread(142, "Dashboards are Grafana.");
    rememberThread(143, "Cycles are Linear.");
    rememberThread(144, "Directory sync is WorkOS.");
    rememberThread(145, "Tracing is Honeycomb.");
    rememberThread(146, "Metrics are Prometheus.");
    rememberThread(147, "CDN is Cloudflare.");
    rememberThread(148, "The database branch is PlanetScale.");
    rememberThread(149, "Analytics warehouse is ClickHouse.");
    rememberThread(150, "Social login is Auth0.");
    rememberThread(151, "The billing topic is Kafka.");
    rememberThread(152, "Documents live in MongoDB.");
    rememberThread(153, "Object store is R2.");
    rememberThread(154, "Test runner is Bun.");
    rememberThread(155, "Payments are Stripe.");
    rememberThread(156, "APM is Datadog.");
    rememberThread(157, "Cache is Redis.");
    rememberThread(158, "Package manager is pnpm.");
    rememberThread(159, "Deploy is Fly.io.");
    rememberThread(160, "Booking is Cal.com.");
    rememberThread(161, "The inbox is Intercom.");
    rememberThread(162, "Orchestration is Kubernetes.");
    rememberThread(163, "Paging is PagerDuty.");
    rememberThread(164, "Session replay is FullStory.");
    rememberThread(165, "Invoicing is Chargebee.");
    rememberThread(166, "CMS is Sanity.");
    rememberThread(167, "Secrets are Infisical.");
    rememberThread(168, "Ads are Meta.");
    rememberThread(169, "Isolated runtimes are E2B.");
    rememberThread(170, "Status is Statuspage.");
    rememberThread(171, "Notebooks are Hex.");
    rememberThread(172, "Gists are GitHub.");
    rememberThread(173, "Tunnels are Cloudflare.");
    rememberThread(174, "Registry is npm.");
    rememberThread(175, "Issues are Linear.");
    rememberThread(176, "i18n is Crowdin.");
    rememberThread(177, "ORM is Prisma.");
    rememberThread(178, "Bundling is Vite.");
    rememberThread(179, "Jobs are Inngest.");
    rememberThread(180, "Vectors are Pinecone.");
    rememberThread(181, "Publishing is Ghost.");
    rememberThread(182, "Gateway is Helicone.");
    rememberThread(183, "Indexes are Meilisearch.");
    rememberThread(184, "Schema is Atlas.");
    rememberThread(185, "Edges are Neo4j.");
    rememberThread(186, "Quotas are Kong.");
    rememberThread(187, "Cursors are Flink.");
    rememberThread(188, "Locks are etcd.");
    rememberThread(189, "Relays are Debezium.");
    rememberThread(190, "Mesh is Istio.");

    tool("Bash", toolLog("c3f8a91b2e4d pin session nonce", 1), { command: "git log -1" });
    tool("Bash", toolLog("FAILED tests/test_session.py::test_refresh_token … NEEDLE_7f3a", 2));

    for (let i = half; i < SEED_THREADS; i++) rememberThread(i);
  });
}

function submit(dir: string, cue: string, files?: string[]): string {
  return withEnv(dir, () =>
    packetText(
      memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        prompt: cue,
        ...(files?.length ? { open_files: files } : {}),
      }),
    ),
  );
}

function submitPersist(dir: string, cue: string): string {
  const child = spawnSync(process.execPath, [import.meta.path, "--cue", cue], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      EDEN_MEMORY_DIR: dir,
      EDEN_MEMORY: "on",
      EDEN_KNOW: "0",
      EDEN_HOME: "",
      EDEN_MEMORY_X: "",
      EDEN_MEMORY_MIN: "",
      EDEN_MEMORY_CAP: "",
    },
    encoding: "utf8",
  });
  return child.stdout ?? "";
}

const cueAt = process.argv.indexOf("--cue");
if (cueAt >= 0) {
  const cue = process.argv[cueAt + 1] ?? "";
  const dir = process.env.EDEN_MEMORY_DIR || "";
  process.stdout.write(submit(dir, cue));
  process.exit(0);
}

function copySeed(src: string): string {
  const dir = tmp();
  cpSync(src, dir, { recursive: true });
  return dir;
}

function medianMs(dir: string, cue: string): number {
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    submit(dir, fatPrompt(cue, "tight"));
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[2]!;
}

const root = tmp();
try {
  seed(root);

  let miss = 0;
  let goldOnlyMiss = 0;
  const missed: string[] = [];
  const reasons: string[] = [];

  for (const c of NEED) {
    const dir = copySeed(root);
    try {
      liveBloat(dir, 800 + NEED.indexOf(c) * LIVE_THREADS);
      if (c.liveGold) {
        withEnv(dir, () => rememberThread(12_000 + NEED.indexOf(c), c.liveGold));
        liveBloat(dir, 4_000 + NEED.indexOf(c) * LIVE_THREADS);
      }
      const cue = fatPrompt(c.cue, c.glue ?? "tight");
      const blob = c.persist ? submitPersist(dir, cue) : submit(dir, cue, c.files);
      const s = scorePacket(blob, c.gold, c.stale ?? []);
      if (!s.goldOnly) goldOnlyMiss++;
      if (!s.hit) {
        miss++;
        missed.push(c.id);
        reasons.push(`${c.id}:${s.reason}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  let leak = 0;
  const leaked: string[] = [];
  for (const cue of QUIET) {
    const dir = copySeed(root);
    try {
      liveBloat(dir, 2000 + leaked.length * LIVE_THREADS);
      const blob = submit(dir, fatPrompt(cue, "para"));
      if (blob.includes("Eden Memory:") || /Clerk|sqlite|qx\d+z/i.test(blob)) {
        leak++;
        leaked.push(cue.slice(0, 24));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const timed = copySeed(root);
  let ms = 0;
  try {
    liveBloat(timed, 3000);
    ms = medianMs(timed, "why is login broken?");
  } finally {
    rmSync(timed, { recursive: true, force: true });
  }

  console.log(`metric: ${miss}`);
  console.log(`leak: ${leak}`);
  console.log(`ms: ${ms.toFixed(3)}`);
  console.log(`gold_only_miss: ${goldOnlyMiss}`);
  console.log(`need_n: ${NEED.length}`);
  console.log(`seed_threads: ${SEED_THREADS}`);
  console.log(`live_threads: ${LIVE_THREADS}`);
  console.log(`paste_sentences: ${PASTE_SENTENCES}`);
  console.log(`missed: ${missed.join(",") || "-"}`);
  console.log(`why: ${reasons.join(",") || "-"}`);
  console.log(`leaked: ${leaked.join(",") || "-"}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
