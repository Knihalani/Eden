/**
 * Long-run soak: repeated record -> compile -> shadow -> steer lifecycles
 * across all worlds, watching for the failures that only show up with volume:
 *
 *   - unbounded growth (trace buffers, receipt lists, arming maps, heap),
 *   - correctness drift after many steering rounds,
 *   - degradation of the compile/shadow pipeline as state accumulates.
 *
 * Not part of `bun test` (it runs for minutes by design):
 *   bun run benchmarks/campaign/soak.ts [--minutes 5]
 */
import { Session, type WorldFactory } from "./session";
import {
  DESK_IDS,
  INCIDENT_KEYS,
  ORDER_IDS,
  RESEARCH_TOPICS,
  blockSeed,
  createDesk,
  createEtl,
  createIncident,
  createOrders,
  createResearch,
} from "./worlds";

const MINUTES = Number(process.argv.includes("--minutes") ? process.argv[process.argv.indexOf("--minutes") + 1] : 3);
process.env.CAMPAIGN_THINK_MS = "2";

const FACTORIES: Array<[string, WorldFactory]> = [
  ["desk", createDesk],
  ["orders", createOrders],
  ["etl", () => createEtl(6)],
  ["incident", () => createIncident(0.08)],
  ["research", createResearch],
];
const POOLS: Record<string, Array<Record<string, unknown>>> = {
  desk: [...DESK_IDS].map((id) => ({ id })),
  orders: [...ORDER_IDS].map((orderId) => ({ orderId })),
  etl: ["R-S1", "R-S2", "R-S3", "R-S4"].map((run) => ({ run })),
  incident: [...INCIDENT_KEYS].map((key) => ({ key })),
  research: [...RESEARCH_TOPICS].map((topic) => ({ topic })),
};

async function main() {
  const deadline = Date.now() + MINUTES * 60_000;
  let round = 0;
  const heapSamples: number[] = [];
  let totalTurns = 0;
  let totalStretches = 0;
  let totalExecs = 0;
  let goLives = 0;
  let goLivePass = 0;
  const violations: string[] = [];
  const goLiveByWorld = new Map<string, { pass: number; total: number }>();
  const gcRuns: number[] = [];

  console.log(`soak: running for ${MINUTES}min across ${FACTORIES.length} worlds`);
  while (Date.now() < deadline) {
    round++;
    const [worldName, factory] = FACTORIES[round % FACTORIES.length]!;
    const pool = POOLS[worldName]!;
    const s = new Session([[worldName, factory]], true);
    // Witness phase cycles the pool so envelopes cover it.
    const nWitness = 13;
    for (let i = 0; i < nWitness; i++) {
      await s.stretch(worldName, pool[i % pool.length]!, blockSeed(`soak-${round}`, i));
    }
    const r = await s.goLive(worldName, { compile: 9, holdout: 3, sandbox: factory, maxGram: 26 });
    goLives++;
    if (r.program) goLivePass++;
    const g = goLiveByWorld.get(worldName) ?? { pass: 0, total: 0 };
    g.total++;
    if (r.program) g.pass++;
    goLiveByWorld.set(worldName, g);
    const liveN = 4;
    for (let i = 0; i < liveN; i++) {
      await s.stretch(worldName, pool[(i + 1) % pool.length]!, blockSeed(`soak-${round}-live`, 100 + i));
    }
    const st = s.finish();
    totalTurns += st.turns;
    totalStretches += st.stretches;
    totalExecs += st.rawExecutions;
    if (st.violations.length) violations.push(...st.violations.slice(0, 3));

    if (round % 2 === 0) {
      if (globalThis.gc) globalThis.gc();
      const heap = process.memoryUsage().heapUsed / 1024 / 1024;
      heapSamples.push(heap);
      gcRuns.push(round);
      process.stdout.write(
        `  round ${round}: heap ${heap.toFixed(1)}MB, turns ${totalTurns}, execs ${totalExecs}, goLive ` +
          `${goLivePass}/${goLives}\n`,
      );
    }
  }

  // Growth check: drop the first third (interpreter warm-up), compare the
  // middle third against the last third with several samples each. Steady
  // state should be flat; anything monotonically climbing is a leak.
  const third = Math.max(1, Math.floor(heapSamples.length / 3));
  const early = heapSamples.slice(third, 2 * third);
  const late = heapSamples.slice(-third);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const drift = mean(late) - mean(early);
  const growthPct = early.length ? (drift / mean(early)) * 100 : 0;

  console.log("\n==================== SOAK SUMMARY ====================");
  console.log(`rounds=${round} stretches=${totalStretches} agent-turns=${totalTurns} tool-executions=${totalExecs}`);
  console.log(`goLive PASS rate: ${goLivePass}/${goLives}`);
  for (const [w, ok] of goLiveByWorld) console.log(`  ${w}: ${ok.pass}/${ok.total} certified`);
  const canForceGC = typeof globalThis.gc === "function";
  console.log(
    `heap: early(mean of ${early.length}) ${mean(early).toFixed(1)}MB -> late ` +
      `${mean(late).toFixed(1)}MB (${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(1)}%)` +
      (canForceGC ? "" : " [UNFORCED GC — growth number is not a leak signal; run with bun --expose-gc]"),
  );
  console.log(`violations: ${violations.length === 0 ? "none" : ""}`);
  for (const v of violations.slice(0, 10)) console.log(`  - ${v}`);
  const ok = violations.length === 0 && (!canForceGC || growthPct < 50) && goLivePass > 0;
  console.log(ok ? "SOAK OK" : "SOAK FAIL");
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
