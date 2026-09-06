import { createState, wrapTools } from "../index";
import { compileTraces } from "../../../compile/src/index";
import type { StretchTrace } from "@eden/ir";

const MB = 1024 * 1024;
function rss(): number {
  return process.memoryUsage.rss() / MB;
}
function line(s: string): void {
  console.log(s);
}

async function sustainedThroughput(): Promise<void> {
  line("\n═══ 1. SUSTAINED THROUGHPUT (30s mixed workload) ═══");
  const rand = (() => {
    let s = 12345 >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0xffffffff);
  })();
  const state = createState({ programs: [] });
  const tools = wrapTools(
    {
      read_thing: async (a: Record<string, unknown>) => ({
        id: a.id,
        rows: Array.from({ length: 5 }, (_, i) => ({ i, v: Math.floor(rand() * 1000) })),
      }),
      write_thing: async (a: Record<string, unknown>) => ({ written: a.id }),
      failing: async () => {
        if (rand() < 0.15) throw new Error("transient");
        return { ok: true };
      },
      slow: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { done: true };
      },
    },
    state,
  );
  const DURATION_MS = 30_000;
  let ops = 0;
  let errors = 0;
  const latencies: number[] = [];
  const t0 = Date.now();
  let lastReport = t0;
  while (Date.now() - t0 < DURATION_MS) {
    const pick = rand();
    const s0 = performance.now();
    try {
      if (pick < 0.4) await tools.read_thing.execute({ id: ops });
      else if (pick < 0.6) await tools.write_thing.execute({ id: ops });
      else if (pick < 0.75) await tools.failing.execute({});
      else await tools.slow.execute({});
      ops++;
    } catch {
      errors++;
      ops++; // failing calls still complete the loop
    }
    latencies.push(performance.now() - s0);
    if (Date.now() - lastReport > 10_000) {
      line(`  …${ops} ops @ ${((Date.now() - t0) / 1000).toFixed(0)}s, rss ${rss().toFixed(0)}MB`);
      lastReport = Date.now();
    }
  }
  latencies.sort((a, b) => a - b);
  const secs = (Date.now() - t0) / 1000;
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]!.toFixed(2);
  line(`  ops/sec: ${(ops / secs).toFixed(0)} over ${secs.toFixed(1)}s`);
  line(`  errors: ${errors} (${((errors / ops) * 100).toFixed(1)}% of completed ops)`);
  line(`  latency p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms max=${latencies.at(-1)!.toFixed(1)}ms`);
  line(`  rss end: ${rss().toFixed(0)}MB`);
}

// ─── 2. Memory soak ──────────────────────────────────────────────────────────
async function memorySoak(): Promise<void> {
  line("\n═══ 2. MEMORY SOAK (10k payload calls) ═══");
  const state = createState({ programs: [] });
  const tools = wrapTools(
    { record: async (a: Record<string, unknown>) => ({ echoLen: JSON.stringify(a).length }) },
    state,
  );
  // Warm-up to settle JIT allocations.
  for (let i = 0; i < 200; i++) await tools.record.execute({ n: i });
  if (globalThis.gc) globalThis.gc();
  const before = rss();
  const samples: number[] = [];
  const CALLS = Number(process.env.EDEN_SOAK_CALLS) || 10_000;
  line(`  calls: ${CALLS}`);
  for (let i = 0; i < CALLS; i++) {
    await tools.record.execute({
      n: i,
      payload: "p".repeat(300),
      nested: { a: [1, 2, 3], b: { c: "d" } },
    });
    if (i % 2000 === 1999) {
      if (globalThis.gc) globalThis.gc();
      samples.push(rss());
    }
  }
  if (globalThis.gc) globalThis.gc();
  const after = rss();
  const drift = after - before;
  line(`  rss before: ${before.toFixed(0)}MB after: ${after.toFixed(0)}MB drift: ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}MB`);
  line(`  midpoint samples: ${samples.map((s) => s.toFixed(0)).join(" → ")}MB`);
  line(`  verdict: ${drift < 50 ? "BOUNDED" : "GROWTH SUSPECT — investigate"}`);
}

// ─── 3. Compile-time scaling ────────────────────────────────────────────────
function makeTraces(n: number, seed: number): StretchTrace[] {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0xffffffff);
  return Array.from({ length: n }, (_, i) => {
    const id = `T-${i}`;
    return {
      id: `t${i}`,
      llmCalls: 4,
      duration_ms: 400,
      cost_cents: 2,
      input: { id },
      output: { shipped: true },
      events: [
        { name: "lookup", args: { id }, result: { found: true }, ok: true },
        { name: "enrich", args: { id }, result: { score: Math.floor(rand() * 100) }, ok: true },
        { name: "respond", args: { id }, result: { sent: true }, ok: true },
      ],
      complete: true,
    } as unknown as StretchTrace;
  });
}
async function compileScaling(): Promise<void> {
  line("\n═══ 3. COMPILE SCALING (witnesses → time) ═══");
  for (const n of [10, 25, 50, 100, 250, 500]) {
    const traces = makeTraces(n, n);
    const t0 = performance.now();
    const out = compileTraces(traces);
    const ms = performance.now() - t0;
    line(`  ${String(n).padStart(4)} witnesses → ${ms.toFixed(0).padStart(5)}ms | ${out.programs.length} programs, ${out.refusals.length} refusals`);
  }
}

function rawOk(out: Record<string, unknown> | undefined): boolean {
  return !!out && (out as { found?: boolean }).found === true;
}

// ─── 4. Steering accuracy under noise ────────────────────────────────────────
async function steeringAccuracy(): Promise<void> {
  line("\n═══ 4. STEERING ACCURACY (randomized, 40 trials) ═══");
  let truePositive = 0;
  let falseSteer = 0;
  let miss = 0;
  let totalInEnvelope = 0;
  let totalOutOfEnvelope = 0;
  for (let trial = 0; trial < 40; trial++) {
    const id = `T-${trial}`;
    // Three witnessed ids so the envelope has real distribution.
    const ids = [`T-${trial}-a`, `T-${trial}-b`, `T-${trial}-c`];
    const traces: StretchTrace[] = ids.map((wid) => ({
      id: `t-${wid}`,
      llmCalls: 4,
      duration_ms: 400,
      cost_cents: 2,
      input: { id: wid },
      output: { sent: true },
      events: [
        { name: "lookup", args: { id: wid }, result: { found: true }, ok: true },
        { name: "enrich", args: { id: wid }, result: { score: 5 }, ok: true },
        { name: "respond", args: { id: wid }, result: { sent: true }, ok: true },
      ],
      complete: true,
    }) as unknown as StretchTrace);
    const mined = compileTraces(traces);
    const prog = mined.programs[0];
    if (!prog) continue;
    // compileTraces leaves manifest null (approval happens elsewhere); the
    // wrap layer requires it before steering. Simulate approval.
    const manifestProg = {
      ...prog,
      manifest: { llmReduction: 8, latencyReduction: 8, costReduction: 8, skipRateBefore: 0.2, skipRateAfter: 0, nShadow: 6 },
    } as typeof prog;
    const state = createState({ programs: [manifestProg] });
    const ran: Record<string, number> = { lookup: 0, enrich: 0, respond: 0 };
    const mk = (name: string, val: unknown) => async (a: Record<string, unknown>) => {
      ran[name] = (ran[name] ?? 0) + 1;
      return val;
    };
    const tools = wrapTools(
      {
        lookup: mk("lookup", { found: true }),
        enrich: mk("enrich", { score: 5 }),
        respond: mk("respond", { sent: true }),
      },
      state,
    );
    // In-envelope call: prefix-hit → compiled run executes ALL THREE steps via
    // the registry and returns the LAST step's value. A miss would return the
    // raw lookup value instead. A correct steer also means every step ran
    // exactly ONCE (no raw replay after the compiled leg).
    const out = (await tools.lookup.execute({ id: ids[0] })) as Record<string, unknown>;
    if (
      out.sent === true &&
      ran.lookup === 1 &&
      ran.enrich === 1 &&
      ran.respond === 1
    ) {
      truePositive++;
    } else if (out.found === true) {
      miss++;
    } else {
      miss++; // structured deopt / refusal: safe, but not a steer
    }

    // Out-of-envelope call on a fresh state: must NOT interfere at all.
    const state2 = createState({ programs: [manifestProg] });
    const ran2: Record<string, number> = { lookup: 0, enrich: 0, respond: 0 };
    const mk2 = (name: string, val: unknown) => async (a: Record<string, unknown>) => {
      ran2[name] = (ran2[name] ?? 0) + 1;
      return val;
    };
    const tools2 = wrapTools(
      {
        lookup: mk2("lookup", { found: true }),
        enrich: mk2("enrich", { score: 5 }),
        respond: mk2("respond", { sent: true }),
      },
      state2,
    );
    const out2 = (await tools2.lookup.execute({ id: `UNKNOWN-${trial}` })) as Record<string, unknown>;
    if (rawOk(out2) && ran2.lookup === 1 && ran2.enrich === 0 && ran2.respond === 0) {
      // Correctly left alone: raw ran once, nothing else fired.
    } else {
      falseSteer++;
    }
    totalInEnvelope++;
    totalOutOfEnvelope++;
  }
  line(`  in-envelope trials: ${totalInEnvelope} | steered correctly: ${truePositive} | missed: ${miss}`);
  line(`  out-of-envelope trials: ${totalOutOfEnvelope} | wrongly interfered: ${falseSteer}`);
  line(`  steer precision: ${totalInEnvelope ? ((truePositive / totalInEnvelope) * 100).toFixed(1) : "n/a"}% | interference rate: ${((falseSteer / totalOutOfEnvelope) * 100).toFixed(1)}%`);
}

// ─── 5. Multi-session isolation ─────────────────────────────────────────────
async function multiSession(): Promise<void> {
  line("\n═══ 5. MULTI-SESSION ISOLATION (3 concurrent agents × 20 calls) ═══");
  const sessions = ["alice", "bob", "carol"].map((who) => {
    const state = createState({ programs: [] });
    const seen: number[] = [];
    const tools = wrapTools(
      { act: async (a: Record<string, unknown>) => ({ who, n: a.n }) },
      state,
    ) as Record<string, { execute: (a: Record<string, unknown>) => Promise<{ n: number }> }>;
    return { who, seen, tools };
  });
  await Promise.all(
    sessions.flatMap((s) =>
      Array.from({ length: 20 }, (_, i) =>
        s.tools.act!.execute({ n: i }).then((r) => {
          s.seen.push((r as { n: number }).n);
        }),
      ),
    ),
  );
  for (const s of sessions) {
    const unique = new Set(s.seen);
    line(`  ${s.who}: ${s.seen.length}/20 calls, ${unique.size} unique results`);
    expect(unique.size).toBe(20);
  }
  line("  no cross-session bleed detected");
}

// ─── run all ─────────────────────────────────────────────────────────────────
import { expect } from "bun:test";
await sustainedThroughput();
await memorySoak();
await compileScaling();
await steeringAccuracy();
await multiSession();
line("\n═══ SOAK COMPLETE ═══");
