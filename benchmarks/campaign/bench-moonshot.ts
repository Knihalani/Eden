/**
 * Moonshot campaign: github-pr / tenant / inventory + unique-work, plus
 * terraform / flags / dns-tls / map-reduce on the long path.
 *
 * Gated like bench-holdout.ts (Session + runScenario + summarize). Worlds
 * are disjoint from desk/orders/etl/incident/research/thrash/crm/calendar/
 * payments/cart — see MOONSHOT.md.
 *
 * Pre-registered expects (do not retune after seeing numbers):
 *   short-github / short-tenant               WIN on turns (program already live)
 *   moonshot-unique                           parity ±1% (no LOSS)
 *   long-terraform / long-flags / long-dns    WIN on turns
 *   inventory-loop / map-reduce-loop          WIN on turns; goLive failure is
 *                                             FAIL, not a silent skip-as-win
 *
 * Run: bun run benchmarks/campaign/bench-moonshot.ts [--fast] [--short]
 * `--short` = already-live github + tenant + unique-work only.
 */
import { Session, type WorldFactory } from "./session";
import { summarize, runScenario, FAST, type ScenarioOut, type ArmRun } from "./gates";
import { blockSeed } from "./worlds";
import {
  FLAG_IDS,
  JOB_IDS,
  NOISE_IDS,
  PR_IDS,
  STACK_IDS,
  TENANT_ORGS,
  WAVE_IDS,
  ZONE_IDS,
  createDnsTls,
  createFlags,
  createGithubPr,
  createInventory,
  createMapReduce,
  createMoonshotNoise,
  createTenant,
  createTerraform,
} from "./moonshot-worlds";

const SHORT = process.argv.includes("--short");
process.env.CAMPAIGN_THINK_MS = process.env.CAMPAIGN_THINK_MS ?? (FAST ? "1" : "120");

function githubPool(): Array<Record<string, unknown>> {
  return [...PR_IDS].map((pr) => ({ pr }));
}
function tenantPool(): Array<Record<string, unknown>> {
  return TENANT_ORGS.map((t) => ({ orgId: t.orgId, plan: t.plan }));
}
function inventoryPool(): Array<Record<string, unknown>> {
  return [...WAVE_IDS].map((wave) => ({ wave }));
}
function terraformPool(): Array<Record<string, unknown>> {
  return [...STACK_IDS].map((stack) => ({ stack }));
}
function flagsPool(): Array<Record<string, unknown>> {
  return [...FLAG_IDS].map((flag) => ({ flag }));
}
function dnsPool(): Array<Record<string, unknown>> {
  return [...ZONE_IDS].map((zone) => ({ zone }));
}
function mapReducePool(): Array<Record<string, unknown>> {
  return [...JOB_IDS].map((job) => ({ job }));
}
function noisePool(): Array<Record<string, unknown>> {
  return [...NOISE_IDS].map((id) => ({ id }));
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
  if (r.program == null) notes.push(`prelive did NOT go live (${r.verdict}): ${r.reasons.join("; ") || "no candidate"}`);
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
  if (!pre.program) stats.violations = [...stats.violations, ...pre.notes, "short cell with no live program — not a skip-as-win"];
  return { stats, notes: pre.notes };
}

async function main() {
  console.log(`Moonshot campaign — fast=${FAST} short=${SHORT} thinkMs=${process.env.CAMPAIGN_THINK_MS}`);
  const outs: ScenarioOut[] = [];
  const nWitness = 13;
  const nLive = FAST ? 3 : 6;
  const winRepeats = FAST ? 6 : 7;
  const uniqueRepeats = FAST ? 6 : 8;
  const shortRepeats = FAST || SHORT ? 2 : 3;

  {
    const github = githubPool();
    const tenant = tenantPool();
    console.log("\n[short-github] already-live GitHub review (object-loop + linear cap)");
    const ghPre = await prelive(createGithubPr, github);
    outs.push(
      await runScenario({
        name: "short-github",
        question: "single-stretch github-pr agent, compiled foreach already live",
        expect: "WIN on turns",
        tasks: ["t0", "t1", "t2", "t3"],
        repeats: shortRepeats,
        run: (arm, task, repeat) => shortLiveRun("github-pr", createGithubPr, github, ghPre, arm, task, repeat),
      }),
    );
    console.log("\n[short-tenant] already-live two-key tenant provision");
    const tenPre = await prelive(createTenant, tenant);
    outs.push(
      await runScenario({
        name: "short-tenant",
        question: "single-stretch tenant agent, compiled tool already live",
        expect: "WIN on turns",
        tasks: ["t0", "t1", "t2", "t3"],
        repeats: shortRepeats,
        run: (arm, task, repeat) => shortLiveRun("tenant", createTenant, tenant, tenPre, arm, task, repeat),
      }),
    );
  }

  if (SHORT) {
    console.log("\n[moonshot-unique] shuffled tool sequences, nothing repeats");
    const pool = noisePool();
    const run = async (arm: "raw" | "eden"): Promise<ArmRun> => {
      const s = new Session([["moonshot-noise", createMoonshotNoise]], arm === "eden");
      for (let i = 0; i < 5; i++) await s.stretch("moonshot-noise", pool[i % pool.length]!, blockSeed(`mu-${i}`, i));
      return { stats: s.finish(), notes: [] };
    };
    outs.push(
      await runScenario({
        name: "moonshot-unique",
        question: "every stretch has a different tool sequence on moonshot-noise",
        expect: "parity ±1% (no LOSS)",
        tasks: ["u"],
        repeats: uniqueRepeats,
        run: (arm) => run(arm),
      }),
    );
    summarize(outs, { lossTolerancePct: 1 });
    return;
  }

  const longDefs: Array<{
    key: string;
    label: string;
    world: [string, WorldFactory];
    pool: Array<Record<string, unknown>>;
  }> = [
    { key: "long-terraform", label: "plan-then-apply, showPlan then applyChange foreach", world: ["terraform", createTerraform], pool: terraformPool() },
    { key: "long-flags", label: "two-field cohort rollout, setRollout then publishFlag", world: ["flags", createFlags], pool: flagsPool() },
    { key: "long-dns", label: "cert-then-listener, createCert foreach then checkHttps", world: ["dns-tls", createDnsTls], pool: dnsPool() },
  ];

  for (let si = 0; si < longDefs.length; si++) {
    const d = longDefs[si]!;
    const expect = "WIN on turns";
    console.log(`\n[${si + 1}/5] ${d.key} — ${d.label}`);
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

  console.log("\n[4/5] moonshot-unique — shuffled tool sequences, nothing repeats");
  {
    const pool = noisePool();
    const expect = "parity ±1% (no LOSS)";
    console.log(`  expect: ${expect}`);
    const run = async (arm: "raw" | "eden"): Promise<ArmRun> => {
      const s = new Session([["moonshot-noise", createMoonshotNoise]], arm === "eden");
      for (let i = 0; i < 5; i++) await s.stretch("moonshot-noise", pool[i % pool.length]!, blockSeed(`mu-${i}`, i));
      return { stats: s.finish(), notes: [] };
    };
    outs.push(
      await runScenario({
        name: "moonshot-unique",
        question: "every stretch has a different tool sequence on moonshot-noise",
        expect,
        tasks: ["u"],
        repeats: uniqueRepeats,
        run: (arm) => run(arm),
      }),
    );
  }

  console.log("\n[5/5] inventory-loop + map-reduce-loop");
  {
    const expect = "WIN on turns once compiler binds object arrays; goLive failure is FAIL not skip";
    console.log(`  expect: ${expect}`);
    outs.push(
      await runScenario({
        name: "inventory-loop",
        question: `long session on createInventory (width ${3}): listBins → restockLine ×3 → createShipment`,
        expect,
        tasks: ["s0"],
        repeats: winRepeats,
        run: (arm, _task, repeat) =>
          lifecycleRun("inventory", createInventory, inventoryPool(), {
            nWitness,
            nLive,
            arm,
            seedPrefix: `inv-${repeat}`,
            requireLive: true,
          }),
      }),
    );
    outs.push(
      await runScenario({
        name: "map-reduce-loop",
        question: "long session on createMapReduce: listChunks → mapChunk foreach → mergeReport",
        expect,
        tasks: ["s0"],
        repeats: winRepeats,
        run: (arm, _task, repeat) =>
          lifecycleRun("map-reduce", createMapReduce, mapReducePool(), {
            nWitness,
            nLive,
            arm,
            seedPrefix: `mr-${repeat}`,
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
