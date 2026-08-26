/**
 * Negative-control campaign: regimes where Eden should NOT help.
 *
 * These exist to catch overfitting. The main campaign's domains all contain
 * repeated, compilable stretches — the shape Eden was built for. Each scenario
 * here breaks one of those assumptions and asserts that Eden neither helps
 * dishonestly nor corrupts anything:
 *
 *   n1 unique-work     different tool sequence every stretch — nothing to mine
 *   n2 creative        every step is model judgment — nothing bindable
 *   n3 micro           two-call stretches — below compile minimums
 *   n4 fastdesk-live   instant tools — savings must come from turns only
 *   n5 drift           goals walk away from the witnessed distribution
 *   n6 chaos-observe   failure-dominant workload, observe mode (default)
 *   n7 concurrent      three stretches interleaved on one wrapped surface
 *
 * Expectations are printed with each result; a LOSS or a correctness
 * violation fails the exit code. INDISTINGUISHABLE is the honest answer for
 * most of these, and is treated as success.
 */
import { Session } from "./session";
import { summarize, runScenario, type ScenarioOut, type ArmRun as ArmRunLike } from "./gates";
import {
  DESK_IDS,
  blockSeed,
  createDesk,
} from "./worlds";
import { createNoise, createCreative, createMicro, createFastDesk, createChaos } from "./negative-worlds";

const FAST = process.argv.includes("--fast");
process.env.CAMPAIGN_THINK_MS = "120";

/** Compile once so steady-state programs exist where compilation is possible. */
async function prelive(factory: () => ReturnType<typeof createDesk> | (() => unknown), pool: Array<Record<string, unknown>>, count = 13) {
  const s = new Session([["w", factory as never]], true);
  for (let i = 0; i < count; i++) await s.stretch("w", pool[i % pool.length]!, blockSeed(`neg-pre-${i}`, i));
  return await s.goLive("w", { compile: count - 3, holdout: 3, sandbox: factory as never, maxGram: 26, assumeProviderUsage: true });
}

/** Try to compile against a world; returns null when nothing can go live. */
async function tryPrelive(factory: any, pool: Array<Record<string, unknown>>): Promise<{ program: unknown | null; notes: string[] }> {
  const r = await prelive(factory, pool);
  const notes = r.program ? [] : [`no program went live (${r.verdict}) — as designed for this regime`];
  return { program: r.program, notes };
}

async function main() {
  console.log(`Negative-control campaign — fast=${FAST}`);
  const outs: ScenarioOut[] = [];
  const reps = FAST ? 4 : 8;

  /* --- n1 unique-work --------------------------------------------------- */
  console.log("\n[n1] unique-work — no stretch ever repeats: what does Eden cost?");
  {
    const pool = Array.from({ length: 6 }, (_, i) => ({ id: `N-${i}` }));
    const run = async (arm: "raw" | "eden"): Promise<ArmRunLike> => {
      const s = new Session([["noise", createNoise]], arm === "eden");
      for (let i = 0; i < 5; i++) await s.stretch("noise", pool[i % pool.length]!, blockSeed(`n1-${i}`, i));
      return { stats: s.finish(), notes: [] };
    };
    outs.push(
      await runScenario({
        name: "unique-work",
        question: "every stretch has a different tool sequence",
        expect: "INDISTINGUISHABLE — recording overhead may show, help must not",
        tasks: ["u"],
        repeats: reps,
        run: (arm) => run(arm),
      }),
    );
  }

  /* --- n2 creative ------------------------------------------------------ */
  console.log("\n[n2] creative — five judgment steps then a write: nothing bindable?");
  {
    const pool = [{ id: "C-1" }, { id: "C-2" }];
    const pre = await tryPrelive(createCreative, pool);
    const run = async (arm: "raw" | "eden"): Promise<ArmRunLike> => {
      const s = new Session([["creative", createCreative]], arm === "eden");
      if (arm === "eden") s.addPrograms(pre.program ? [pre.program as never] : []);
      for (let i = 0; i < 3; i++) await s.stretch("creative", pool[i % pool.length]!, blockSeed(`n2-${i}`, i));
      return { stats: s.finish(), notes: pre.notes };
    };
    outs.push(
      await runScenario({
        name: "creative",
        question: "all-judgment stretches: compile must refuse, steering must miss",
        expect: "INDISTINGUISHABLE or small overhead; publication exactly-once",
        tasks: ["c"],
        repeats: reps,
        run: (arm) => run(arm),
      }),
    );
  }

  /* --- n3 micro --------------------------------------------------------- */
  console.log("\n[n3] micro — two-call stretches: below compile minimums?");
  {
    const pool = [{ id: "M-1" }, { id: "M-2" }];
    const pre = await tryPrelive(createMicro, pool);
    const run = async (arm: "raw" | "eden"): Promise<ArmRunLike> => {
      const s = new Session([["micro", createMicro]], arm === "eden");
      if (arm === "eden") s.addPrograms(pre.program ? [pre.program as never] : []);
      for (let i = 0; i < 8; i++) await s.stretch("micro", pool[i % pool.length]!, blockSeed(`n3-${i}`, i));
      return { stats: s.finish(), notes: pre.notes };
    };
    outs.push(
      await runScenario({
        name: "micro",
        question: "16 two-call stretches per session",
        expect: "no LOSS beyond recording overhead; flags exactly-once",
        tasks: ["m"],
        repeats: reps,
        run: (arm) => run(arm),
      }),
    );
  }

  /* --- n4 fastdesk-live -------------------------------------------------- */
  console.log("\n[n4] fastdesk-live — instant tools: do turn savings survive?");
  {
    const pool = ["F-1", "F-2", "F-3", "F-4"].map((id) => ({ id }));
    const pre = await tryPrelive(createFastDesk, pool);
    const run = async (arm: "raw" | "eden", task: string, repeat: number): Promise<ArmRunLike> => {
      const goal = pool[Number(task.slice(1)) % pool.length]!;
      const s = new Session([["fastdesk", createFastDesk]], arm === "eden");
      if (arm === "eden") s.addPrograms(pre.program ? [pre.program as never] : []);
      await s.stretch("fastdesk", goal, blockSeed(task, repeat));
      return { stats: s.finish(), notes: pre.notes };
    };
    outs.push(
      await runScenario({
        name: "fastdesk-live",
        question: "compiled tool live, but tools take ~1ms",
        expect: "turn/cents WIN from early stop; wall gain smaller than slow-tool worlds",
        tasks: ["t0", "t1", "t2", "t3"],
        repeats: FAST ? 2 : 3,
        run,
        aa: async (which, task, repeat) => run("raw", task, which === "a" ? repeat : repeat + 31),
      }),
    );
  }

  /* --- n5 drift ---------------------------------------------------------- */
  console.log("\n[n5] drift — witnessed ids first, novel ids later: graceful fade?");
  {
    // Witness four desk accounts, then walk to unseen ones.
    const witnessPool = [...DESK_IDS].map((id) => ({ id }));
    const drifted = ["Z-9001", "Z-9002", "Z-9003"].map((id) => ({ id }));
    const pre = await tryPrelive(createDesk, witnessPool);
    const run = async (arm: "raw" | "eden"): Promise<ArmRunLike> => {
      const s = new Session([["desk", createDesk]], arm === "eden");
      if (arm === "eden") s.addPrograms(pre.program ? [pre.program as never] : []);
      for (let i = 0; i < 4; i++) await s.stretch("desk", witnessPool[i % witnessPool.length]!, blockSeed(`n5-w${i}`, i));
      for (let i = 0; i < 4; i++) await s.stretch("desk", drifted[i % drifted.length]!, blockSeed(`n5-d${i}`, 50 + i));
      return { stats: s.finish(), notes: pre.notes };
    };
    outs.push(
      await runScenario({
        name: "drift",
        question: "half witnessed goals, half novel: partial benefit, zero corruption",
        expect: "WIN on turns (witnessed half steers), correctness everywhere",
        tasks: ["d"],
        repeats: reps,
        run: (arm) => run(arm),
      }),
    );
  }

  /* --- n6 chaos-observe --------------------------------------------------- */
  console.log("\n[n6] chaos-observe — 2-in-3 calls fail, observe mode: harmless?");
  {
    const pool = [{ key: "svc-a" }, { key: "svc-b" }];
    const run = async (arm: "raw" | "eden"): Promise<ArmRunLike> => {
      const s = new Session([["chaos", createChaos]], arm === "eden");
      for (let i = 0; i < 4; i++) await s.stretch("chaos", pool[i % pool.length]!, blockSeed(`n6-${i}`, i));
      const st = s.finish();
      return { stats: st, notes: [] };
    };
    outs.push(
      await runScenario({
        name: "chaos-observe",
        question: "failure-dominant workload under default fail-safe mode",
        expect: "INDISTINGUISHABLE — observe mode never halts, never helps, never corrupts",
        tasks: ["o"],
        repeats: reps,
        run: (arm) => run(arm),
      }),
    );
  }

  /* --- n7 concurrent ------------------------------------------------------ */
  console.log("\n[n7] concurrent — three stretches interleaved on one wrapped surface");  {
    const pool = [...DESK_IDS].map((id) => ({ id, text: "requesting refund for outage" }));
    const pre = await tryPrelive(createDesk, pool);
    const run = async (arm: "raw" | "eden"): Promise<ArmRunLike> => {
      const s = new Session([["desk", createDesk]], arm === "eden");
      if (arm === "eden") s.addPrograms(pre.program ? [pre.program as never] : []);
      await s.stretchConcurrent("desk", [pool[0]!, pool[1]!, pool[2]!], blockSeed("n7", 7));
      const st = s.finish();
      // Concurrency note: interleaved raw calls may execute in any order;
      // exactly-once still holds per goal.
      return { stats: st, notes: pre.notes };
    };
    outs.push(
      await runScenario({
        name: "concurrent",
        question: "interleaved goals vs the arming machinery",
        expect: "WIN on turns; ZERO duplicate mutations across overlapping stretches",
        tasks: ["x"],
        repeats: reps,
        run: (arm) => run(arm),
      }),
    );
  }


  /* --- n8 chaos-enforce --------------------------------------------------- */
  console.log("\n[n8] chaos-enforce — enforcement on a failure-dominant workload: help or harm?");
  {
    const pool = [{ key: "svc-a" }, { key: "svc-b" }];
    const run = async (arm: "raw" | "eden"): Promise<ArmRunLike> => {
      const s = new Session([["chaos", createChaos]], arm === "eden");
      if (arm === "eden") {
        for (const [, slot] of (s as unknown as { slots: Map<string, { state?: { opts: Record<string, unknown> } }> }).slots) {
          if (slot.state) slot.state.opts.enforce = true;
        }
      }
      for (let i = 0; i < 4; i++) await s.stretch("chaos", pool[i % pool.length]!, blockSeed(`n8-${i}`, i));
      return { stats: s.finish(), notes: [] };
    };
    outs.push(
      await runScenario({
        name: "chaos-enforce",
        question: "2-in-3 failures with guards allowed to halt",
        expect: "spend WIN without losing more completions than raw",
        tasks: ["e"],
        repeats: reps,
        run: (arm) => run(arm),
      }),
    );
  }

  // Negative controls: parity is the bar. Losses under 1% are the measured
  // recording cost (~35µs/call), not defects; they print and pass.
  summarize(outs, { lossTolerancePct: 1 });
}



main().catch((err) => {
  console.error(err);
  process.exit(1);
});
