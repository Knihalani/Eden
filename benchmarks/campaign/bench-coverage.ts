/**
 * Coverage-expansion campaign (Wave 1.3): gated scenarios for missing regimes.
 *
 *   slow-tool-timeout  — wrap timeout << tool sleep; exactly-once under deopt
 *   very-long-session  — 4 / 8 / 100 live stretches (--fast / default / --long)
 *   high-card-ids      — witnessed set A, live novel ids, same shape → parity
 *   pagination-loop    — paged list then per-item mutate; compile or refuse
 *
 * Expectations are pre-registered before each run (ROADMAP §4.9).
 *
 *   bun run benchmarks/campaign/bench-coverage.ts [--fast] [--long]
 */
import { Session } from "./session";
import { summarize, runScenario, type ScenarioOut, type ArmRun, METRICS } from "./gates";
import { blockSeed } from "./worlds";
import {
  LONG_SESSION_IDS,
  armSlowToolLive,
  campaignWrapTimeoutMs,
  createHighCard,
  createLongSession,
  createPagination,
  createSlowTool,
} from "./coverage-worlds";

const FAST = process.argv.includes("--fast");
const LONG = process.argv.includes("--long");

process.env.CAMPAIGN_THINK_MS = process.env.CAMPAIGN_THINK_MS ?? "1";
const WRAP_TO = campaignWrapTimeoutMs();
process.env.CAMPAIGN_WRAP_TIMEOUT_MS = String(WRAP_TO);
// Do NOT set EDEN_TIMEOUT_MS globally — it would starve other scenarios' shadow.
// slow-tool-timeout sets it only around its own cells.

async function prelive(
  factory: () => import("./worlds").World,
  pool: Array<Record<string, unknown>>,
  count = FAST ? 8 : 13,
): Promise<{ program: Awaited<ReturnType<Session["goLive"]>>["program"]; notes: string[] }> {
  const s = new Session([["w", factory]], true);
  const notes: string[] = [];
  for (let i = 0; i < count; i++) {
    await s.stretch("w", pool[i % pool.length]!, blockSeed(`cov-pre-${i}`, i));
  }
  const r = await s.goLive("w", {
    compile: Math.max(3, count - 3),
    holdout: 3,
    sandbox: factory,
    maxGram: 26,
  });
  if (r.program == null)
    notes.push(`prelive did NOT go live (${r.verdict}): ${r.reasons.join("; ") || "no candidate"}`);
  else notes.push(`prelive PASS: ${r.program.sequence.join("→")}`);
  return { program: r.program, notes };
}

/** Correctness-first: wall LOSS under timeout+deopt must not fail the run.
 * Turns/cents stay gated — a turn LOSS here is not "deopt is expensive". */
function softenTimeoutLosses(o: ScenarioOut): ScenarioOut {
  if (o.violations.length > 0) return o;
  const d = o.decisions.wall_ms;
  if (d?.verdict !== "LOSS") return o;
  o.decisions.wall_ms = { ...d, verdict: "INDISTINGUISHABLE" };
  o.notes = [...o.notes, "wall_ms LOSS tolerated for slow-tool-timeout (deopt is expensive; turns/cents still gated)"];
  o.ok = METRICS.every((m) => o.decisions[m]?.verdict !== "LOSS");
  return o;
}

async function main() {
  console.log(`Coverage campaign — fast=${FAST} long=${LONG} wrapTimeoutMs=${WRAP_TO}`);
  const outs: ScenarioOut[] = [];
  const reps = FAST ? 2 : 4;

  /* --- slow-tool-timeout ------------------------------------------------ */
  // Pre-registered expectation (ROADMAP §4.9) — do not edit post-hoc silently.
  const EXPECT_SLOW = "exactly-once under timeout; wall may LOSS";
  console.log(`\n[1/4] slow-tool-timeout — expect: ${EXPECT_SLOW}`);
  {
    // Two ids × many reps so hold-out can keep ≥1 training rep per id and still
    // reach shadow minN=3 (same pattern as desk lifecycle).
    const pool = ["T-1", "T-2"].map((id) => ({ id }));
    const nWitness = FAST ? 13 : 13;
    const run = async (arm: "raw" | "eden", _task: string, repeat: number): Promise<ArmRun> => {
      const prevTimeout = process.env.EDEN_TIMEOUT_MS;
      process.env.EDEN_TIMEOUT_MS = String(WRAP_TO);
      armSlowToolLive(false);
      try {
        const s = new Session([["slow-tool", createSlowTool]], arm === "eden");
        const notes: string[] = [];
        for (let i = 0; i < nWitness; i++) {
          await s.stretch("slow-tool", pool[i % pool.length]!, blockSeed(`slow-w-${repeat}-${i}`, i));
        }
        if (arm === "eden") {
          const r = await s.goLive("slow-tool", {
            compile: Math.max(3, nWitness - 3),
            holdout: 3,
            sandbox: createSlowTool,
            maxGram: 16,
          });
          if (r.program == null) notes.push(`goLive ${r.verdict}: ${r.reasons.join("; ") || "no candidate"}`);
          else notes.push(`goLive PASS: ${r.program.sequence.join("→")}`);
        }
        // Arm long sleep only for live stretches so wrap timeout can fire under Eden.
        armSlowToolLive(true);
        for (let i = 0; i < (FAST ? 1 : 2); i++) {
          await s.stretch("slow-tool", pool[i % pool.length]!, blockSeed(`slow-l-${repeat}-${i}`, 100 + i));
        }
        return { stats: s.finish(), notes };
      } finally {
        armSlowToolLive(false);
        if (prevTimeout === undefined) delete process.env.EDEN_TIMEOUT_MS;
        else process.env.EDEN_TIMEOUT_MS = prevTimeout;
      }
    };
    const out = await runScenario({
      name: "slow-tool-timeout",
      question: "wrap timeout << slowFetch sleep: deopt-claim, exactly-once mutations",
      expect: EXPECT_SLOW,
      tasks: ["s0"],
      repeats: reps,
      run,
    });
    outs.push(softenTimeoutLosses(out));
  }

  /* --- very-long-session ------------------------------------------------ */
  const nLive = LONG ? 100 : FAST ? 4 : 8;
  const EXPECT_LONG = "WIN or certified go-live notes; zero violations across long stretch count";
  console.log(`\n[2/4] very-long-session — nLive=${nLive} — expect: ${EXPECT_LONG}`);
  {
    const pool = [...LONG_SESSION_IDS].map((id) => ({ id }));
    const nWitness = FAST ? 8 : 13;
    const run = async (arm: "raw" | "eden", _task: string, repeat: number): Promise<ArmRun> => {
      const s = new Session([["long-session", createLongSession]], arm === "eden");
      const notes: string[] = [];
      for (let i = 0; i < nWitness; i++) {
        await s.stretch("long-session", pool[i % pool.length]!, blockSeed(`long-w-${repeat}-${i}`, i));
      }
      if (arm === "eden") {
        const r = await s.goLive("long-session", {
          compile: nWitness - 3,
          holdout: 3,
          sandbox: createLongSession,
          maxGram: 16,
        });
        if (r.program == null) notes.push(`goLive ${r.verdict}: ${r.reasons.join("; ") || "no candidate"}`);
        else notes.push(`goLive PASS: ${r.program.sequence.join("→")}`);
      }
      for (let i = 0; i < nLive; i++) {
        await s.stretch("long-session", pool[i % pool.length]!, blockSeed(`long-l-${repeat}-${i}`, 200 + i));
      }
      return { stats: s.finish(), notes };
    };
    outs.push(
      await runScenario({
        name: "very-long-session",
        question: `record ${nWitness}, go live, then ${nLive} live stretches over a 4-id pool`,
        expect: EXPECT_LONG,
        tasks: ["s0"],
        repeats: FAST ? 2 : 3,
        run,
      }),
    );
  }

  /* --- high-card-ids ---------------------------------------------------- */
  const EXPECT_HC = "steer misses / raw fallback, parity, no corruption (like ood-long)";
  console.log(`\n[3/4] high-card-ids — expect: ${EXPECT_HC}`);
  {
    const witnessPool = ["W-1", "W-2", "W-3", "W-4"].map((id) => ({ id }));
    const pre = await prelive(createHighCard, witnessPool);
    const run = async (arm: "raw" | "eden", task: string, repeat: number): Promise<ArmRun> => {
      const s = new Session([["high-card", createHighCard]], arm === "eden");
      if (arm === "eden") s.addPrograms(pre.program ? [pre.program] : []);
      // Live goals: all novel unique ids, same shape.
      const n = FAST ? 3 : 5;
      for (let i = 0; i < n; i++) {
        const id = `H-${repeat}-${i}`;
        await s.stretch("high-card", { id }, blockSeed(`${task}-hc-${i}`, repeat * 31 + i));
      }
      return { stats: s.finish(), notes: pre.notes };
    };
    outs.push(
      await runScenario({
        name: "high-card-ids",
        question: "witnesses on set A; live goals all novel ids, identical sequence shape",
        expect: EXPECT_HC,
        tasks: ["h0"],
        repeats: reps,
        run,
      }),
    );
  }

  /* --- pagination-loop -------------------------------------------------- */
  const EXPECT_PAGE = "compilable loop OR honest refusal; mutations exactly-once";
  console.log(`\n[4/4] pagination-loop — expect: ${EXPECT_PAGE}`);
  {
    const pool = [{ batch: "B1" }, { batch: "B2" }];
    const pre = await prelive(createPagination, pool, FAST ? 6 : 10);
    const run = async (arm: "raw" | "eden", _task: string, repeat: number): Promise<ArmRun> => {
      const s = new Session([["pagination", createPagination]], arm === "eden");
      if (arm === "eden") s.addPrograms(pre.program ? [pre.program] : []);
      const notes = [...pre.notes];
      if (!pre.program) notes.push("honest refusal / no live program — raw path only");
      for (let i = 0; i < (FAST ? 1 : 2); i++) {
        await s.stretch("pagination", pool[i % pool.length]!, blockSeed(`page-${repeat}-${i}`, i));
      }
      return { stats: s.finish(), notes };
    };
    outs.push(
      await runScenario({
        name: "pagination-loop",
        question: "list page1→page2→page3 then writeItem each id",
        expect: EXPECT_PAGE,
        tasks: ["p0"],
        repeats: reps,
        run,
      }),
    );
  }

  // Parity-style materiality for overhead on OOD/high-card; slow-tool already softened.
  summarize(outs, { lossTolerancePct: 1 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
