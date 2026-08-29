/**
 * Wave 3 shipped bench: compileTraces wall on 500 traces.
 *
 *   bun packages/compile/src/time-500.ts
 *
 * Prints median ms for synth500 (budget ≤2000) and ETL width-18 quality
 * (seqLen and refusal count) at the auto maxGram default.
 */
import { compileTraces } from "./index.ts";
import { etlWidth } from "./corpus/fixtures.ts";
import type { StretchTrace } from "@eden/ir";

function synth(n: number, len: number, salt: number): StretchTrace[] {
  const tools = [
    "lookup",
    "fetchDetails",
    "parseFields",
    "validate",
    "draftReply",
    "writeRecord",
    "verifyWrite",
    "notify",
    "tagItem",
    "closeItem",
  ];
  return Array.from({ length: n }, (_, i) => ({
    id: `s${salt}-${i}`,
    llmCalls: len,
    duration_ms: 10 * len,
    cost_cents: len,
    input: { id: `X-${i}`, tag: `T${i % 3}` },
    events: Array.from({ length: len }, (_, j) => ({
      name: tools[(j + salt) % tools.length]!,
      args: { id: `X-${i}`, seq: j, tag: `T${i % 3}` },
      result: { ok: true, id: `X-${i}`, n: j, nested: { deep: `d${i}` } },
      ok: true,
    })),
  }));
}

function timed(label: string, fn: () => unknown) {
  const t0 = performance.now();
  const r = fn();
  const ms = performance.now() - t0;
  console.log(`${label}\t${ms.toFixed(2)} ms`);
  return { ms, r };
}

const a = synth(500, 12, 0);
const b = etlWidth(80, 18);
const samples: number[] = [];
for (let i = 0; i < 3; i++) {
  samples.push(timed(`synth500 default  run${i + 1}`, () => compileTraces(a)).ms);
}
samples.sort((x, y) => x - y);
console.log(`synth500 median_ms=${samples[1]!.toFixed(2)} budget_ms=2000`);
const etl = compileTraces(b);
console.log(
  `etl80x18 default programs=${etl.programs.length} refusals=${etl.refusals.length} seqLens=${etl.programs.map((p) => p.sequence?.length).join(",")} unbound=${etl.refusals.filter((r) => r.reason.includes("without a bindable foreach")).length}`,
);
if (samples[1]! > 2000) process.exit(1);
if (etl.programs[0]?.sequence?.length !== 20 || etl.refusals.some((r) => r.reason.includes("without a bindable foreach"))) {
  process.exit(1);
}
