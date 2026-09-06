import { createTicketShip, runNaive, ticketShipProgram, toNaiveTrace, WITNESS_IDS } from "../src/ticketship";
import { compileTraces } from "../../compile/src/index";
import { registryFrom, runProgram } from "../src/index";
import type { StretchTrace } from "@eden/ir";

async function traces(n: number): Promise<StretchTrace[]> {
  const out: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const world = createTicketShip({ llmMs: 0 });
    const id = WITNESS_IDS[i % 3]!;
    const run = await runNaive(world, id, { skipVerifyP: 0.2, seed: i + 3 });
    out.push(toNaiveTrace(`b${i}`, id, run));
  }
  return out;
}

const n = Number(process.env.N || 8);
const llmMs = Number(process.env.LLM_MS || 200);
const naiveWorld = createTicketShip({ llmMs });
const t0 = performance.now();
const naive = await runNaive(naiveWorld, "T-100", { skipVerifyP: 0, seed: 1 });
const naiveMs = performance.now() - t0;

const compiledWorld = createTicketShip({ llmMs });
const program = ticketShipProgram();
const c0 = performance.now();
const compiled = await runProgram(program, { id: "T-100" }, {
  registry: registryFrom(compiledWorld.tools),
  island: compiledWorld.island,
  llmCents: 1,
});
const compiledMs = performance.now() - c0;

const mined = compileTraces(await traces(n));
const c40t0 = performance.now();
const mined40 = compileTraces(await traces(40));
const compile40ms = performance.now() - c40t0;

const report = {
  naive: { llm: naive.stats.llmCalls, ms: Math.round(naiveMs), cents: naive.stats.cost_cents, skipVerify: naive.stats.skipped.includes("verifyWrite") },
  handwritten: { llm: compiled.stats.llmCalls, ms: Math.round(compiledMs), cents: compiled.stats.cents, verify: compiledWorld.verified.has("T-100") },
  reduction: {
    llm: naive.stats.llmCalls / compiled.stats.llmCalls,
    ms: naiveMs / compiledMs,
    cents: naive.stats.cost_cents / compiled.stats.cents,
  },
  compiler: { programs: mined.programs.length, refusals: mined.refusals.length, island: mined.programs[0]?.steps.some((s) => s.kind === "island") },
  compile40: { ms: Math.round(compile40ms), programs: mined40.programs.length, refusals: mined40.refusals.length },
  gates: {
    llm5x: naive.stats.llmCalls / compiled.stats.llmCalls >= 5,
    ms5x: naiveMs / compiledMs >= 5,
    cents5x: naive.stats.cost_cents / compiled.stats.cents >= 5,
    verifyPinned: compiledWorld.verified.has("T-100"),
  },
};

console.log(JSON.stringify(report, null, 2));
