/**
 * POC C — Deterministic-first islands: skip the glue LLM call when witnesses
 * already know the answer.
 *
 * Compiled programs can include an "island" step — semantic glue resolved at
 * runtime by a small LLM (gpt-4o-mini, temp 0; wrap/src/island.ts). But a
 * compiled tool comes with WITNESSES: recordings of past runs. When the same
 * island input appeared ≥2 times across witnesses and produced the SAME
 * output every time, the mapping is not semantic anymore — it is a lookup.
 * Calling an LLM to look up an answer you already have is pure waste.
 *
 * Proposed decorator over the REAL openaiIsland: check the witness map first;
 * on miss (or on disagreement between witnesses), fall back to the live call
 * and record the answer for next time.
 *
 * Benchmark: real openaiIsland wrapped with an injected fake fetch that adds
 * realistic latency + cost accounting, driven through both strategies.
 */
import { describe, expect, test } from "bun:test";
import { openaiIsland } from "../../packages/wrap/src/island.ts";
import type { IslandCaller } from "../../packages/ir";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/14

const CALL_MS = 350; // gpt-4o-mini typical p50 for tiny JSON tasks
const COST_PER_CALL_CENTS = 0.015; // ~600 in / 60 out tokens

function fakeFetchWithLatency(ms: number): typeof fetch {
  return async (_url, init) => {
    await new Promise((r) => setTimeout(r, ms));
    const body = JSON.parse(String((init as RequestInit).body));
    const user = JSON.parse(body.messages[1].content);
    // The "model": pick the longest repo name's owner. Deterministic task.
    const repos: string[] = user.repos ?? [];
    const owner = repos.sort((a: string, b: string) => b.length - a.length)[0]?.split("/")[0] ?? "unknown";
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ owner }) } }] }), {
      status: 200,
    });
  };
}

/** Witness map: input fingerprint -> { output, seen } from recorded runs. */
class WitnessTable {
  private m = new Map<string, { out: unknown; seen: number }>();
  observe(input: unknown, out: unknown): void {
    const k = JSON.stringify(input);
    const e = this.m.get(k);
    if (!e) this.m.set(k, { out, seen: 1 });
    else if (JSON.stringify(e.out) === JSON.stringify(out)) e.seen++;
  }
  /** Confident only when the same input produced the same output >=2 times. */
  lookup(input: unknown): unknown | undefined {
    const e = this.m.get(JSON.stringify(input));
    return e && e.seen >= 2 ? e.out : undefined;
  }
}

function deterministicFirst(base: IslandCaller, witnesses: WitnessTable): IslandCaller {
  return async (req) => {
    const hit = witnesses.lookup(req.input);
    if (hit !== undefined) return hit;
    const out = await base(req);
    witnesses.observe(req.input, out);
    return out;
  };
}

describe("POC C — deterministic-first islands", () => {
  test.failing("witnessed mappings never reach the LLM; unseen ones fall back safely", async () => {
    const calls = { n: 0 };
    const base = openaiIsland({
      fetch: async (...a) => {
        calls.n++;
        return fakeFetchWithLatency(CALL_MS)(...a);
      },
    });

    // Witnesses recorded twice each from past runs.
    const w = new WitnessTable();
    w.observe({ repos: ["acme/app", "acme/infra-long-name"] }, { owner: "acme" });
    w.observe({ repos: ["acme/app", "acme/infra-long-name"] }, { owner: "acme" });

    const fast = deterministicFirst(base, w);

    const t0 = Date.now();
    const r1 = await fast({
      system: "s",
      input: { repos: ["acme/app", "acme/infra-long-name"] },
      outputSchema: {},
    } as never);
    const witnessedMs = Date.now() - t0;

    const t1 = Date.now();
    const r2 = await fast({ system: "s", input: { repos: ["other/one-repo"] }, outputSchema: {} } as never);
    const fallbackMs = Date.now() - t1;

    expect(r1).toEqual({ owner: "acme" }); // served from witnesses
    expect(r2).toEqual({ owner: "other" }); // fell back to the live call
    expect(calls.n).toBe(1); // exactly one live call total
    const clock = Number(process.env.EDEN_FLAKE_CLOCK_SCALE ?? "1");
    const scale = Number.isFinite(clock) && clock > 0 ? clock : 1;
    expect(witnessedMs).toBeLessThan(10 * Math.max(1, scale)); // lookup, not CALL_MS
    expect(fallbackMs).toBeGreaterThanOrEqual(CALL_MS * 0.8 * scale);
  });

  test("batch economics: witnessed inputs never pay the LLM tax", async () => {
    const calls = { n: 0 };
    const base = openaiIsland({
      fetch: async (...a) => {
        calls.n++;
        return fakeFetchWithLatency(CALL_MS)(...a);
      },
    });
    const w = new WitnessTable();
    const inputs = Array.from({ length: 10 }, (_, i) => ({ repos: [`acme/r${i}`, `zzz/long-${i}`] }));
    for (const inp of inputs) {
      w.observe(inp, { owner: "zzz" });
      w.observe(inp, { owner: "zzz" });
    }
    const fast = deterministicFirst(base, w);

    // Baseline: always-LLM, 25 calls.
    let t = Date.now();
    for (let i = 0; i < 25; i++) await base({ system: "s", input: inputs[i % 10], outputSchema: {} } as never);
    const baselineMs = Date.now() - t;
    const callsBaseline = calls.n;

    // Proposed steady state: same workload, all inputs witnessed -> zero live calls.
    calls.n = 0;
    let t2 = Date.now();
    for (let i = 0; i < 25; i++) await fast({ system: "s", input: inputs[i % 10], outputSchema: {} } as never);
    const steadyMs = Date.now() - t2;
    const callsProposed = calls.n;

    const savingsPct = 100 * (1 - steadyMs / baselineMs);
    console.log("");
    console.log(`    baseline (always-LLM):   ${baselineMs.toFixed(0)} ms, ${callsBaseline} live calls`);
    console.log(`    proposed (steady state): ${steadyMs.toFixed(2)} ms, ${callsProposed} live calls`);
    console.log(
      `    latency saved: ${savingsPct.toFixed(1)}%  ·  cost saved @ $${COST_PER_CALL_CENTS.toFixed(3)}/call: $${((callsBaseline - callsProposed) * COST_PER_CALL_CENTS).toFixed(3)} per 25 steps`,
    );
    expect(savingsPct).toBeGreaterThan(95);
    expect(callsProposed).toBe(0);
  }, 20_000);
});
