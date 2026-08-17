/**
 * Re-reads Eden's committed benchmark results and reports what they actually
 * support.
 *
 * Every one of these files was produced with n=1 per cell and no seed, and each
 * carries a `totals` block that sums wall-clock across tasks — a summary that
 * cannot express uncertainty and therefore always looks decisive. This walks the
 * per-task rows instead, treats each task as a paired block, and prints the
 * interval next to the point estimate.
 *
 * Task 1 is special and is used as a free A/A cell: the harnesses pass
 * `mcp: i > 0`, so on the first task the treatment arm has an empty MCP config
 * and is configured identically to control apart from the hook file. Any
 * difference measured there is instrument noise by construction, so it is the
 * honest yardstick for every other cell in the same run.
 *
 *   bun run packages/measure/src/analyze.ts [files...]
 */
import { basename } from "node:path";
import { decide, type Sample } from "./verdict";
import { formatDecision } from "./report";
import { mean, stdev } from "./stats";

type Arm = { wall_ms?: number; cost_usd?: number; tool_calls?: number; mcp_calls?: number };
type Scored = { id: string; without?: Arm; with?: Arm; quality?: unknown };
type Results = { scored?: Scored[]; totals?: Record<string, Arm>; protocol?: Record<string, unknown> };

/** Task 1 runs with no Eden MCP on either arm, so it measures only noise. */
export function isPlaceboTask(id: string): boolean {
  return /^t1[-_]/.test(id) || id === "t1";
}

export type Extracted = {
  file: string;
  control: Sample[];
  treatment: Sample[];
  placeboControl: Sample[];
  placeboTreatment: Sample[];
};

export function extract(file: string, json: Results, metric: keyof Arm = "wall_ms"): Extracted {
  const control: Sample[] = [];
  const treatment: Sample[] = [];
  const placeboControl: Sample[] = [];
  const placeboTreatment: Sample[] = [];
  for (const row of json.scored ?? []) {
    const c = row.without?.[metric];
    const t = row.with?.[metric];
    if (typeof c !== "number" || typeof t !== "number") continue;
    const sample = { task: row.id, repeat: 0 };
    if (isPlaceboTask(row.id)) {
      placeboControl.push({ ...sample, value: c });
      placeboTreatment.push({ ...sample, value: t });
    } else {
      control.push({ ...sample, value: c });
      treatment.push({ ...sample, value: t });
    }
  }
  return { file, control, treatment, placeboControl, placeboTreatment };
}

/**
 * Pools the placebo cells from every supplied run into one A/A sample.
 *
 * Individually each file has a single placebo task, which is far too few to say
 * anything. Across the whole corpus they form a usable estimate of the noise
 * floor — and that estimate is what the per-file verdicts are then judged
 * against.
 */
export function poolPlacebo(all: Extracted[]): { a: Sample[]; b: Sample[] } {
  const a: Sample[] = [];
  const b: Sample[] = [];
  all.forEach((e, i) => {
    e.placeboControl.forEach((s, j) => a.push({ task: `${e.file}:${s.task}`, repeat: j + i * 100, value: s.value }));
    e.placeboTreatment.forEach((s, j) => b.push({ task: `${e.file}:${s.task}`, repeat: j + i * 100, value: s.value }));
  });
  return { a, b };
}

export function analyze(files: Array<{ path: string; json: Results }>, metric: keyof Arm = "wall_ms"): string {
  const extracted = files.map((f) => extract(basename(f.path), f.json, metric));
  const placebo = poolPlacebo(extracted);
  const lines: string[] = [];

  lines.push(`# Eden benchmark re-analysis — metric: ${metric}`);
  lines.push("");
  lines.push("Each task is one paired block. Task 1 is excluded from the A/B and pooled");
  lines.push("into the A/A noise estimate, because both arms run without Eden's MCP there.");
  lines.push("");

  const placeboDeltas = placebo.a.map((s, i) => (placebo.b[i]?.value ?? 0) - s.value);
  if (placeboDeltas.length >= 2) {
    const rel = placebo.a.map((s, i) => ((placebo.b[i]?.value ?? 0) - s.value) / (s.value || 1));
    lines.push(`## Noise floor (A/A: treatment arm with Eden disabled, n=${placeboDeltas.length})`);
    lines.push(`  mean delta   ${mean(placeboDeltas).toFixed(0)} ${metric}   sd ${stdev(placeboDeltas).toFixed(0)}`);
    lines.push(
      `  mean relative ${(mean(rel) * 100).toFixed(1)}%   sd ${(stdev(rel) * 100).toFixed(1)} percentage points`,
    );
    lines.push(
      `  -> any per-run claim smaller than roughly ${(stdev(rel) * 100).toFixed(0)}% is inside the noise.`,
    );
    lines.push("");
  }

  lines.push("## Per-run verdicts");
  lines.push("");
  for (const e of extracted) {
    if (!e.control.length) {
      lines.push(`NO DATA  ${e.file} (no non-placebo tasks with ${metric})`);
      lines.push("");
      continue;
    }
    const d = decide({
      treatment: e.treatment,
      control: e.control,
      nullControl: placebo,
      higherIsBetter: false,
    });
    lines.push(formatDecision(e.file, d, metric === "cost_usd" ? " usd" : "ms"));
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const metricArg = args.find((a) => a.startsWith("--metric="));
  const metric = (metricArg?.split("=")[1] ?? "wall_ms") as keyof Arm;
  const paths = args.filter((a) => !a.startsWith("--"));
  if (!paths.length) {
    console.error("usage: bun run packages/measure/src/analyze.ts [--metric=wall_ms|cost_usd] <results.json...>");
    process.exit(2);
  }
  const files = await Promise.all(
    paths.map(async (path) => ({ path, json: (await Bun.file(path).json()) as Results })),
  );
  console.log(analyze(files, metric));
}
