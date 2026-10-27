/**
 * WorkerPool against the npm worker pools on Bun: tinypool, piscina, workerpool. None is a repo dependency: install
 * them in a scratch directory (`bun add tinypool piscina workerpool` there) and set LIBEVAL to it (default
 * /tmp/claude-0/libeval-arch).
 *
 * Measures each with 3 workers: start-up to the first result, a sequential no-op round trip, the throughput of
 * 32,000 concurrent no-op tasks with the main thread's CPU per task, and the mixed load of bench/load.ts (96 lookup
 * arrivals/s, every item offloaded as its own task, so each library's own batching, or lack of it, shows).
 *
 *   LIBEVAL=/path/to/scratch bun packages/primitives/bench/compare/pool.compare.ts [seconds]
 */
import { sanitizeForStore } from "../../../redact/src/secrets";
import { WorkerPool } from "../../src/pool";
import { HEADER, row, runLoad, setInlineGate } from "../load";

const libs = process.env.LIBEVAL ?? "/tmp/claude-0/libeval-arch";
const seconds = Number(process.argv[2] ?? 8);
const TASKS = new URL("../workers/gate.task.ts", import.meta.url).href;
const WP_WORKER = new URL("./workerpool.worker.ts", import.meta.url).pathname;
setInlineGate(sanitizeForStore);

interface Adapter {
  name: string;
  start(): Promise<{ run(fn: string, input: unknown): Promise<unknown>; close(): Promise<unknown> | void }>;
}

const adapters: Adapter[] = [
  {
    name: "WorkerPool (this repo)",
    async start() {
      const pool = await WorkerPool.start({
        module: TASKS,
        size: 3,
        maxQueue: 100_000,
        maxBatch: 16,
        taskTimeoutMs: Infinity,
        inlineBelow: 0,
      });
      return { run: (fn, input) => pool.run(fn, input), close: () => pool.close() };
    },
  },
  {
    name: "tinypool 2.2.0",
    async start() {
      const { Tinypool } = await import(`${libs}/node_modules/tinypool`);
      const pool = new Tinypool({ filename: TASKS, minThreads: 3, maxThreads: 3 });
      return { run: (fn, input) => pool.run(input, { name: fn }), close: () => pool.destroy() };
    },
  },
  {
    name: "piscina 5.3.2",
    async start() {
      const Piscina = (await import(`${libs}/node_modules/piscina`)).default;
      const pool = new Piscina({ filename: TASKS, minThreads: 3, maxThreads: 3 });
      return { run: (fn, input) => pool.run(input, { name: fn }), close: () => pool.destroy() };
    },
  },
  {
    name: "workerpool 10.0.3",
    async start() {
      const workerpool = await import(`${libs}/node_modules/workerpool`);
      const pool = workerpool.pool(WP_WORKER, { minWorkers: 3, maxWorkers: 3, workerType: "thread" });
      return { run: (fn, input) => pool.exec(fn, [input]), close: () => pool.terminate() };
    },
  },
];

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
console.log(
  "| Pool | start-up to first result | no-op round trip mean / p50 / p99 | 32k no-op tasks: tasks/s | main-thread CPU per task |",
);
console.log("|---|---:|---:|---:|---:|");
const loads: string[] = [];
for (const adapter of adapters.filter((a) => !process.env.ONLY || a.name.startsWith(process.env.ONLY))) {
  try {
    const t0 = performance.now();
    const pool = await adapter.start();
    // workerpool 10.0.3 never answered on Bun 1.4.4 (thread, process and auto workers alike): give up after 5 s.
    const first = await Promise.race([pool.run("noop", 1), Bun.sleep(5_000).then(() => "timeout")]);
    if (first === "timeout") {
      console.log(`| ${adapter.name} | no result within 5 s | | | |`);
      void pool.close();
      continue;
    }
    const startup = performance.now() - t0;
    for (let i = 0; i < 200; i++) await pool.run("noop", i);
    const trips: number[] = [];
    for (let i = 0; i < 2_000; i++) {
      const s = performance.now();
      await pool.run("noop", i);
      trips.push((performance.now() - s) * 1e3);
    }
    trips.sort((a, b) => a - b);
    const mean = trips.reduce((s, x) => s + x, 0) / trips.length;
    const cpu0 = process.threadCpuUsage();
    const b0 = performance.now();
    await Promise.all(Array.from({ length: 32_000 }, (_, i) => pool.run("noop", i)));
    const wall = performance.now() - b0;
    const cpu = process.threadCpuUsage(cpu0);
    console.log(
      `| ${adapter.name} | ${startup.toFixed(1)} ms | ${mean.toFixed(1)} / ${pct(trips, 0.5).toFixed(1)} / ` +
        `${pct(trips, 0.99).toFixed(1)} µs | ${((32_000 / wall) * 1e3).toFixed(0)} | ` +
        `${((cpu.user + cpu.system) / 32_000).toFixed(2)} µs |`,
    );
    const gate = (texts: string[]) => Promise.all(texts.map((t) => pool.run("sanitize", t) as Promise<string>));
    loads.push(row(adapter.name, await runLoad(gate, { seconds, smallPerSecond: 300, lookupsPerSecond: 96, seed: 7 })));
    await pool.close();
  } catch (error) {
    console.log(`| ${adapter.name} | failed: ${String(error).slice(0, 120)} | | | |`);
  }
}
console.log(`\nMixed load, ${seconds} s, 300 small events/s, 96 lookup arrivals/s, every item its own task, 3 workers`);
console.log(HEADER);
for (const line of loads) console.log(line);

// Library workers (workerpool) can keep the process alive after their pool is terminated.
process.exit(0);
