/**
 * The whole gate (`sanitizeForStore`) before and after docs/research/redact-perf.md, interleaved: the reference gate
 * (`secrets.reference.ts`, the gate as it was), the gate now, and, as the re2js oracle's cost, the reference gate on
 * D24's engines (re2js for the seven rules that backtrack and every allowlist) and on re2js for everything. Realistic
 * text (`corpus.ts`: sim mail, chat and docs, the eval scenarios, the repo's code, service logs, JSON tool results)
 * at 256 B to 1 MB, then the crafted inputs (`gate-crafted.ts`) at 256 KB. Each cell is the median of interleaved
 * rounds (the order alternates), µs a call; every gate's output is checked equal first. Then the first call (rules
 * built, the text's rules compiled), `warmGate`, and the heap the warmed gate holds.
 *
 *   env -u BUN_OPTIONS bun packages/redact/bench/gate.bench.ts [sizes, default 256,2048,16384,1048576] [--re2]
 */
import { D24_ENGINES, linearEngine } from "../src/re2-oracle";
import { CRAFTED_UNITS, crafted } from "../src/gate-crafted";
import { everywhere, gateOf, secretRules, type Gate } from "../src/secrets";
import * as reference from "../src/secrets.reference";
import { KINDS, sample } from "./corpus";

const args = process.argv.slice(2);
const withRe2 = args.includes("--re2");
const sizes = (args.find((arg) => /^\d/.test(arg)) ?? "256,2048,16384,1048576").split(",").map(Number);

const gates: [string, Gate][] = [
  ["before", reference.gateOf(reference.secretRules())],
  ["after", gateOf(secretRules())],
];
if (withRe2) {
  gates.push(["D24 (re2js)", reference.gateOf(reference.rulesWith(D24_ENGINES))]);
  gates.push(["all re2js", reference.gateOf(reference.rulesWith(everywhere(linearEngine)))]);
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const fmt = (us: number) => (us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(1)} µs`);

/** Median µs a call per gate, rounds interleaved; checks every gate stores the same text. */
function race(text: string, budgetMs: number): number[] {
  const outputs = new Set(gates.map(([, gate]) => gate.sanitizeForStore(text)));
  if (outputs.size !== 1) throw new Error(`gates differ on a ${text.length}-character text`);
  // Calls a round: enough for about budgetMs a gate over 7 rounds.
  const t0 = performance.now();
  gates[0]![1].sanitizeForStore(text);
  const once = Math.max(performance.now() - t0, 0.001);
  const reps = Math.max(1, Math.min(2_000, Math.floor(budgetMs / 7 / once)));
  const times: number[][] = gates.map(() => []);
  for (let round = 0; round < 7; round++) {
    const order = round % 2 === 0 ? gates.keys() : [...gates.keys()].reverse();
    for (const g of order) {
      const start = performance.now();
      for (let i = 0; i < reps; i++) gates[g]![1].sanitizeForStore(text);
      times[g]!.push(((performance.now() - start) * 1000) / reps);
    }
  }
  return times.map(median);
}

const header = `| Text | ${gates.map(([name]) => name).join(" | ")} | before / after |`;
const rule = `|---|${gates.map(() => "---:").join("|")}|---:|`;
for (const size of sizes) {
  console.log(`\n${size.toLocaleString("en-US")} characters\n\n${header}\n${rule}`);
  for (const kind of KINDS) {
    const cells = race(sample(kind, size, 1), size >= 1 << 20 ? 3_000 : 400);
    console.log(`| ${kind} | ${cells.map(fmt).join(" | ")} | ${(cells[0]! / cells[1]!).toFixed(2)}x |`);
  }
}

console.log(`\nCrafted, 256 KB\n\n${header}\n${rule}`);
for (const [name, unit] of CRAFTED_UNITS) {
  const cells = race(crafted(unit, 262_144), 1_500);
  console.log(`| ${name} | ${cells.map(fmt).join(" | ")} | ${(cells[0]! / cells[1]!).toFixed(2)}x |`);
}
