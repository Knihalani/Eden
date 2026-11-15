/**
 * Test support, not part of the gate: the crafted-input sweep of redos.test.ts and redos-{1,2,3}.test.ts. The sweep
 * takes about 6 s, so it is split by rule index over four files that a parallel test run (`scripts/test.sh`) runs at
 * once; together they cover every rule (rule i is in shard i % SHARDS). Not exported from index.ts.
 */
import { LINEAR_RULES, secretRules, type SecretRule } from "./secrets.ts";

export const SHARDS = 4;

// A reduced form of the search that found LINEAR_RULES: each rule's first keyword, then runs of characters its classes
// take, at 8 KB. Measured once: the rules left on JavaScript took at most 13 ms here, while with every rule on
// JavaScript the seven slow ones took 81–755 ms (curl-*: ~80 ms; sumologic-, okta-, cohere-: 560–760 ms). So a
// gitleaks update that adds a backtracking rule fails here; the ceiling leaves room for a GC pause.
const UNITS = ["a", "0", "f", "-", ".", "_", " ", "=", "/", ":", "\n", "'", "@", "a-", "a.", "a ", "x-", "AKIA"];
export const CEILING_MS = 40;
const SIZE = 8_192;

/** The rules on JavaScript's engine (each gitleaks rule outside LINEAR_RULES, and each Eden rule) in shard `shard`. */
export function shardRules(shard: number): SecretRule[] {
  return secretRules()
    .filter((rule) => !LINEAR_RULES.has(rule.id))
    .filter((_, i) => i % SHARDS === shard);
}

/**
 * What one run of `fn` cost, in ms: the lesser of its wall time and the process's CPU time over it. A backtracking
 * regex is single-threaded CPU work, so it is slow on both clocks. Contention (the four sweep files and the rest of a
 * parallel run sharing the cores) inflates only the wall clock; a GC helper thread inflates only the CPU clock.
 */
export function costMs(fn: () => void): number {
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  fn();
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(c0);
  return Math.min(wall, (cpu.user + cpu.system) / 1_000);
}

/** A rule's crafted inputs: its first keyword beside 8 KB runs of each unit, three ways. */
export function* craftedInputs(rule: SecretRule): Generator<string> {
  const word = rule.keywords[0] ?? rule.prefilter[0] ?? "";
  for (const unit of UNITS) {
    const run = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
    const pairs = `${word}${unit}`.repeat(Math.ceil(SIZE / (word.length + unit.length)));
    yield* [`${word}=${run}!`, pairs, run + word];
  }
}

/** The crafted inputs on which a rule (default: shard `shard`'s) took over CEILING_MS, best of three. */
export function slowOn(shard: number, rules: SecretRule[] = shardRules(shard)): string[] {
  const slow: string[] = [];
  for (const rule of rules) {
    for (const text of craftedInputs(rule)) {
      // Best of up to three: a backtracking rule is slow every time, a GC pause only once (the suite shares a
      // process with tests that build large heaps).
      let ms = Infinity;
      for (let attempt = 0; attempt < 3 && ms > CEILING_MS; attempt++) {
        ms = Math.min(
          ms,
          costMs(() => rule.spans(text)),
        );
      }
      if (ms > CEILING_MS) slow.push(`${rule.id} on ${JSON.stringify(text.slice(0, 24))}…: ${ms.toFixed(0)} ms`);
    }
  }
  return slow;
}
