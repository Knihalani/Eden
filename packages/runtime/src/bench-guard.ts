/**
 * Does the online guard actually stop runaway spend, and by how much?
 *
 * Run with:  bun run packages/runtime/src/bench-guard.ts
 *
 * The claim Eden makes on its dashboard is that in-flight guards cut the cost
 * of a thrashing run. This benchmark states that claim in units, measures it
 * paired, and refuses to pass unless the interval says so — same discipline
 * as bench-loop: counterbalanced arms, replication, and an A/A cell that
 * must come back clean before any A/B number is reported.
 *
 * Workload: an agent stuck in a stall loop (search → write → search → …,
 * constant results — the exact shape repeat_ngram exists for). Each tool
 * call costs a fixed sleep plus one unit of LLM spend. The control arm is
 * the unwrapped agent running every cycle; the treatment arm drives the real
 * wrapTools pipeline and stops when the guard returns { eden: "halted" }.
 */
import { decide, formatDecision, runPlan, type Sample } from "@eden/measure";
import { createState, wrapTools } from "../../wrap/src/wrap-tools";

const CALL_MS = 3;

/** Loop shapes: calls per cycle x cycles before the agent would give up. */
const TASKS = [
  { id: "cycle2-x12", tools: ["search", "write"] as const, cycles: 12 },
  { id: "cycle2-x25", tools: ["search", "write"] as const, cycles: 25 },
  { id: "cycle3-x10", tools: ["probe", "mutate", "report"] as const, cycles: 10 },
];
const REPEATS = 5;

function makeTools(names: readonly string[], counter: { n: number }) {
  const out: Record<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }> = {};
  for (const name of names) {
    out[name] = {
      execute: async () => {
        counter.n++;
        await Bun.sleep(CALL_MS);
        // Constant results: nothing this loop ever does produces new information.
        return { ok: true };
      },
    };
  }
  return out;
}

/** Total simulated spend of a run: wall time plus one LLM unit per raw call. */
async function naiveRun(names: readonly string[], cycles: number): Promise<number> {
  const counter = { n: 0 };
  const tools = makeTools(names, counter);
  const t0 = performance.now();
  for (let i = 0; i < cycles; i++) {
    for (const name of names) await tools[name]!.execute({});
  }
  // Spend units, not just wall time: every raw call is an LLM round trip the
  // bill sees even when the sleep is fast on a beefy machine.
  return performance.now() - t0 + counter.n * 10;
}

async function guardedRun(names: readonly string[], cycles: number): Promise<number> {
  const counter = { n: 0 };
  // Enforcement is the point of this benchmark: it measures what hard
  // guardrails SAVE, which requires guards that are allowed to act.
  const state = createState({ programs: [], enforce: true });
  const tools = wrapTools(makeTools(names, counter), state);
  const t0 = performance.now();
  let stopped = false;
  for (let i = 0; i < cycles && !stopped; i++) {
    for (const name of names) {
      const out = (await tools[name]!.execute({})) as { eden?: string } | unknown;
      if (out && typeof out === "object" && "eden" in out && (out as { eden?: string }).eden !== undefined) {
        stopped = true;
        break;
      }
    }
  }
  await Bun.sleep(0);
  return performance.now() - t0 + counter.n * 10;
}

async function main() {
  // A/B: one block per (task, repeat), arms adjacent and counterbalanced.
  const abPlan = runPlan({ tasks: TASKS.map((t) => t.id), arms: ["naive", "guarded"], repeats: REPEATS });
  const ab: Record<string, Sample[]> = { naive: [], guarded: [] };
  for (const cell of abPlan) {
    const task = TASKS.find((t) => t.id === cell.task)!;
    const value =
      cell.arm === "naive" ? await naiveRun(task.tools, task.cycles) : await guardedRun(task.tools, task.cycles);
    ab[cell.arm]!.push({ task: cell.task, repeat: cell.repeat, value });
  }

  // A/A: the naive arm twice — the timer itself must not be the effect.
  const aaPlan = runPlan({ tasks: TASKS.map((t) => t.id), arms: ["a", "b"], repeats: REPEATS });
  const aa: Record<string, Sample[]> = { a: [], b: [] };
  for (const cell of aaPlan) {
    const task = TASKS.find((t) => t.id === cell.task)!;
    const value = await naiveRun(task.tools, task.cycles);
    aa[cell.arm]!.push({ task: cell.task, repeat: cell.repeat, value });
  }

  const decision = decide({
    treatment: ab.guarded!,
    control: ab.naive!,
    nullControl: { a: aa.a!, b: aa.b! },
    higherIsBetter: false,
  });

  console.log(`# Guard stops runaway loops — ${TASKS.length} shapes x ${REPEATS} repeats`);
  console.log("");
  console.log(formatDecision("wrapTools guard vs unguarded thrash", decision));
  console.log("");
  console.log("Per shape (mean spend units):");
  for (const t of TASKS) {
    const nav = ab.naive!.filter((s) => s.task === t.id);
    const g = ab.guarded!.filter((s) => s.task === t.id);
    const mean = (xs: Sample[]) => xs.reduce((a, b) => a + b.value, 0) / xs.length;
    console.log(
      `  ${t.id.padEnd(12)} naive ${mean(nav).toFixed(0).padStart(6)}   guarded ${mean(g).toFixed(0).padStart(6)}   ${(mean(nav) / mean(g)).toFixed(1)}x less spend`,
    );
  }
  if (decision.verdict !== "WIN") {
    console.error(`\nverdict is ${decision.verdict}, not WIN`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
