/**
 * Holdout campaign: CRM / calendar / payments / cart + unique-work.
 *
 * Gated like bench-campaign.ts (Session + runScenario + summarize). Worlds
 * are disjoint from desk/orders/etl/incident/research/thrash — see
 * HOLD-OUT.md.
 *
 * Pre-registered expects (do not retune after seeing numbers):
 *   short-crm / short-cart                    WIN on turns (program already live)
 *   long-crm / long-calendar / long-payments  WIN on turns
 *   holdout-unique                             parity ±1% (no LOSS)
 *   cart-loop                                 WIN on turns once object-array
 *                                             loops bind; goLive failure is
 *                                             FAIL, not a silent skip-as-win
 *
 * Run: bun run benchmarks/campaign/bench-holdout.ts [--fast] [--short]
 * `--short` = already-live CRM + cart + unique-work only (the sequential PTC comparison).
 */
import { Session, type WorldFactory } from "./session";
import { summarize, runScenario, FAST, type ScenarioOut, type ArmRun } from "./gates";
import { blockSeed } from "./worlds";
import {
  CAL_SLOTS,
  CART_IDS,
  CRM_IDS,
  NOISE_IDS,
  PAY_EMAILS,
  createCalendar,
  createCart,
  createCrm,
  createHoldoutNoise,
  createPayments,
} from "./holdout-worlds";

const SHORT = process.argv.includes("--short");
process.env.CAMPAIGN_THINK_MS = process.env.CAMPAIGN_THINK_MS ?? (FAST ? "1" : "120");

function crmPool(): Array<Record<string, unknown>> {
  return [...CRM_IDS].map((leadId) => ({ leadId }));
}
function calPool(): Array<Record<string, unknown>> {
  return CAL_SLOTS.map((s) => ({ when: s.when, title: s.title }));
}
function payPool(): Array<Record<string, unknown>> {
  return [...PAY_EMAILS].map((email) => ({ email }));
}
function cartPool(): Array<Record<string, unknown>> {
  return [...CART_IDS].map((cart) => ({ cart }));
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

async function main() {
  console.log(`Holdout campaign — fast=${FAST} short=${SHORT} thinkMs=${process.env.CAMPAIGN_THINK_MS}`);
  const outs: ScenarioOut[] = [];
  const nWitness = 13;
  const nLive = FAST ? 3 : 6;
  const winRepeats = FAST ? 6 : 7;
  const uniqueRepeats = FAST ? 6 : 8;
  const shortRepeats = FAST || SHORT ? 2 : 3;

  {
    const crm = crmPool();
    const cart = cartPool();
    console.log("\n[short-crm] already-live 5-call sales pipeline (sequential PTC comparison)");
    const crmPre = await prelive(createCrm, crm);
    outs.push(
      await runScenario({
        name: "short-crm",
        question: "single-stretch CRM agent, compiled tool already live",
        expect: "WIN on turns",
        tasks: ["t0", "t1", "t2", "t3"],
        repeats: shortRepeats,
        run: (arm, task, repeat) => shortLiveRun("crm", createCrm, crm, crmPre, arm, task, repeat),
      }),
    );
    console.log("\n[short-cart] already-live object-array cart loop");
    const cartPre = await prelive(createCart, cart);
    outs.push(
      await runScenario({
        name: "short-cart",
        question: "single-stretch cart agent, compiled foreach already live",
        expect: "WIN on turns",
        tasks: ["t0", "t1", "t2", "t3"],
        repeats: shortRepeats,
        run: (arm, task, repeat) => shortLiveRun("cart", createCart, cart, cartPre, arm, task, repeat),
      }),
    );
  }

  if (SHORT) {
    console.log("\n[holdout-unique] shuffled tool sequences, nothing repeats");
    const pool = noisePool();
    const run = async (arm: "raw" | "eden"): Promise<ArmRun> => {
      const s = new Session([["holdout-noise", createHoldoutNoise]], arm === "eden");
      for (let i = 0; i < 5; i++) await s.stretch("holdout-noise", pool[i % pool.length]!, blockSeed(`hu-${i}`, i));
      return { stats: s.finish(), notes: [] };
    };
    outs.push(
      await runScenario({
        name: "holdout-unique",
        question: "every stretch has a different tool sequence on holdout-noise",
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
    {
      key: "long-crm",
      label: "sales pipeline, five linear mutating steps",
      world: ["crm", createCrm],
      pool: crmPool(),
    },
    {
      key: "long-calendar",
      label: "two-field goal, listBusy then event+invite+reminder",
      world: ["calendar", createCalendar],
      pool: calPool(),
    },
    {
      key: "long-payments",
      label: "nested customer.billing.id then invoice+charge+receipt",
      world: ["payments", createPayments],
      pool: payPool(),
    },
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

  console.log("\n[4/5] holdout-unique — shuffled tool sequences, nothing repeats");
  {
    const pool = noisePool();
    const expect = "parity ±1% (no LOSS)";
    console.log(`  expect: ${expect}`);
    const run = async (arm: "raw" | "eden"): Promise<ArmRun> => {
      const s = new Session([["holdout-noise", createHoldoutNoise]], arm === "eden");
      for (let i = 0; i < 5; i++) await s.stretch("holdout-noise", pool[i % pool.length]!, blockSeed(`hu-${i}`, i));
      return { stats: s.finish(), notes: [] };
    };
    outs.push(
      await runScenario({
        name: "holdout-unique",
        question: "every stretch has a different tool sequence on holdout-noise",
        expect,
        tasks: ["u"],
        repeats: uniqueRepeats,
        run: (arm) => run(arm),
      }),
    );
  }

  console.log("\n[5/5] cart-loop — object-array items { sku, qty }, not string[]");
  {
    const expect = "WIN on turns once compiler binds object arrays; goLive failure is FAIL not skip";
    console.log(`  expect: ${expect}`);
    outs.push(
      await runScenario({
        name: "cart-loop",
        question: `long session on createCart (width ${3}): listCart → reserveSku ×3 → checkoutCart`,
        expect,
        tasks: ["s0"],
        repeats: winRepeats,
        run: (arm, _task, repeat) =>
          lifecycleRun("cart", createCart, cartPool(), {
            nWitness,
            nLive,
            arm,
            seedPrefix: `cart-${repeat}`,
            requireLive: true,
          }),
      }),
    );
  }

  // Unique-work: 1% band is recording cost, not a defect. WIN scenarios
  // have large turn deltas; a 1% band does not hide a missed compile.
  summarize(outs, { lossTolerancePct: 1 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
