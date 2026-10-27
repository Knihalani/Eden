/**
 * Compiler wall: cold compileTraces vs remine cache, plus ETL quality.
 *
 *   bun packages/compile/src/time-500.ts
 *
 * After warmup, median of three *distinct* 500-trace batches is the cold
 * number (budget ≤2000). Each timed call is compileTraces only — synth of
 * the batch happens first and is not on the clock. Repeating the same batch
 * is remine and is printed separately — it is not the ship gate. 2000-trace
 * cold is the median of three distinct salts. etl80×18 must stay seqLen 20.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const lines: string[] = [];
function emit(s: string) {
  console.log(s);
  lines.push(s);
}

function timed(label: string, fn: () => unknown) {
  const t0 = performance.now();
  const r = fn();
  const ms = performance.now() - t0;
  emit(`${label}\t${ms.toFixed(2)} ms`);
  return { ms, r };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

function writeCapture(name: string, text: string) {
  const dir = join(import.meta.dir, "../../../.gauntlet/captures/compile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text.endsWith("\n") ? text : `${text}\n`);
}

timed("warmup", () => compileTraces(synth(40, 12, 7)));

const cold500: number[] = [];
for (let i = 0; i < 3; i++) {
  const batch = synth(500, 12, i);
  cold500.push(timed(`synth500 cold salt${i}`, () => compileTraces(batch)).ms);
}
const cold500Med = median(cold500);
emit(`synth500_first_ms=${cold500[0]!.toFixed(2)} (honest first distinct batch after warmup; not the median)`);
emit(`synth500_cold median_ms=${cold500Med.toFixed(2)} budget_ms=2000`);

const same = synth(500, 12, 99);
timed("synth500 remine first", () => compileTraces(same));
const remine = timed("synth500 remine second", () => compileTraces(same)).ms;
emit(`synth500_remine_ms=${remine.toFixed(2)}`);

const cold2000: number[] = [];
for (let i = 0; i < 3; i++) {
  const batch = synth(2000, 12, 100 + i);
  cold2000.push(timed(`synth2000 cold salt${i}`, () => compileTraces(batch)).ms);
}
const cold2000Med = median(cold2000);
emit(`synth2000_cold median_ms=${cold2000Med.toFixed(2)}`);
emit(`synth2000_over_500x=${(cold2000Med / Math.max(cold500Med, 0.01)).toFixed(2)}`);

const b = etlWidth(80, 18);
const etl = compileTraces(b);
emit(
  `etl80x18 default programs=${etl.programs.length} refusals=${etl.refusals.length} ` +
    `seqLens=${etl.programs.map((p) => p.sequence?.length).join(",")} ` +
    `unbound=${etl.refusals.filter((r) => r.reason.includes("without a bindable foreach")).length}`,
);

writeCapture("time-500.txt", lines.join("\n"));
writeCapture(
  "time-scale.txt",
  lines.filter((l) => l.includes("synth500") || l.includes("synth2000") || l.startsWith("etl")).join("\n"),
);

if (cold500Med > 2000) process.exit(1);
if (cold2000Med > 2500) process.exit(1);
if (
  etl.programs[0]?.sequence?.length !== 20 ||
  etl.refusals.some((r) => r.reason.includes("without a bindable foreach"))
) {
  process.exit(1);
}
