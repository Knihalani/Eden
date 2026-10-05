/**
 * Deals the test files out to CI's parallel test jobs by their measured times.
 *
 * `bun test --shard=k/N` deals files in path order (file i to slice i mod N). Where
 * the slow files land then depends on their names, and each new test file moves
 * every file after it: in the run after P0.0c, one slice took 270 s and another
 * 74 s. This deals the slowest file first, each to the slice with the least time
 * so far, by the seconds in scripts/test-times.txt. A file the table leaves out
 * counts as UNLISTED_SECONDS.
 *
 * scripts/test.sh runs slice k by ignoring the files dealt to the other slices, so
 * bun still finds the suite itself: a test file missing from this script's input
 * runs in every slice rather than in none.
 *
 * Usage:
 *   bun scripts/test-shard.ts k/N < files    slice k's ignore patterns, one per line
 *   bun scripts/test-shard.ts --times LOG    a new times table from `gh run view <run> --log`
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Shard = { k: number; n: number };

/** The table lists only files that take at least this long; the rest barely move the balance. */
export const MIN_LISTED_SECONDS = 2;
/** What an unlisted file counts as: the mean of the files under MIN_LISTED_SECONDS in CI. */
export const UNLISTED_SECONDS = 0.1;
export const TIMES_PATH = join(import.meta.dir, "test-times.txt");

const TIMES_HEADER = [
  `# Seconds per test file in CI's test jobs, for scripts/test-shard.ts. Files under ${MIN_LISTED_SECONDS} s are left out`,
  `# and count as ${UNLISTED_SECONDS} s each. Refresh it after adding or speeding up a slow test file:`,
  "#   gh run view <run> --log > /tmp/run.log && bun scripts/test-shard.ts --times /tmp/run.log > scripts/test-times.txt",
];
const USAGE = "usage: bun scripts/test-shard.ts k/N < files | --times LOG";

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function parseShard(spec: string): Shard {
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  const k = Number(m?.[1]);
  const n = Number(m?.[2]);
  if (!m || k < 1 || k > n) throw new Error(`a shard looks like k/N with 1 <= k <= N, got: ${spec}`);
  return { k, n };
}

/** The times table: one `<seconds> <path>` line per file; lines starting with `#` are comments. */
export function readTimes(text: string): Map<string, number> {
  const times = new Map<string, number>();
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\d+(?:\.\d+)?) (\S+)$/.exec(line);
    if (!m) throw new Error(`test-times.txt line ${i + 1} is not "<seconds> <path>": ${raw}`);
    times.set(m[2]!, Number(m[1]));
  }
  return times;
}

/**
 * The pattern that makes bun ignore `file` and nothing else. bun reads each
 * --path-ignore-patterns as a glob, so a Next.js route such as `[id]` would match
 * other paths; escaped, its characters are literal. test.sh splits the patterns on
 * whitespace, so a path holding any is refused.
 */
export function ignorePattern(file: string): string {
  if (/\s/.test(file)) throw new Error(`a test path with whitespace cannot be sharded: ${JSON.stringify(file)}`);
  return file.replace(/[\\*?[\]{}!]/g, "\\$&");
}

/**
 * Longest processing time first: each file, slowest first, goes to the slice with the
 * least time so far (the first such slice on a tie). Files with equal times go in path
 * order, so every job deals the same slices whatever order it lists the files in.
 */
export function deal(files: Iterable<string>, times: Map<string, number>, n: number): string[][] {
  const seconds = (file: string) => times.get(file) ?? UNLISTED_SECONDS;
  const order = [...new Set(files)].sort((a, b) => seconds(b) - seconds(a) || byPath(a, b));
  const slices: string[][] = Array.from({ length: n }, () => []);
  const load = new Array<number>(n).fill(0);
  for (const file of order) {
    const i = load.indexOf(Math.min(...load));
    slices[i]!.push(file);
    load[i]! += seconds(file);
  }
  return slices;
}

/**
 * Seconds per test file in a CI run's log (`gh run view <run> --log`, one line per
 * `<job>\t<step>\t<timestamp> <text>`): from the line bun prints as it starts a file
 * to the line it prints as it starts the next file, or as it finishes the job's run.
 */
export function timesFromLog(log: string): Map<string, number> {
  const times = new Map<string, number>();
  const running = new Map<string, { file: string; at: number }>();
  for (const line of log.split("\n")) {
    const [job, , rest] = line.split("\t");
    const m = rest && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?)\d*Z (.*)$/.exec(rest);
    if (!job || !m) continue;
    const at = Date.parse(`${m[1]}Z`);
    const start = /^(?:##\[group\])?(\S+\.test\.tsx?):$/.exec(m[2]!);
    if (!start && !/^Ran \d+ tests? across \d+ files?\./.test(m[2]!)) continue;
    const previous = running.get(job);
    if (previous) times.set(previous.file, (at - previous.at) / 1000);
    if (start) running.set(job, { file: start[1]!, at });
    else running.delete(job);
  }
  return times;
}

export function formatTimes(times: Map<string, number>): string {
  const rows = [...times]
    .filter(([, seconds]) => seconds >= MIN_LISTED_SECONDS)
    .sort(([a, x], [b, y]) => y - x || byPath(a, b))
    .map(([file, seconds]) => `${seconds.toFixed(1)} ${file}`);
  return [...TIMES_HEADER, ...rows].join("\n") + "\n";
}

async function main(args: string[]): Promise<void> {
  if (args[0] === "--times") {
    if (args.length !== 2) throw new Error(USAGE);
    process.stdout.write(formatTimes(timesFromLog(readFileSync(args[1]!, "utf8"))));
    return;
  }
  if (args.length !== 1) throw new Error(USAGE);
  const { k, n } = parseShard(args[0]!);
  const times = readTimes(readFileSync(TIMES_PATH, "utf8"));
  const lines = (await Bun.stdin.text()).split("\n").map((line) => line.trim());
  const slices = deal(lines.filter(Boolean), times, n);
  const mine = slices[k - 1]!;
  const seconds = mine.reduce((sum, file) => sum + (times.get(file) ?? UNLISTED_SECONDS), 0);
  console.error(
    `test slice ${k}/${n}: ${mine.length} files dealt, about ${Math.round(seconds)} s by scripts/test-times.txt`,
  );
  const others = slices.filter((_, i) => i !== k - 1).flat();
  if (others.length > 0) process.stdout.write(others.sort(byPath).map(ignorePattern).join("\n") + "\n");
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
