/**
 * Test support, not part of the gate: the crafted-input sweep of redos.test.ts and redos-{1,2,3}.test.ts. The sweep
 * takes about 6 s, so it is split by rule index over four files that a parallel test run (`scripts/test.sh`) runs at
 * once; together they cover every rule (rule i is in shard i % SHARDS). Not exported from index.ts.
 */
import { RE2_RULES, secretRules } from "./secrets";

export const SHARDS = 4;

// A reduced form of the search that found RE2_RULES: each rule's first keyword, then runs of characters its classes
// take, at 8 KB. Measured once: the rules left on JavaScript took at most 13 ms here, while with every rule on
// JavaScript the seven slow ones took 81–755 ms (curl-*: ~80 ms; sumologic-, okta-, cohere-: 560–760 ms). So a
// gitleaks update that adds a backtracking rule fails here; the ceiling leaves room for a GC pause.
const UNITS = ["a", "0", "f", "-", ".", "_", " ", "=", "/", ":", "\n", "'", "@", "a-", "a.", "a ", "x-", "AKIA"];
export const CEILING_MS = 40;
const SIZE = 8_192;

/** The rules on JavaScript's engine (every gitleaks rule outside RE2_RULES, and every Eden rule) in shard `shard`. */
export function shardRules(shard: number) {
  return secretRules()
    .filter((rule) => !RE2_RULES.has(rule.id))
    .filter((_, i) => i % SHARDS === shard);
}

/** The crafted inputs on which a rule of shard `shard` took over CEILING_MS, best of three; empty when none did. */
export function slowOn(shard: number): string[] {
  const slow: string[] = [];
  for (const rule of shardRules(shard)) {
    const word = rule.keywords[0] ?? rule.prefilter[0] ?? "";
    for (const unit of UNITS) {
      const run = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
      const pairs = `${word}${unit}`.repeat(Math.ceil(SIZE / (word.length + unit.length)));
      for (const text of [`${word}=${run}!`, pairs, run + word]) {
        // Best of up to three: a backtracking rule is slow every time, a GC pause only once (the suite shares a
        // process with tests that build large heaps).
        let ms = Infinity;
        for (let attempt = 0; attempt < 3 && ms > CEILING_MS; attempt++) {
          const t0 = performance.now();
          rule.spans(text);
          ms = Math.min(ms, performance.now() - t0);
        }
        if (ms > CEILING_MS) slow.push(`${rule.id} on ${JSON.stringify(text.slice(0, 24))}…: ${ms.toFixed(0)} ms`);
      }
    }
  }
  return slow;
}
