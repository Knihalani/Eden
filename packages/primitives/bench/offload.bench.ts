/**
 * CPU off the event loop: the mixed load of bench/load.ts with each lookup's gate run inline, or in a WorkerPool of
 * 1–3 workers (4 vCPUs: one stays with the event loop), at a moderate and a heavy lookup rate.
 *
 *   bun packages/primitives/bench/offload.bench.ts [seconds] [lookup arrival rates, e.g. 8,32,96]
 */
import { sanitizeForStore } from "../../redact/src/secrets";
import { WorkerPool } from "../src/pool";
import { HEADER, row, runLoad, setInlineGate, type Gate } from "./load";

const seconds = Number(process.argv[2] ?? 8);
const MODULE = new URL("./workers/gate.task.ts", import.meta.url).href;
setInlineGate(sanitizeForStore);

const inline: Gate = async (texts) => texts.map(sanitizeForStore);

async function pooled(size: number, inlineBelow: number): Promise<{ gate: Gate; pool: WorkerPool }> {
  const pool = await WorkerPool.start({
    module: MODULE,
    size,
    maxQueue: 4_096,
    maxBatch: 16,
    taskTimeoutMs: 5_000,
    inlineBelow,
  });
  // Warm each worker: compile the rules its texts will need and let the JIT see the gate.
  await Promise.all(
    Array.from({ length: size * 8 }, (_, i) => pool.run("sanitize", `warm-up ${i} api key token secret`)),
  );
  const gate: Gate = (texts) => Promise.all(texts.map((t) => pool.runOrInline<string>("sanitize", t, t.length)));
  return { gate, pool };
}

// Warm the main thread's gate the same way.
for (let i = 0; i < 200; i++) sanitizeForStore(`warm-up ${i} api key token secret ${"x".repeat(i * 10)}`);

const rates = (process.argv[3] ?? "8,32,96").split(",").map(Number);
for (const lookupsPerSecond of rates) {
  const config = { seconds, smallPerSecond: 300, lookupsPerSecond, seed: 7 };
  const what = `${lookupsPerSecond} lookup arrivals/s (20% bursts of 4), 32 items each`;
  console.log(`\n${seconds} s, 300 small events/s, ${what}`);
  console.log(HEADER);
  console.log(row("inline", await runLoad(inline, config)));
  for (const [size, inlineBelow] of [
    [1, 1_024],
    [2, 1_024],
    [3, 1_024],
    [3, 0],
  ] as const) {
    const { gate, pool } = await pooled(size, inlineBelow);
    console.log(
      row(`pool ${size} worker${size > 1 ? "s" : ""}, inline < ${inlineBelow} chars`, await runLoad(gate, config)),
    );
    pool.close();
  }
}
