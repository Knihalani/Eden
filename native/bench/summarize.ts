/**
 * Summarises several `run-all.sh <dir>` runs: for every row of one benchmark's tables, the mean and p50 of each
 * run and the median across runs. Usage: `bun bench/summarize.ts <bench> <dir> <dir> <dir> [row regex]`, where
 * <bench> is a file name without `.md` (e.g. `tokenize-bun`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [bench, ...rest] = process.argv.slice(2);
const dirs = rest.filter((arg) => !arg.startsWith("^") && !arg.startsWith("/^"));
const filter = new RegExp(rest.find((arg) => arg.startsWith("^")) ?? ".");
if (!bench || dirs.length < 2) {
  console.error("usage: bun bench/summarize.ts <bench> <dir> <dir> [<dir>...] [^row regex]");
  process.exit(2);
}

interface Row {
  mean: number;
  p50: number;
}

/** Rows of every table in a run's file, keyed by the case name (the first cell). */
function parse(dir: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const line of readFileSync(join(dir, `${bench}.md`), "utf8").split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length > 5 && cells[2] !== "" && !Number.isNaN(Number(cells[2]))) {
      rows.set(cells[1]!, { mean: Number(cells[2]), p50: Number(cells[3]) });
    }
  }
  return rows;
}

const runs = dirs.map(parse);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
console.log(`| case | mean per run | median mean | p50 per run | median p50 |`);
console.log(`|---|---|---:|---|---:|`);
for (const key of runs[0]!.keys()) {
  if (!filter.test(key)) continue;
  const rows = runs.map((run) => run.get(key));
  if (rows.some((row) => !row)) continue;
  const means = rows.map((row) => row!.mean);
  const p50s = rows.map((row) => row!.p50);
  console.log(`| ${key} | ${means.join(" / ")} | ${median(means)} | ${p50s.join(" / ")} | ${median(p50s)} |`);
}
