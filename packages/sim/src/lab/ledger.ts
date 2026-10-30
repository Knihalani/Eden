/**
 * The benchmark ledger (bench/README.md): every benchmark run appends one summary line to `bench/ledger.jsonl` and
 * writes its per-task rows to `bench/runs/<id>.jsonl.gz`, with the commit and config it ran on. The ledger is the
 * project's measured history: a change is judged against it (`bench-compare.ts`), not against memory.
 *
 * Only simulated data goes here: worlds are generated, never a real user's sources.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BENCH_DIR = join(import.meta.dir, "..", "..", "..", "..", "bench");

export interface LedgerEntry {
  id: string;
  at: string;
  /** The commit measured; `dirty` when the tree had uncommitted changes (the run then measured more than it). */
  commit: string;
  dirty: boolean;
  /** "funnel" (engine only, free), "sim" (simulation quality, free), "eval" (scenarios), "agent" (live agent A/B). */
  tier: string;
  suite: string;
  /** A short name for what was compared ("baseline", "probes"): runs with the same label line up in comparisons. */
  label: string;
  config: Record<string, unknown>;
  seeds: number[];
  models?: Record<string, string>;
  costUsd: number;
  wallSeconds: number;
  /** Flat summary metrics: name → number. */
  metrics: Record<string, number>;
  /** Rows written to `runs/<id>.jsonl.gz`. */
  rows: number;
  note?: string;
}

const git = (...a: string[]) => {
  const p = Bun.spawnSync(["git", ...a], { cwd: BENCH_DIR, stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : "";
};

/** Appends a run to the ledger, with its per-task rows; returns the entry. */
export function record(
  entry: Omit<LedgerEntry, "id" | "at" | "commit" | "dirty" | "rows">,
  rows: Record<string, unknown>[],
): LedgerEntry {
  mkdirSync(join(BENCH_DIR, "runs"), { recursive: true });
  const at = new Date().toISOString();
  // BENCH_COMMIT records a run made earlier, on another commit (a backfill): its own commit, never the current one.
  const commit = process.env.BENCH_COMMIT || git("rev-parse", "--short=10", "HEAD") || "unknown";
  // Changes outside bench/ only: the ledger itself changes with every run.
  const dirty = process.env.BENCH_COMMIT
    ? false
    : git("status", "--porcelain", "--", ".", ":(exclude)bench").length > 0;
  const id = `${at.slice(0, 19).replace(/[-:T]/g, "")}-${entry.tier}-${entry.suite}-${entry.label}`.replace(
    /[^\w.-]/g,
    "_",
  );
  const full: LedgerEntry = { id, at, commit, dirty, ...entry, rows: rows.length };
  if (rows.length) {
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(join(BENCH_DIR, "runs", `${id}.jsonl.gz`), Bun.gzipSync(Buffer.from(body)));
  }
  appendFileSync(join(BENCH_DIR, "ledger.jsonl"), JSON.stringify(full) + "\n");
  return full;
}

/** Rounds every number in a metrics object to 4 significant decimals, for a ledger a person can read. */
export const tidy = (m: Record<string, number>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Number.isFinite(v) ? Number(v.toFixed(4)) : v]));
