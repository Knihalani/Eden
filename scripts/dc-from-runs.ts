#!/usr/bin/env bun
/**
 * Independent DC% reproduction from raw run JSONL.
 *
 * Usage: bun scripts/dc-from-runs.ts <jsonl>
 *
 * Each line is a run:
 *   { workspace, day, compiled, memoized, transparent, steeredSkip, frontier, providerCache? }
 *   or the same with nested `classes`.
 *
 * Prints one line per workspace+day:
 *   workspace day dcPct billed det frontier {json}
 *
 * Arithmetic is aggregateDc() — providerCache is never blended into DC%.
 * No network. Deterministic.
 */
import { aggregateDc, formatDcLine, parseDcJsonl } from "../packages/measure/src/dc-day";

const path = process.argv[2];
if (!path || path === "-h" || path === "--help") {
  console.error("usage: bun scripts/dc-from-runs.ts <jsonl>");
  process.exit(path ? 0 : 1);
}

const file = Bun.file(path);
if (!(await file.exists())) {
  console.error(`dc-from-runs: not found: ${path}`);
  process.exit(1);
}

const runs = parseDcJsonl(await file.text());
for (const row of aggregateDc(runs)) {
  console.log(formatDcLine(row));
}
