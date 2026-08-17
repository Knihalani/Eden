/**
 * Does parallelising read-only loop bodies actually help, and by how much?
 *
 * Run with:  bun run packages/runtime/src/bench-loop.ts
 *
 * Deliberately built on @eden/measure rather than on a pair of totals: the
 * point of that module is that a benchmark should state its uncertainty, and a
 * benchmark of Eden's own runtime is the first place to apply it. So this run
 * is paired, interleaved, counterbalanced, replicated, and carries an A/A cell
 * that must come back clean before the A/B is reported.
 *
 * It is also free. No API key, no live model, no GitHub — the "tools" are timed
 * sleeps, which is what makes it worth running on every change instead of once
 * a fortnight.
 */
import { decide, formatDecision, runPlan, type Sample } from "@eden/measure";
import { withVersion, type StretchProgram } from "@eden/ir";
import { runProgram } from "./execute";

/** Each task is a fan-out shape: how many items, and how slow each fetch is. */
const TASKS = [
  { id: "fanout-4x40ms", items: 4, latencyMs: 40 },
  { id: "fanout-12x25ms", items: 12, latencyMs: 25 },
  { id: "fanout-20x15ms", items: 20, latencyMs: 15 },
  { id: "fanout-8x60ms", items: 8, latencyMs: 60 },
];
const REPEATS = 3;
const WIDTH = 8;

function program(items: number): StretchProgram {
  return withVersion({
    id: "p_loop_bench",
    name: "loop_bench",
    description: "fan out over a listing",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    sequence: ["listItems", "fetchDetails"],
    steps: [
      { id: "listItems", kind: "tool", tool: "listItems", args: { q: { kind: "input", path: "q" } } },
      {
        id: "loop1",
        kind: "loop",
        over: { kind: "from", step: "listItems", path: "items" },
        item: "item_loop1",
        body: ["fetchDetails"],
      },
      {
        id: "fetchDetails",
        kind: "tool",
        tool: "fetchDetails",
        args: { id: { kind: "from", step: "item_loop1", path: "id" } },
      },
    ],
    returns: { kind: "from", step: "loop1", path: "" },
    contract: { witnesses: 5, minLlmReduction: 2, allowExact: true },
    manifest: null,
  }) as StretchProgram;
}

function registryFor(items: number, latencyMs: number) {
  return {
    async execute(tool: string, args: Record<string, unknown>) {
      if (tool === "listItems") {
        return { items: Array.from({ length: items }, (_, i) => ({ id: `I-${i}` })) };
      }
      await Bun.sleep(latencyMs);
      return { of: args.id };
    },
  };
}

async function timeRun(items: number, latencyMs: number, loopConcurrency: number): Promise<number> {
  const t0 = performance.now();
  const out = await runProgram(program(items), { q: "x" }, {
    registry: registryFor(items, latencyMs),
    checkEnvelope: false,
    loopConcurrency,
  });
  const ms = performance.now() - t0;
  // A speed number is meaningless if the work changed, so assert it did not.
  if ((out.value as unknown[]).length !== items) {
    throw new Error(`expected ${items} results, got ${(out.value as unknown[]).length}`);
  }
  return ms;
}

async function main() {
  const armWidth: Record<string, number> = { sequential: 1, parallel: WIDTH };
  const taskById = new Map(TASKS.map((t) => [t.id, t]));

  // A/B: one block per (task, repeat), arms adjacent and counterbalanced.
  const abPlan = runPlan({ tasks: TASKS.map((t) => t.id), arms: ["sequential", "parallel"], repeats: REPEATS });
  const ab: Record<string, Sample[]> = { sequential: [], parallel: [] };
  for (const cell of abPlan) {
    const t = taskById.get(cell.task)!;
    const ms = await timeRun(t.items, t.latencyMs, armWidth[cell.arm]!);
    ab[cell.arm]!.push({ task: cell.task, repeat: cell.repeat, value: ms });
  }

  // A/A: the same arm twice, to show the timer itself is not the effect.
  const aaPlan = runPlan({ tasks: TASKS.map((t) => t.id), arms: ["a", "b"], repeats: REPEATS });
  const aa: Record<string, Sample[]> = { a: [], b: [] };
  for (const cell of aaPlan) {
    const t = taskById.get(cell.task)!;
    const ms = await timeRun(t.items, t.latencyMs, WIDTH);
    aa[cell.arm]!.push({ task: cell.task, repeat: cell.repeat, value: ms });
  }

  const decision = decide({
    treatment: ab.parallel!,
    control: ab.sequential!,
    nullControl: { a: aa.a!, b: aa.b! },
    higherIsBetter: false,
  });

  console.log(`# Parallel read-only loop bodies — ${TASKS.length} tasks x ${REPEATS} repeats, width ${WIDTH}`);
  console.log("");
  console.log(formatDecision("loopConcurrency=8 vs loopConcurrency=1", decision));
  console.log("");
  console.log("Per task:");
  for (const t of TASKS) {
    const seq = ab.sequential!.filter((s) => s.task === t.id).map((s) => s.value);
    const par = ab.parallel!.filter((s) => s.task === t.id).map((s) => s.value);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(
      `  ${t.id.padEnd(16)} sequential ${avg(seq).toFixed(0).padStart(5)}ms   ` +
        `parallel ${avg(par).toFixed(0).padStart(5)}ms   ${(avg(seq) / avg(par)).toFixed(1)}x`,
    );
  }
  // A benchmark that cannot fail is decoration. This one gates.
  if (decision.verdict !== "WIN") {
    console.error(`\nverdict is ${decision.verdict}, not WIN`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
