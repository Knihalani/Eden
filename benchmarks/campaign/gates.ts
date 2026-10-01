/**
 * Shared gated-scenario machinery for both campaigns (positive and negative
 * controls). Every scenario is paired by (task, repeat), counterbalanced, and
 * decided by @eden/measure's decide(). Losses and violations set exit codes;
 * INDISTINGUISHABLE is allowed and reported.
 */
import { decide, runPlan, type Decision, type Sample } from "@eden/measure";

export const FAST = process.argv.includes("--fast");

export type Metric = "turns" | "wall_ms" | "cents";
export const METRICS: Metric[] = ["turns", "wall_ms", "cents"] as const;

export type ArmStats = Awaited<ReturnType<import("./session").Session["finish"]>>;
export type ArmRun = { stats: ArmStats; notes: string[] };

export type ScenarioOut = {
  name: string;
  question: string;
  expect: string;
  decisions: Partial<Record<Metric, Decision>>;
  controlMeans: Partial<Record<Metric, number>>;
  treatmentMeans: Partial<Record<Metric, number>>;
  violations: string[];
  notes: string[];
  ok: boolean;
};

export type ScenarioDef = {
  name: string;
  question: string;
  expect: string;
  tasks: string[];
  repeats: number;
  run: (arm: "raw" | "eden", task: string, repeat: number) => Promise<ArmRun>;
  /** Same-arm duplicate pair for the A/A self-check; omit to skip. */
  aa?: (which: "a" | "b", task: string, repeat: number) => Promise<ArmRun>;
};

export async function runScenario(def: ScenarioDef): Promise<ScenarioOut> {
  const cells = runPlan({ tasks: def.tasks, arms: ["control", "treatment"], repeats: def.repeats });
  const samples: Record<Metric, { control: Sample[]; treatment: Sample[] }> = {
    turns: { control: [], treatment: [] },
    wall_ms: { control: [], treatment: [] },
    cents: { control: [], treatment: [] },
  };
  const violations = new Set<string>();
  const notes: string[] = [];
  let i = 0;
  for (const cell of cells) {
    const r =
      cell.arm === "control"
        ? await def.run("raw", cell.task, cell.repeat)
        : await def.run("eden", cell.task, cell.repeat);
    for (const v of r.stats.violations) violations.add(v);
    for (const n of r.notes) notes.push(n);
    for (const m of METRICS) {
      samples[m][cell.arm === "control" ? "control" : "treatment"].push({
        task: cell.task,
        repeat: cell.repeat,
        value: r.stats[m],
      });
    }
    if (++i % 6 === 0) console.log(`  [${def.name}] ${i}/${cells.length} cells`);
  }

  let aaSamples: Record<Metric, { a: Sample[]; b: Sample[] }> | undefined;
  if (def.aa) {
    aaSamples = { turns: { a: [], b: [] }, wall_ms: { a: [], b: [] }, cents: { a: [], b: [] } };
    for (let repeat = 0; repeat < Math.min(def.repeats, FAST ? 1 : 3); repeat++) {
      for (const task of def.tasks) {
        const ra = await def.aa("a", task, repeat);
        const rb = await def.aa("b", task, repeat);
        for (const m of METRICS) {
          aaSamples[m].a.push({ task, repeat, value: ra.stats[m] });
          aaSamples[m].b.push({ task, repeat, value: rb.stats[m] });
        }
      }
    }
  }

  const decisions: Partial<Record<Metric, Decision>> = {};
  const controlMeans: Partial<Record<Metric, number>> = {};
  const treatmentMeans: Partial<Record<Metric, number>> = {};
  let ok = violations.size === 0;
  for (const m of METRICS) {
    const d = decide({
      treatment: samples[m].treatment,
      control: samples[m].control,
      nullControl: aaSamples ? aaSamples[m] : undefined,
      higherIsBetter: false,
    });
    decisions[m] = d;
    controlMeans[m] = d.controlMean;
    treatmentMeans[m] = d.treatmentMean;
    if (d.verdict === "LOSS") ok = false;
    if (d.selfCheck && !d.selfCheck.passed) {
      notes.push(`A/A ${d.selfCheck.status} on ${m} (relative MDE ${(d.selfCheck.relativeMde * 100).toFixed(1)}%)`);
      if (d.selfCheck.status === "biased") ok = false;
    }
  }
  return {
    name: def.name,
    question: def.question,
    expect: def.expect,
    decisions,
    controlMeans,
    treatmentMeans,
    violations: [...violations],
    notes: dedupe(notes),
    ok,
  };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function summarize(
  outs: ScenarioOut[],
  opts: {
    /** Losses worse than this percentage fail the run; smaller ones
     * are reported as measured overhead. Default 0 (any loss fails) —
     * negative-control campaigns pass ~1 since their success criterion is
     * parity, and their deterministic sign tests otherwise flag the
     * ~35µs/call recording cost as soon as machine jitter runs low. */ lossTolerancePct?: number;
  } = {},
) {
  const tol = (opts.lossTolerancePct ?? 0) / 100;
  console.log("\n==================== CAMPAIGN SUMMARY ====================");
  let failures = 0;
  let subMaterial = false;
  for (const o of outs) {
    console.log(`\n■ ${o.name} — ${o.question}`);
    console.log(`  expected: ${o.expect}`);
    for (const m of METRICS) {
      const d = o.decisions[m];
      if (!d) continue;
      const rel = ((d.delta.point / (d.controlMean || 1)) * 100).toFixed(1);
      const ratio = (d.controlMean / (d.treatmentMean || 1)).toFixed(2);
      const mdeStr =
        Number.isFinite(d.mde) && d.controlMean > 0
          ? ` mde=${d.mde.toFixed(1)} (${((d.mde / d.controlMean) * 100).toFixed(1)}% of ctrl)`
          : Number.isFinite(d.mde)
            ? ` mde=${d.mde.toFixed(1)}`
            : "";
      console.log(
        `  ${m.padEnd(8)} ${d.verdict.padEnd(18)} ctrl=${d.controlMean.toFixed(1)} ` +
          `trt=${d.treatmentMean.toFixed(1)} Δ=${rel}% (${ratio}x) p=${d.p.toFixed(4)} n=${d.blocks}` +
          mdeStr +
          (d.selfCheck ? ` A/A=${d.selfCheck.status}` : ""),
      );
    }
    if (o.violations.length) {
      failures++;
      console.log(`  CORRECTNESS VIOLATIONS:`);
      for (const v of o.violations) console.log(`    - ${v}`);
    }
    // A LOSS inside the materiality band is overhead, not a defect: print it,
    // count it as clean. Anything beyond the band fails.
    const materialLoss = METRICS.some((m) => {
      const d = o.decisions[m];
      return d?.verdict === "LOSS" && d.controlMean > 0 && d.delta.point / d.controlMean < -tol;
    });
    if (materialLoss) failures++;
    else if (!o.ok && !o.violations.length) {
      subMaterial = true;
      console.log("  (sub-material losses only — recorded as measured overhead)");
    }
    for (const n of o.notes.slice(0, 6)) console.log(`  note: ${n}`);
  }
  console.log("\n==========================================================");
  const okLine = subMaterial
    ? "CAMPAIGN OK — no material losses, no violations"
    : "CAMPAIGN OK — no losses, no violations";
  console.log(failures === 0 ? okLine : `CAMPAIGN FAILURES: ${failures} scenario(s) not clean`);
  process.exitCode = failures === 0 ? 0 : 1;
}
