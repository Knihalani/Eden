/**
 * Horizon campaign: graphql-relay / sso + unique-work, plus sql / blob /
 * inbox / webhook on the long path, and topk / saga / poll when they compile.
 *
 * Gated like bench-moonshot.ts (Session + runScenario + summarize). Worlds
 * are disjoint from desk/orders/etl/incident/research/thrash/crm/calendar/
 * payments/cart/github-pr/terraform/flags/dns/inventory/tenant/map-reduce —
 * see HORIZON.md.
 *
 * Pre-registered expects (do not retune after seeing numbers):
 *   short-graphql / short-sso                 WIN on turns (program already live)
 *   horizon-unique                            parity ±1% (no LOSS)
 *   long-sql / long-blob / long-inbox / long-webhook
 *                                             WIN on turns
 *   topk / saga / poll                        WIN on turns if they compile;
 *                                             goLive failure is FAIL, not skip-as-win
 *
 * Run: bun run benchmarks/campaign/bench-horizon.ts [--fast] [--short]
 * `--short` = already-live graphql + sso + unique-work only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Session, type WorldFactory } from "./session";
import { summarize, runScenario, FAST, type ScenarioOut, type ArmRun } from "./gates";
import { blockSeed } from "./worlds";
import {
  BLOB_IDS,
  DEPLOY_IDS,
  HOLD_IDS,
  HOOK_IDS,
  NOISE_IDS,
  QUERY_IDS,
  REPO_IDS,
  REPORT_IDS,
  SSO_ORGS,
  THREAD_IDS,
  createBlobPipeline,
  createGraphqlRelay,
  createHorizonNoise,
  createInboxTriage,
  createK8sRollout,
  createSagaHold,
  createSearchRank,
  createSqlReport,
  createSsoProvision,
  createWebhookFanout,
} from "./horizon-worlds";

const SHORT = process.argv.includes("--short");
process.env.CAMPAIGN_THINK_MS = process.env.CAMPAIGN_THINK_MS ?? (FAST ? "1" : "120");

const capture: string[] = [];
const origLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  origLog(...args);
  capture.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
};

function graphqlPool(): Array<Record<string, unknown>> {
  return [...REPO_IDS].map((repo) => ({ repo }));
}
function ssoPool(): Array<Record<string, unknown>> {
  return SSO_ORGS.map((t) => ({ orgId: t.orgId, email: t.email }));
}
function sqlPool(): Array<Record<string, unknown>> {
  return [...REPORT_IDS].map((report) => ({ report }));
}
function blobPool(): Array<Record<string, unknown>> {
  return [...BLOB_IDS].map((blob) => ({ blob }));
}
function inboxPool(): Array<Record<string, unknown>> {
  return [...THREAD_IDS].map((thread) => ({ thread }));
}
function webhookPool(): Array<Record<string, unknown>> {
  return [...HOOK_IDS].map((hook) => ({ hook }));
}
function searchPool(): Array<Record<string, unknown>> {
  return [...QUERY_IDS].map((q) => ({ q }));
}
function sagaPool(): Array<Record<string, unknown>> {
  return [...HOLD_IDS].map((holdId) => ({ holdId }));
}
function k8sPool(): Array<Record<string, unknown>> {
  return [...DEPLOY_IDS].map((deploy) => ({ deploy }));
}
function noisePool(): Array<Record<string, unknown>> {
  return [...NOISE_IDS].map((id) => ({ id }));
}

function writeShortCapture(): void {
  const dir = join(import.meta.dir, "../../.gauntlet/captures/compile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bench-horizon-short.txt"), capture.join("\n") + "\n");
}

/**
 * Record nWitness, go-live, then nLive. goLive notes always print.
 * When requireLive, a missing program is a correctness violation — never a
 * skip quoted as WIN.
 */
async function lifecycleRun(
  worldName: string,
  factory: WorldFactory,
  pool: Array<Record<string, unknown>>,
  opts: {
    nWitness: number;
    nLive: number;
    arm: "raw" | "eden";
    seedPrefix: string;
    requireLive?: boolean;
  },
): Promise<ArmRun> {
  const s = new Session([[worldName, factory]], opts.arm === "eden");
  const pick = (i: number) => pool[i % pool.length]!;
  for (let i = 0; i < opts.nWitness; i++) {
    await s.stretch(worldName, pick(i), blockSeed(`${opts.seedPrefix}-w${i}`, i));
  }
  const notes: string[] = [];
  let liveFailed: string | null = null;
  if (opts.arm === "eden") {
    const r = await s.goLive(worldName, { compile: opts.nWitness - 3, holdout: 3, sandbox: factory, maxGram: 26 });
    if (r.program == null) {
      const msg = `goLive ${r.verdict}: ${r.reasons.join("; ") || "no candidate"}`;
      notes.push(msg);
      if (opts.requireLive) liveFailed = `${msg} — not a skip-as-win`;
    } else {
      notes.push(`goLive PASS: ${r.program.sequence.join("→")}`);
    }
  }
  for (let i = 0; i < opts.nLive; i++) {
    await s.stretch(worldName, pick(i), blockSeed(`${opts.seedPrefix}-l${i}`, 100 + i));
  }
  const stats = s.finish();
  if (liveFailed) stats.violations = [...stats.violations, liveFailed];
  return { stats, notes };
}

/** Compile once so measured cells start with the program already live. */
async function prelive(
  factory: WorldFactory,
  pool: Array<Record<string, unknown>>,
  count = 8,
): Promise<{ program: Awaited<ReturnType<Session["goLive"]>>["program"]; notes: string[] }> {
  const s = new Session([["w", factory]], true);
  const notes: string[] = [];
  for (let i = 0; i < count; i++) {
    const g = pool[i % pool.length]!;
    await s.stretch("w", g, blockSeed(`prelive-${i}-${JSON.stringify(g)}`, i));
  }
  const r = await s.goLive("w", { compile: Math.max(3, count - 3), holdout: 3, sandbox: factory, maxGram: 26 });
  if (r.program == null)
    notes.push(`prelive did NOT go live (${r.verdict}): ${r.reasons.join("; ") || "no candidate"}`);
  else notes.push(`prelive PASS: ${r.program.sequence.join("→")}`);
  return { program: r.program, notes };
}

async function shortLiveRun(
  worldName: string,
  factory: WorldFactory,
  pool: Array<Record<string, unknown>>,
  pre: { program: Awaited<ReturnType<Session["goLive"]>>["program"]; notes: string[] },
  arm: "raw" | "eden",
  task: string,
  repeat: number,
): Promise<ArmRun> {
  const goal = pool[Number(task.replace(/\D/g, "") || 0) % pool.length]!;
  if (arm === "raw") {
    const s = new Session([[worldName, factory]]);
    await s.stretch(worldName, goal, blockSeed(`short-${worldName}-${task}`, repeat));
    return { stats: s.finish(), notes: [] };
  }
  const s = new Session([[worldName, factory]], true);
  s.addPrograms(pre.program ? [pre.program] : []);
  await s.stretch(worldName, goal, blockSeed(`short-${worldName}-${task}`, repeat));
  const stats = s.finish();
  if (!pre.program)
    stats.violations = [...stats.violations, ...pre.notes, "short cell with no live program — not a skip-as-win"];
  return { stats, notes: pre.notes };
}

async function uniqueRun(arm: "raw" | "eden"): Promise<ArmRun> {
  const pool = noisePool();
  const s = new Session([["horizon-noise", createHorizonNoise]], arm === "eden");
  for (let i = 0; i < 5; i++) await s.stretch("horizon-noise", pool[i % pool.length]!, blockSeed(`hu-${i}`, i));
  return { stats: s.finish(), notes: [] };
}

async function main() {
  console.log(`Horizon campaign — fast=${FAST} short=${SHORT} thinkMs=${process.env.CAMPAIGN_THINK_MS}`);
  const outs: ScenarioOut[] = [];
  const nWitness = 13;
  const nLive = FAST ? 3 : 6;
  const winRepeats = FAST ? 6 : 7;
  const uniqueRepeats = FAST ? 6 : 8;
  const shortRepeats = FAST || SHORT ? 2 : 3;

  {
    const graphql = graphqlPool();
    const sso = ssoPool();
    console.log("\n[short-graphql] already-live GraphQL Relay (nested node loop + linear cap)");
    const gqlPre = await prelive(createGraphqlRelay, graphql);
    outs.push(
      await runScenario({
        name: "short-graphql",
        question: "single-stretch graphql-relay agent, compiled foreach already live",
        expect: "WIN on turns",
        tasks: ["t0", "t1", "t2", "t3"],
        repeats: shortRepeats,
        run: (arm, task, repeat) =>
          shortLiveRun("graphql-relay", createGraphqlRelay, graphql, gqlPre, arm, task, repeat),
      }),
    );
    console.log("\n[short-sso] already-live two-key SSO provision (nested body)");
    const ssoPre = await prelive(createSsoProvision, sso);
    outs.push(
      await runScenario({
        name: "short-sso",
        question: "single-stretch sso agent, compiled tool already live",
        expect: "WIN on turns",
        tasks: ["t0", "t1", "t2", "t3"],
        repeats: shortRepeats,
        run: (arm, task, repeat) => shortLiveRun("sso", createSsoProvision, sso, ssoPre, arm, task, repeat),
      }),
    );
  }

  if (SHORT) {
    console.log("\n[horizon-unique] shuffled tool sequences, nothing repeats");
    outs.push(
      await runScenario({
        name: "horizon-unique",
        question: "every stretch has a different tool sequence on horizon-noise",
        expect: "parity ±1% (no LOSS)",
        tasks: ["u"],
        repeats: uniqueRepeats,
        run: (arm) => uniqueRun(arm),
      }),
    );
    summarize(outs, { lossTolerancePct: 1 });
    writeShortCapture();
    return;
  }

  const longDefs: Array<{
    key: string;
    label: string;
    world: [string, WorldFactory];
    pool: Array<Record<string, unknown>>;
  }> = [
    {
      key: "long-sql",
      label: "SQL string template then fetch/write/mail",
      world: ["sql-report", createSqlReport],
      pool: sqlPool(),
    },
    {
      key: "long-blob",
      label: "fetchBlob → hashObject → putObject → notifyStore",
      world: ["blob-pipeline", createBlobPipeline],
      pool: blobPool(),
    },
    {
      key: "long-inbox",
      label: "fetchThread → draftReply island → archive → ack",
      world: ["inbox-triage", createInboxTriage],
      pool: inboxPool(),
    },
    {
      key: "long-webhook",
      label: "three distinct writes, not a foreach",
      world: ["webhook-fanout", createWebhookFanout],
      pool: webhookPool(),
    },
  ];

  for (let si = 0; si < longDefs.length; si++) {
    const d = longDefs[si]!;
    const expect = "WIN on turns";
    console.log(`\n[${si + 1}/7] ${d.key} — ${d.label}`);
    console.log(`  expect: ${expect}`);
    outs.push(
      await runScenario({
        name: d.key,
        question: `long session: record ${nWitness}, go live, then ${nLive} more (${d.label})`,
        expect,
        tasks: ["s0"],
        repeats: winRepeats,
        run: (arm, _task, repeat) =>
          lifecycleRun(d.world[0], d.world[1], d.pool, {
            nWitness,
            nLive,
            arm,
            seedPrefix: `${d.key}-${repeat}`,
            requireLive: true,
          }),
      }),
    );
  }

  console.log("\n[5/7] horizon-unique — shuffled tool sequences, nothing repeats");
  {
    const expect = "parity ±1% (no LOSS)";
    console.log(`  expect: ${expect}`);
    outs.push(
      await runScenario({
        name: "horizon-unique",
        question: "every stretch has a different tool sequence on horizon-noise",
        expect,
        tasks: ["u"],
        repeats: uniqueRepeats,
        run: (arm) => uniqueRun(arm),
      }),
    );
  }

  console.log("\n[6/7] topk / saga / poll — WIN on turns if they compile; goLive failure is FAIL not skip");
  {
    const expect = "WIN on turns once compiler binds prefix/fork/poll; goLive failure is FAIL not skip";
    console.log(`  expect: ${expect}`);
    outs.push(
      await runScenario({
        name: "search-topk",
        question: "long session on createSearchRank: searchHits (10) → takeHit first 3 → writeDigest",
        expect,
        tasks: ["s0"],
        repeats: winRepeats,
        run: (arm, _task, repeat) =>
          lifecycleRun("search-rank", createSearchRank, searchPool(), {
            nWitness,
            nLive,
            arm,
            seedPrefix: `topk-${repeat}`,
            requireLive: true,
          }),
      }),
    );
    outs.push(
      await runScenario({
        name: "saga-hold",
        question: "long session on createSagaHold: getHold then capture/cancel + notifyLedger",
        expect,
        tasks: ["s0"],
        repeats: winRepeats,
        run: (arm, _task, repeat) =>
          lifecycleRun("saga-hold", createSagaHold, sagaPool(), {
            nWitness,
            nLive,
            arm,
            seedPrefix: `saga-${repeat}`,
            requireLive: true,
          }),
      }),
    );
    outs.push(
      await runScenario({
        name: "k8s-poll",
        question: "long session on createK8sRollout: getRollout ×3 same args then verifyRollout",
        expect,
        tasks: ["s0"],
        repeats: winRepeats,
        run: (arm, _task, repeat) =>
          lifecycleRun("k8s-rollout", createK8sRollout, k8sPool(), {
            nWitness,
            nLive,
            arm,
            seedPrefix: `k8s-${repeat}`,
            requireLive: true,
          }),
      }),
    );
  }

  summarize(outs, { lossTolerancePct: 1 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
