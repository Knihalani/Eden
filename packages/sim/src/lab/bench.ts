#!/usr/bin/env bun
/**
 * Runs the free tiers of the benchmark (bench/README.md) on the current tree and records each in the ledger:
 *
 * - funnel: the hidden-context suites (dev and held-out) through Eden alone (`hidden-funnel.ts`);
 * - sim: simulation quality on the realistic and held-out connector mixes, no judge and the perfect judge
 *   (`quality-cli.ts`), every seed's report kept as a row;
 * - eval: the scenario eval, no model.
 *
 * None of it calls a model or costs anything. The live tier is `agent-ab.ts` then `agent-ab-report.ts --record`.
 *
 *   bun packages/sim/src/lab/bench.ts --label probes --config '{"probes":true}' [--seeds 41,42,43,44] [--quick]
 */
import { join } from "node:path";
import { record, tidy } from "./ledger";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const LABEL = opt("label", "baseline");
const CONFIG = opt("config", "{}");
const SEEDS = opt("seeds", "41,42,43,44").split(",");
const QUICK = args.includes("--quick");
const ROOT = join(import.meta.dir, "..", "..", "..", "..");

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENROUTER_API_KEY: "" },
  });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0)
    throw new Error(`${cmd.slice(0, 4).join(" ")} failed: ${await new Response(p.stderr).text()}`);
  return out;
};
const json = (s: string) => JSON.parse(s.slice(s.indexOf("{")));

// Funnel: both suites.
for (const suite of ["hidden", "heldout"]) {
  const out = await run([
    "bun",
    "packages/sim/src/lab/hidden-funnel.ts",
    "--suite",
    suite,
    "--seeds",
    SEEDS.join(","),
    "--config",
    CONFIG,
    "--label",
    LABEL,
  ]);
  console.log(`funnel ${suite}: ${out.trim().split("\n").at(-2)}`);
}

// Simulation quality: per mix and judge, every seed's report kept as a row; summary over the seeds.
const mixes = QUICK ? ["realistic"] : ["realistic", "zoo-a", "zoo-b"];
for (const profile of mixes) {
  for (const judge of ["none", "perfect"]) {
    const t0 = performance.now();
    const reports = await Promise.all(
      SEEDS.map(async (seed) => {
        const r = json(
          await run([
            "bun",
            "packages/sim/src/quality-cli.ts",
            "--profile",
            profile,
            "--seed",
            seed,
            "--planner",
            "--judge",
            judge,
            "--config",
            CONFIG,
          ]),
        );
        return { seed: Number(seed), r };
      }),
    );
    const sum = (f: (r: any) => number) => reports.reduce((n, x) => n + f(x.r), 0);
    const avg = (f: (r: any) => number) => sum(f) / reports.length;
    const counts = (k: string) => sum((r) => r.overall.counts[k] ?? 0);
    const metrics: Record<string, number> = {
      recall: counts("mustDelivered") / Math.max(1, counts("mustFacts")),
      precision:
        counts("relevant") /
        Math.max(
          1,
          sum((r) => r.overall.delivered),
        ),
      hardFalseFires: counts("falseFires"),
      silentTurns: counts("silentTurns"),
      softFireRate: avg((r) => r.overall.softFireRate ?? 0),
      modelCallsPerTurn: avg((r) => r.model.callsPerTurn),
      sourceCallsPerLookup: avg((r) => r.sources.callsPerLookup),
      observeP50Ms: avg((r) => r.latency.observeP50Ms),
      observeP95Ms: avg((r) => r.latency.observeP95Ms),
      deliveryP95Ms: avg((r) => r.latency.deliveryP95Ms),
      injectionBytesP50: avg((r) => r.injectionBytesP50),
      redundantShare: avg((r) => r.redundantShare ?? 0),
      noiseShare: avg((r) => r.noiseShare ?? 0),
      askRecallAt5: avg((r) => r.ask?.recallAt5 ?? 0),
    };
    const reasons = new Map<string, { d: number; r: number }>();
    for (const { r } of reports) {
      for (const [k, v] of Object.entries(r.byReason ?? {}) as [string, { delivered: number; relevant: number }][]) {
        const x = reasons.get(k) ?? { d: 0, r: 0 };
        x.d += v.delivered;
        x.r += v.relevant;
        reasons.set(k, x);
      }
    }
    for (const [k, v] of reasons) {
      metrics[`delivered.${k}`] = v.d;
      metrics[`precision.${k}`] = v.r / Math.max(1, v.d);
    }
    const e = record(
      {
        tier: "sim",
        suite: `${profile}/${judge}`,
        label: LABEL,
        config: JSON.parse(CONFIG),
        seeds: SEEDS.map(Number),
        costUsd: 0,
        wallSeconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
        metrics: tidy(metrics),
      },
      reports.map(({ seed, r }) => ({
        seed,
        overall: r.overall,
        model: r.model,
        sources: r.sources,
        latency: r.latency,
        byReason: r.byReason,
        ask: r.ask,
        funnel: r.funnel,
      })),
    );
    console.log(
      `sim ${profile}/${judge}: recall ${metrics.recall!.toFixed(3)} precision ${metrics.precision!.toFixed(3)} ` +
        `hardFF ${metrics.hardFalseFires}/${metrics.silentTurns} calls/lookup ${metrics.sourceCallsPerLookup!.toFixed(2)} → ${e.id}`,
    );
  }
}

// Eval, no model.
{
  const t0 = performance.now();
  const m = json(await run(["bun", "packages/eval/src/cli.ts", "--config", CONFIG]));
  const metrics: Record<string, number> = {
    precision: m.precision,
    recall: m.recall,
    falseFireRate: m.falseFireRate,
    scoredTurns: m.scoredTurns,
    latencyP50Ms: m.latencyP50Ms,
    latencyP95Ms: m.latencyP95Ms,
    secretsLeaked: m.privacy?.secretsLeaked ?? 0,
    notInert: m.privacy?.notInert ?? 0,
    askRecall: m.ask?.recall ?? 0,
  };
  for (const [cat, v] of Object.entries(m.byCategory ?? {}) as [string, any][]) {
    metrics[`${cat}.recall`] = v.recall;
    metrics[`${cat}.precision`] = v.precision;
    metrics[`${cat}.falseFireRate`] = v.falseFireRate;
  }
  const e = record(
    {
      tier: "eval",
      suite: "scenarios",
      label: LABEL,
      config: JSON.parse(CONFIG),
      seeds: [],
      costUsd: 0,
      wallSeconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
      metrics: tidy(metrics),
    },
    [m],
  );
  console.log(
    `eval: recall ${m.recall.toFixed(3)} precision ${m.precision} falseFireRate ${m.falseFireRate} → ${e.id}`,
  );
}
