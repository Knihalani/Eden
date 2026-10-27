/**
 * Helix campaign: launch-pad (12-step sequential) + unique-work, plus offset /
 * retry / tree / unique / sort / reduce / barcode on the long path.
 *
 * Worlds are disjoint from desk / holdout / moonshot / horizon / apex — see HELIX.md.
 *
 * Pre-registered expects (do not retune after seeing numbers):
 *   short-launch                              WIN on turns (program already live) — ≥10×
 *   helix-unique                              parity ±1% (no LOSS)
 *   long-offset / long-retry / long-tree /
 *   long-unique / long-sort / long-reduce /
 *   long-barcode                              WIN on turns; goLive failure is FAIL
 *
 * Run: bun run benchmarks/campaign/bench-helix.ts [--fast] [--short]
 * `--short` = already-live launch-pad + unique-work only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Session, type WorldFactory } from "./session";
import { summarize, runScenario, FAST, type ScenarioOut, type ArmRun } from "./gates";
import { blockSeed } from "./worlds";
import {
  BATCHES,
  IMAGE_TAGS,
  INBOXES,
  NOISE_IDS,
  PROJECTS,
  QUEUES,
  SITES,
  TREES,
  WAVES,
  createBarcodeLots,
  createDedupeMail,
  createFsTree,
  createGitlabOffset,
  createHelixNoise,
  createLaunchPad,
  createLedgerSettle,
  createPrioQueue,
  createRateLimitRetry,
} from "./helix-worlds";

const SHORT = process.argv.includes("--short");
process.env.CAMPAIGN_THINK_MS = process.env.CAMPAIGN_THINK_MS ?? (FAST ? "1" : "120");

const capture: string[] = [];
const origLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  origLog(...args);
  capture.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
};

function launchPool(): Array<Record<string, unknown>> {
  return SITES.map((s) => ({ site: s.site, env: s.env }));
}
function offsetPool(): Array<Record<string, unknown>> {
  return [...PROJECTS].map((project) => ({ project }));
}
function retryPool(): Array<Record<string, unknown>> {
  return [...IMAGE_TAGS].map((tag) => ({ tag }));
}
function treePool(): Array<Record<string, unknown>> {
  return [...TREES].map((tree) => ({ tree }));
}
function mailPool(): Array<Record<string, unknown>> {
  return [...INBOXES].map((inbox) => ({ inbox }));
}
function prioPool(): Array<Record<string, unknown>> {
  return [...QUEUES].map((queue) => ({ queue }));
}
function ledgerPool(): Array<Record<string, unknown>> {
  return [...BATCHES].map((batch) => ({ batch }));
}
function barcodePool(): Array<Record<string, unknown>> {
  return [...WAVES].map((wave) => ({ wave }));
}
function noisePool(): Array<Record<string, unknown>> {
  return [...NOISE_IDS].map((id) => ({ id }));
}

function writeShortCapture(): void {
  const dir = join(import.meta.dir, "../../.gauntlet/captures/compile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bench-helix-short.txt"), capture.join("\n") + "\n");
}

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
  const s = new Session([["helix-noise", createHelixNoise]], arm === "eden");
  for (let i = 0; i < 5; i++) await s.stretch("helix-noise", pool[i % pool.length]!, blockSeed(`hxu-${i}`, i));
  return { stats: s.finish(), notes: [] };
}

async function main() {
  console.log(`Helix campaign — fast=${FAST} short=${SHORT} thinkMs=${process.env.CAMPAIGN_THINK_MS}`);
  const outs: ScenarioOut[] = [];
  const nWitness = 13;
  const nLive = FAST ? 3 : 6;
  const winRepeats = FAST ? 6 : 7;
  const uniqueRepeats = FAST ? 6 : 8;
  const shortRepeats = FAST || SHORT ? 2 : 3;

  {
    const launch = launchPool();
    console.log("\n[short-launch] already-live 12-step site provision (two-key envelope)");
    const launchPre = await prelive(createLaunchPad, launch);
    outs.push(
      await runScenario({
        name: "short-launch",
        question: "single-stretch launch-pad agent, compiled 12-step already live",
        expect: "WIN on turns",
        tasks: ["t0", "t1", "t2", "t3"],
        repeats: shortRepeats,
        run: (arm, task, repeat) => shortLiveRun("launch-pad", createLaunchPad, launch, launchPre, arm, task, repeat),
      }),
    );
  }

  if (SHORT) {
    console.log("\n[helix-unique] shuffled tool sequences, nothing repeats");
    outs.push(
      await runScenario({
        name: "helix-unique",
        question: "every stretch has a different tool sequence on helix-noise",
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
      key: "long-offset",
      label: "GitLab page/limit then comment each iid",
      world: ["gitlab-offset", createGitlabOffset],
      pool: offsetPool(),
    },
    {
      key: "long-retry",
      label: "pushImage 429×2 then ok, then tagRelease",
      world: ["rate-limit-retry", createRateLimitRetry],
      pool: retryPool(),
    },
    {
      key: "long-tree",
      label: "nested children flatten then scan leaves",
      world: ["fs-tree", createFsTree],
      pool: treePool(),
    },
    {
      key: "long-unique",
      label: "first-seen unique addr then sendDigest",
      world: ["dedupe-mail", createDedupeMail],
      pool: mailPool(),
    },
    {
      key: "long-sort",
      label: "drain jobs by descending prio",
      world: ["prio-queue", createPrioQueue],
      pool: prioPool(),
    },
    {
      key: "long-reduce",
      label: "post lines then settle sum(amt)",
      world: ["ledger-settle", createLedgerSettle],
      pool: ledgerPool(),
    },
    {
      key: "long-barcode",
      label: "foreach barcode+lotCode (not an allowlist name)",
      world: ["barcode-lots", createBarcodeLots],
      pool: barcodePool(),
    },
  ];

  for (let si = 0; si < longDefs.length; si++) {
    const d = longDefs[si]!;
    const expect = "WIN on turns";
    console.log(`\n[${si + 1}/${longDefs.length}] ${d.key} — ${d.label}`);
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

  console.log("\n[helix-unique] shuffled tool sequences, nothing repeats");
  {
    const expect = "parity ±1% (no LOSS)";
    console.log(`  expect: ${expect}`);
    outs.push(
      await runScenario({
        name: "helix-unique",
        question: "every stretch has a different tool sequence on helix-noise",
        expect,
        tasks: ["u"],
        repeats: uniqueRepeats,
        run: (arm) => uniqueRun(arm),
      }),
    );
  }

  summarize(outs, { lossTolerancePct: 1 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
