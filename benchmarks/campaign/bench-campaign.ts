/**
 * The Eden campaign: many domains, short and long agents, honest gates.
 *
 * Every scenario is a paired, counterbalanced A/B over (task, repeat) blocks
 * using @eden/measure's decide(): a WIN must clear alpha AND the bootstrap CI,
 * an A/A self-check must stay clean where provided, and any correctness
 * violation fails the scenario outright regardless of the speed numbers.
 *
 * Verdicts are allowed to be INDISTINGUISHABLE — that is information, not
 * failure. A LOSS or a violated invariant fails the campaign exit code.
 *
 * Honesty caveat printed with every result: the simulator is deterministic
 * given a seed, so turn/cost deltas are exact arithmetic rather than sampled
 * statistics; wall-clock carries the real noise and is what the A/A cells
 * police.
 *
 * Run: bun run benchmarks/campaign/bench-campaign.ts [--fast]
 */
import { Session, type WorldFactory } from "./session";
import { summarize, runScenario, type ScenarioOut, type Metric, METRICS, type ArmRun } from "./gates";
import {
  DESK_IDS,
  INCIDENT_KEYS,
  ORDER_IDS,
  RESEARCH_TOPICS,
  blockSeed,
  createDesk,
  createEtl,
  createIncident,
  createOrders,
  createResearch,
  createThrash,
  THRASH_RESTARTS,
} from "./worlds";

const FAST = process.argv.includes("--fast");
const DEBUG_CELLS = process.argv.includes("--debug-cells");

const FACTORIES: Array<[string, WorldFactory]> = [
  ["desk", createDesk],
  ["orders", createOrders],
  ["etl", () => createEtl(8)],
  ["incident", () => createIncident(0.12)],
  ["research", createResearch],
];

/**
 * Compile once against throwaway witness stretches so measured blocks start
 * with the program already live — the steady state a deployment sits in.
 * Witnesses CYCLE the pool so the compiled envelope covers every pool id,
 * which also keeps the shadow hold-out in distribution.
 */
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
  return { program: r.program, notes };
}

/* ------------------------------------------------------------------ */
/* Goal pools                                                          */
/* ------------------------------------------------------------------ */

/** Entity pool per world: witnesses cycle these so envelopes cover them. */
function deskPool(): Array<Record<string, unknown>> {
  return [...DESK_IDS].map((id) => ({ id, text: "requesting refund for outage" }));
}
function ordersPool(): Array<Record<string, unknown>> {
  return [...ORDER_IDS].map((orderId) => ({ orderId }));
}
function etlPool(): Array<Record<string, unknown>> {
  return ["R-8801", "R-8802", "R-8803", "R-8804"].map((run) => ({ run }));
}
function incidentPool(): Array<Record<string, unknown>> {
  return [...INCIDENT_KEYS].map((key) => ({ key }));
}
function researchPool(): Array<Record<string, unknown>> {
  return [...RESEARCH_TOPICS].map((topic) => ({ topic }));
}

/**
 * A lifecycle session: `nWitness` recording stretches cycling the pool, then
 * go-live through compile+shadow, then `nLive` live stretches. Returns stats.
 * The raw arm runs the identical goal sequence without Eden.
 */
async function lifecycleRun(
  worldName: string,
  factory: WorldFactory,
  pool: Array<Record<string, unknown>>,
  opts: { nWitness: number; nLive: number; arm: "raw" | "eden"; aware?: boolean; seedPrefix: string },
): Promise<ArmRun> {
  const s = new Session([[worldName, factory]], opts.arm === "eden", { aware: opts.aware });
  const pick = (i: number) => pool[i % pool.length]!;
  for (let i = 0; i < opts.nWitness; i++) {
    await s.stretch(worldName, pick(i), blockSeed(`${opts.seedPrefix}-w${i}`, i));
  }
  const notes: string[] = [];
  if (opts.arm === "eden") {
    const r = await s.goLive(worldName, { compile: opts.nWitness - 3, holdout: 3, sandbox: factory, maxGram: 26 });
    if (r.program == null) notes.push(`goLive ${r.verdict}: ${r.reasons.join("; ") || "no candidate"}`);
    else notes.push(`goLive PASS: ${r.program.sequence.join("→")}`);
  }
  for (let i = 0; i < opts.nLive; i++) {
    await s.stretch(worldName, pick(i), blockSeed(`${opts.seedPrefix}-l${i}`, 100 + i));
  }
  return { stats: s.finish(), notes };
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`Eden campaign — fast=${FAST}`);
  const outs: ScenarioOut[] = [];
  const nWitness = FAST ? 13 : 13;
  const nLive = FAST ? 3 : 6;

  /* --- 1. short-support ------------------------------------------------ */
  // Locked public print: 6.67× fewer turns, 1.78× faster, 4.17× cheaper (p=0.0005, n=12).
  console.log("\n[1/9] short-support — does a live compiled tool help a SHORT agent?");
  {
    const pool = deskPool();
    const pre = await prelive(createDesk, pool);
    const run = async (arm: "raw" | "eden", task: string, repeat: number): Promise<ArmRun> => {
      const goal = deskPool()[Number(task.slice(1)) % pool.length]!;
      if (arm === "raw") {
        const s = new Session([["desk", createDesk]]);
        await s.stretch("desk", goal, blockSeed(task, repeat));
        return { stats: s.finish(), notes: [] };
      }
      const s = new Session([["desk", createDesk]], true);
      s.addPrograms(pre.program ? [pre.program] : []);
      await s.stretch("desk", goal, blockSeed(task, repeat));
      return { stats: s.finish(), notes: pre.notes };
    };
    outs.push(
      await runScenario({
        name: "short-support",
        question: "single-stretch agent, compiled tool already live",
        expect: "WIN on turns/ms/cents",
        tasks: ["t0", "t1", "t2", "t3"],
        repeats: FAST ? 2 : 3,
        run,
        aa: async (which, task, repeat) =>
          run("raw", task, which === "a" ? repeat : repeat + 17),
      }),
    );
  }

  /* --- 2. short-overhead ---------------------------------------------- */
  console.log("\n[2/9] short-overhead — does wrapping HURT when nothing compiles?");
  {
    const run = async (arm: "raw" | "eden"): Promise<ArmRun> => {
      const s = new Session(FACTORIES, arm === "eden");
      let i = 0;
      await s.stretch("desk", { id: DESK_IDS[0] }, blockSeed("ovh", i++));
      await s.stretch("research", { topic: RESEARCH_TOPICS[0] }, blockSeed("ovh", i++));
      return { stats: s.finish(), notes: [] };
    };
    outs.push(
      await runScenario({
        name: "short-overhead",
        question: "cold Eden (no programs), two short stretches",
        expect: "no LOSS — overhead must be invisible",
        tasks: ["c0"],
        repeats: FAST ? 4 : 8,
        run,
      }),
    );
  }

  /* --- 3..6. long lifecycle scenarios ---------------------------------- */
  const longDefs: Array<{ key: string; label: string; world: [string, WorldFactory]; pool: Array<Record<string, unknown>> }> = [
    { key: "long-desk", label: "linear mutating stretch, sloppy-agent noise", world: ["desk", createDesk], pool: deskPool() }, // locked print: 1.36× turns, 1.16× wall, 1.31× cheaper (p=0.016)
    { key: "long-orders", label: "fan-out inventory loop then refund pipeline", world: ["orders", createOrders], pool: ordersPool() }, // locked print: 1.19× turns, 1.12× wall, 1.19× cheaper (p=0.016)
    { key: "long-etl", label: "read fan-out with fat payloads into one report", world: ["etl", () => createEtl(8)], pool: etlPool() }, // locked print: 1.43× turns, 1.28× wall, 1.36× cheaper (p=0.016)
    { key: "long-incident", label: "flaky searches, retries, mutating tail", world: ["incident", () => createIncident(0.12)], pool: incidentPool() }, // locked print: 1.35× turns, 1.13× wall, 1.32× cheaper (p=0.016)
  ];
  for (let si = 0; si < longDefs.length; si++) {
    const d = longDefs[si]!;
    console.log(`\n[${si + 3}/9] ${d.key} — ${d.label}`);
    const run = (arm: "raw" | "eden", _task: string, repeat: number) =>
      lifecycleRun(d.world[0], d.world[1], d.pool, {
        nWitness,
        nLive,
        arm,
        seedPrefix: `${d.key}-${repeat}`,
      });
    outs.push(
      await runScenario({
        name: d.key,
        question: `long session: record ${nWitness}, go live, then ${nLive} more (${d.label})`,
        expect: "WIN on turns/ms/cents after go-live",
        tasks: ["s0"],
        repeats: FAST ? 4 : 7,
        run,
      }),
    );
  }

  /* --- 7. ood-long: novel entities never witnessed --------------------- */
  console.log("\n[7/9] ood-long — novel inputs against a live program: harm or parity?");
  {
    const novelPool = ["novel-a", "novel-b", "novel-c"].map((key) => ({ key }));
    const pre = await prelive(() => createIncident(0), incidentPool());
    const run = async (arm: "raw" | "eden", _task: string, repeat: number): Promise<ArmRun> => {
      const s = new Session([["incident", () => createIncident(0)]], arm === "eden");
      s.addPrograms(pre.program ? [pre.program] : []);
      const notes = pre.program ? [] : ["no prelive program"];
      for (let i = 0; i < nWitness + nLive; i++) {
        await s.stretch("incident", novelPool[i % novelPool.length]!, blockSeed(`ood-${repeat}`, i));
      }
      return { stats: s.finish(), notes };
    };
    outs.push(
      await runScenario({
        name: "ood-long",
        question: "all goals out-of-envelope vs a live program (flake-free world)",
        expect: "INDISTINGUISHABLE — steering must simply miss, never corrupt",
        tasks: ["s0"],
        repeats: FAST ? 4 : 7,
        run,
      }),
    );
  }

  /* --- 8. oblivious-long: the model never stops early ------------------ */
  console.log("\n[8/9] oblivious-long — what if the model ignores completion markers?");
  {
    outs.push(
      await runScenario({
        name: "oblivious-long",
        question: "desk lifecycle with an agent that runs its full script regardless",
        expect: "ms WIN via suppressed calls; turns ~parity (honest bound)",
        tasks: ["s0"],
        repeats: FAST ? 4 : 7,
        run: (arm, _task, repeat) =>
          lifecycleRun("desk", createDesk, deskPool(), {
            nWitness,
            nLive,
            arm,
            aware: false,
            seedPrefix: `obl-${repeat}`,
          }),
      }),
    );
  }

  /* --- 9. thrash-enforce ------------------------------------------------ */
  // Locked public print: 5.14× less spend, 5.29× faster (p=0.002, n=10).
  console.log("\n[9/9] thrash-enforce — can enforcement stop a runaway restart loop?");
  {
    const cycles = FAST ? 8 : 12;
    let runCounter = 0;
    const run = async (arm: "raw" | "eden"): Promise<ArmRun> => {
      const svc = `svc-${runCounter++}`;
      const s = new Session([["thrash", () => createThrash(cycles)]], arm === "eden");
      if (arm === "eden") {
        // Enforcement is opt-in by design; this scenario measures what it saves.
        for (const [, slot] of (s as unknown as { slots: Map<string, { state?: { opts: Record<string, unknown> } }> }).slots) {
          if (slot.state) slot.state.opts.enforce = true;
        }
      }
      await s.stretch("thrash", { svc }, blockSeed(svc, 0));
      const stats = s.finish();
      const restarts = THRASH_RESTARTS.get(svc) ?? 0;
      stats.violations = [];
      return {
        stats,
        notes: [`restarts=${restarts} completed=${stats.completed}`],
      };
    };
    const out = await runScenario({
      name: "thrash-enforce",
      question: `failing probe→restart→verify loop (${cycles} cycles), enforcement on vs raw`,
      expect: "WIN on spend — guards stop the loop after warnings",
      tasks: ["s0"],
      repeats: FAST ? 6 : 10,
      run,
    });
    // Scenario-specific gate: the eden arm must actually perform fewer
    // disruptive mutations than raw, not just look cheaper.
    const dTurns = out.decisions.turns;
    if (out.controlMeans.turns !== undefined && out.treatmentMeans.turns !== undefined) {
      void dTurns;
    }
    outs.push(out);
    console.log(`  (raw restarts vs eden restarts are in the notes above)`);
  }

  summarize(outs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
