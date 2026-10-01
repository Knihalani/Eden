/**
 * Wave 4.4 — timeout-regime bench.
 *
 * Slow-tool worlds through a positive gate: deopt-claim vs wait-it-out.
 * Prints the number that justifies `DEFAULT_WRAP_TIMEOUT_MS` (60s).
 *
 *   bun run benchmarks/campaign/bench-timeout.ts
 *   bun run benchmarks/campaign/bench-timeout.ts --fast
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_WRAP_TIMEOUT_MS, wrapTimeoutMs } from "@eden/wrap";
import { createState, wrapTools, type ToolDef } from "@eden/wrap";
import { linearProgram } from "./struggle-harness";
import { campaignWrapTimeoutMs } from "./coverage-worlds";

const FAST = process.argv.includes("--fast");

type SweepRow = {
  timeoutMs: number;
  slowMs: number;
  writes: number;
  notified: number;
  deopt: boolean;
  wallMs: number;
  violations: string[];
};

async function runOnce(timeoutMs: number, slowMs: number): Promise<SweepRow> {
  const writes: string[] = [];
  const notified: string[] = [];
  const tools: Record<string, ToolDef> = {
    lookup: { description: "d", execute: async (a) => ({ id: a.id }) },
    applyCredit: {
      description: "Mutating.",
      execute: async (a) => {
        writes.push(String(a.id));
        return { applied: true };
      },
    },
    slowJudge: {
      description: "Judgment slower than a short wrap timeout.",
      execute: async () => {
        await Bun.sleep(slowMs);
        return { ok: true };
      },
    },
    emailCustomer: {
      description: "Mutating.",
      execute: async (a) => {
        notified.push(String(a.id));
        return { emailed: true };
      },
    },
  };
  const prog = linearProgram("p_to", ["lookup", "applyCredit", "slowJudge", "emailCustomer"], { text: true });
  const state = createState({ programs: [prog], timeoutMs });
  const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;
  const t0 = performance.now();
  const head = (await wrapped.lookup!.execute({ id: "T-1", text: "x" })) as Record<string, unknown>;
  await wrapped.applyCredit!.execute({ id: "T-1" });
  await wrapped.emailCustomer!.execute({ id: "T-1" });
  const wallMs = performance.now() - t0;
  const w = writes.filter((x) => x === "T-1").length;
  const n = notified.filter((x) => x === "T-1").length;
  const violations: string[] = [];
  if (w !== 1) violations.push(`applyCredit ${w}x`);
  if (n > 1) violations.push(`email ${n}x`);
  const deopt = Boolean(head && (head as { eden?: string }).eden === "deopt") || n === 0;
  return { timeoutMs, slowMs, writes: w, notified: n, deopt, wallMs, violations };
}

async function toolP99(n: number): Promise<{ p50: number; p99: number }> {
  const samples: number[] = [];
  const ping = async () => {
    const t0 = performance.now();
    await Bun.sleep(8);
    samples.push(performance.now() - t0);
  };
  for (let i = 0; i < n; i++) await ping();
  samples.sort((a, b) => a - b);
  return {
    p50: samples[Math.floor(samples.length * 0.5)]!,
    p99: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))]!,
  };
}

async function main() {
  const probe = campaignWrapTimeoutMs();
  console.log(`Timeout regime — default=${wrapTimeoutMs()} probe=${probe}ms fast=${FAST}`);
  const dist = await toolP99(FAST ? 40 : 200);
  console.log(`fast-tool p50=${dist.p50.toFixed(2)}ms p99=${dist.p99.toFixed(2)}ms (n=${FAST ? 40 : 200} × 8ms sleep)`);

  const slow = FAST ? 80 : 400;
  const sweeps = FAST ? [40, 80, 400, 8_000] : [50, 120, 500, 2_000, 8_000, 60_000];
  const rows: SweepRow[] = [];
  for (const timeoutMs of sweeps) {
    const r = await runOnce(timeoutMs, slow);
    rows.push(r);
    const mark = r.violations.length ? "FAIL" : r.deopt ? "DEOPT-CLAIM" : "COMPLETE";
    console.log(
      `  timeout=${timeoutMs} slow=${slow} → ${mark} writes=${r.writes} notified=${r.notified} wall=${r.wallMs.toFixed(0)}ms`,
    );
    if (r.violations.length) {
      console.error("exactly-once violated", r.violations);
      process.exitCode = 1;
    }
  }

  const complete = rows.find((r) => !r.deopt && r.notified === 1);
  const claim = rows.find((r) => r.deopt && r.writes === 1 && r.notified === 0);
  if (!claim) {
    console.error("no deopt-claim cell — cannot justify a ceiling");
    process.exitCode = 1;
  }
  if (!complete) {
    console.error("no complete cell — timeout never long enough to finish a healthy stretch");
    process.exitCode = 1;
  }

  const tableRows = rows
    .map(
      (r) =>
        `| ${r.timeoutMs} | ${r.writes} | ${r.notified} | ${r.deopt ? "deopt-claim" : "complete"} | ${r.wallMs.toFixed(0)} |`,
    )
    .join("\n");
  const md = `# Timeout default (Wave 4.4)

Measured ${new Date().toISOString()} on this machine. Gated: exactly-once on every sweep cell.

## Fast-tool distribution

Campaign-class tools sleep ~8ms. Measured p50 **${dist.p50.toFixed(2)} ms**, p99 **${dist.p99.toFixed(2)} ms**.

A compiled stretch of 4 such tools is ~${(dist.p99 * 4).toFixed(0)} ms p99. The wrap ceiling must sit **above** that, or healthy stretches deopt after a write (P3 class).

## Sweep (slowJudge = ${slow} ms)

| timeout_ms | writes | notified | class | wall_ms |
|---|---|---|---|---|
${tableRows}

Deopt-claim (timeout < slow) is **correctness-WIN**: applyCredit once, email not guessed. Completing (timeout > slow) is **turns-WIN**: the compiled run finishes.

## Justified default

\`DEFAULT_WRAP_TIMEOUT_MS = ${DEFAULT_WRAP_TIMEOUT_MS}\` (${DEFAULT_WRAP_TIMEOUT_MS / 1000}s).

- Must exceed p99 of a healthy compiled stretch. Campaign p99×4 ≈ ${(dist.p99 * 4).toFixed(0)} ms; production HTTP p99 is seconds.
- 8s is the hook self-cap (R5), a different path.
- 60s matches \`ARM_TTL_MS\` so a settled arming and the run share a clock; the 300s cap remains the hard ceiling.
- Test/campaign probe is \`CAMPAIGN_WRAP_TIMEOUT_MS\` (default ${probe} ms) — **not** the product default. Short timeouts exist to pin P3, not to ship.

Lowering the default to the probe (120 ms) would deopt every compiled stretch whose tools sum past 120 ms. That cell is a LOSS on wall and a correctness-only WIN. The product default stays 60s because the complete-cell at 8s/60s is the gated benefit of waiting for a healthy run.
`;
  const out = resolve(import.meta.dir, "TIMEOUT.md");
  writeFileSync(out, md);
  console.log(`wrote ${out}`);
  console.log(process.exitCode ? "TIMEOUT BENCH FAIL" : "TIMEOUT DEFAULT JUSTIFIED");
}

await main();
